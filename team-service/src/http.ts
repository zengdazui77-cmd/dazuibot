import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { bearer } from "./crypto.js";
import type { Config } from "./config.js";
import { HttpError, type Principal } from "./model.js";
import { TeamService } from "./service.js";
import { Store } from "./store.js";
import { TeamEventHub } from "./events.js";
import { verifyExecutorSignature } from "./code-executor.js";
import { teamWebPage } from "./web-page.js";

const BODY_LIMIT = 64 * 1024;
const CODE_TASK_MODEL_BODY_LIMIT = 1_000_000;
const CODE_TASK_MODEL_RESPONSE_LIMIT = 10 * 1024 * 1024;

async function body(req: IncomingMessage, limit = BODY_LIMIT): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += part.length;
    if (length > limit) throw new HttpError(413, "Request body is too large");
    chunks.push(part);
  }
  if (!length) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Request body must be a JSON object");
  }
}

async function relayModelResponse(res: ServerResponse, upstream: Response): Promise<void> {
  const advertised = Number(upstream.headers.get("content-length") ?? 0);
  if (advertised > CODE_TASK_MODEL_RESPONSE_LIMIT) {
    await upstream.body?.cancel().catch(() => undefined);
    throw new HttpError(502, "The team model response exceeds the 10 MiB task limit");
  }
  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const responseHeaders: Record<string, string> = {
    "content-type": contentType.startsWith("application/json") || contentType.startsWith("text/event-stream") ? contentType : "application/octet-stream",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  if (contentType.startsWith("text/event-stream")) responseHeaders["x-accel-buffering"] = "no";
  res.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) { res.end(); return; }
  const reader = upstream.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > CODE_TASK_MODEL_RESPONSE_LIMIT) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(502, "The team model response exceeds the 10 MiB task limit");
      }
      if (!res.write(Buffer.from(part.value))) await new Promise<void>((resolve) => res.once("drain", resolve));
    }
    res.end();
  } finally {
    reader.releaseLock();
  }
}

function send(res: ServerResponse, status: number, value: unknown): void {
  const json = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

function executorCapability(req: IncomingMessage): string {
  const value = req.headers["x-executor-capability"];
  if (typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value)) return value;
  const auth = req.headers.authorization;
  const match = typeof auth === "string" ? /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(auth) : undefined;
  return match?.[1] ?? "";
}

function sendInvitationPage(res: ServerResponse, token: string): void {
  const nonce = randomBytes(18).toString("base64");
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>加入大嘴助手团队</title>
  <meta name="referrer" content="no-referrer"><style>body{font:16px/1.6 system-ui,sans-serif;max-width:600px;margin:12vh auto;padding:24px;color:#222}main{border-radius:16px;padding:28px;background:#f5f5f3}h1{font-size:24px}p{color:#555}input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #aaa;border-radius:8px;font:14px ui-monospace,monospace}button,.open-app{display:inline-block;margin-top:14px;padding:10px 16px;border:0;border-radius:8px;background:#232323;color:white;font:inherit;text-decoration:none}</style>
  <main><h1>加入大嘴助手团队</h1><p>点击下方按钮可在桌面 App 中打开邀请；请先使用受邀邮箱登录，再确认加入团队。</p><a class="open-app" href="dazuibot://invite?token=${encodeURIComponent(token)}">在大嘴助手桌面 App 中打开</a><p>如果 App 没有自动打开，请复制邀请码并回到 App 的“团队空间”粘贴。</p><label for="invite-token">邀请令牌</label><input id="invite-token" readonly value="${token}"><button id="copy-token" type="button">复制邀请令牌</button><p id="copy-state" aria-live="polite"></p></main>
  <script nonce="${nonce}">document.getElementById('copy-token').addEventListener('click',async()=>{const i=document.getElementById('invite-token');try{await navigator.clipboard.writeText(i.value);document.getElementById('copy-state').textContent='已复制，请回到桌面 App 粘贴。'}catch{i.select();document.getElementById('copy-state').textContent='请按 Ctrl+C 复制，然后回到桌面 App 粘贴。'}})</script></html>`;
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  });
  res.end(html);
}

function segments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); }
    catch { throw new HttpError(400, "Malformed URL path"); }
  });
}

export function createTeamHttpServer(config: Config, store: Store, service: TeamService, events = new TeamEventHub()): Server {
  const server = createServer((req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("cache-control", "no-store");
    const origin = req.headers.origin;
    if (typeof origin === "string" && config.corsOrigins.has(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.setHeader("access-control-allow-headers", "authorization, content-type");
      res.setHeader("access-control-max-age", "600");
      res.setHeader("vary", "Origin");
    }
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return res.destroy();
      const known = error instanceof HttpError;
      const status = known ? error.status : 500;
      if (!known) console.error("team-api request failed", { method: req.method, path: safePath(req.url), error: error instanceof Error ? error.message.slice(0, 240) : "unknown" });
      send(res, status, { error: known ? error.message : "Internal server error" });
    });
  });

  async function principal(req: IncomingMessage): Promise<Principal> {
    return service.authenticate(bearer({ headers: req.headers }));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://team.local");
    const method = req.method ?? "GET";
    if (method === "OPTIONS") {
      if (!originAllowed(req.headers.origin, config)) throw new HttpError(403, "Origin is not allowed");
      res.writeHead(204).end();
      return;
    }
    if (method === "GET" && url.pathname === "/healthz") { send(res, 200, { ok: true }); return; }
    if (method === "GET" && url.pathname === "/readyz") {
      await store.pool.query("SELECT 1");
      send(res, 200, { ready: true });
      return;
    }
    if (method === "GET" && url.pathname === "/invite") {
      const token = url.searchParams.get("token") ?? "";
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new HttpError(400, "Invitation link is invalid or expired");
      sendInvitationPage(res, token);
      return;
    }
    // 团队空间的网页版：浏览器直接打开团队地址就能用（桌面端 App 仍是主入口）
    if (method === "GET" && (url.pathname === "/" || url.pathname === "/app" || url.pathname === "/web")) {
      const page = teamWebPage();
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(page.html),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${page.nonce}'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      res.end(page.html);
      return;
    }
    const path = segments(url.pathname);
    const isCodeTaskModelProxy = path[0] === "v1" && path[1] === "internal" && path[2] === "code-tasks" && path.length === 7 && path[4] === "model" && path[5] === "chat" && path[6] === "completions" && method === "POST";
    const b = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE" ? await body(req, isCodeTaskModelProxy ? CODE_TASK_MODEL_BODY_LIMIT : BODY_LIMIT) : {};
    if (path[0] === "v1" && path[1] === "internal" && path[2] === "code-tasks" && path.length === 5 && path[4] === "snapshot" && method === "GET") {
      const snapshot = await service.getCodeTaskSnapshot(path[3] ?? "", executorCapability(req));
      const bytes = Buffer.from(snapshot.archive);
      res.writeHead(200, {
        "content-type": snapshot.contentType,
        "content-length": String(bytes.byteLength),
        "content-disposition": 'attachment; filename="team-task-source.tar.gz"',
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(bytes);
      return;
    }
    if (isCodeTaskModelProxy) {
      const controller = new AbortController();
      req.on("aborted", () => controller.abort());
      res.on("close", () => { if (!res.writableEnded) controller.abort(); });
      const upstream = await service.proxyCodeTaskModel(path[3] ?? "", executorCapability(req), b, controller.signal);
      await relayModelResponse(res, upstream);
      return;
    }
    if (path[0] === "v1" && path[1] === "internal" && path[2] === "code-tasks" && path.length === 5 && (path[4] === "result" || path[4] === "heartbeat") && method === "POST") {
      const jobId = path[3] ?? "";
      const suppliedJobId = typeof req.headers["x-executor-job-id"] === "string" ? req.headers["x-executor-job-id"] : "";
      const signature = typeof req.headers["x-executor-signature"] === "string" ? req.headers["x-executor-signature"] : "";
      const signedByExecutor = Boolean(config.codeExecutorSecret && suppliedJobId === jobId && verifyExecutorSignature(config.codeExecutorSecret, jobId, b, signature));
      if (!signedByExecutor) await service.assertCodeTaskCapability(jobId, executorCapability(req));
      if (path[4] === "heartbeat") {
        send(res, 200, { state: await service.heartbeatCodeTask(jobId, b.sequence as number, b.sentAt as number) });
        return;
      }
      if (b.outcome !== "succeeded" && b.outcome !== "failed") throw new HttpError(400, "Executor outcome must be succeeded or failed");
      send(res, 200, { task: await service.completeCodeTask(jobId, b.outcome, b.result, b.error) });
      return;
    }
    if (path.join("/") === "v1/auth/codes" && method === "POST") {
      send(res, 202, await service.requestLoginCode(b.email));
      return;
    }
    if (path.join("/") === "v1/auth/sessions" && method === "POST") {
      send(res, 201, await service.createSession(b.email, b.code));
      return;
    }
    if (path.join("/") === "v1/auth/sessions/current" && method === "DELETE") {
      await service.revokeSession(bearer({ headers: req.headers }));
      send(res, 200, { ok: true });
      return;
    }
    if (path.join("/") === "v1/me" && method === "GET") {
      const p = await principal(req);
      send(res, 200, { user: { id: p.userId, email: p.email }, teams: await service.listTeams(p) });
      return;
    }
    if (path.join("/") === "v1/teams" && method === "GET") {
      send(res, 200, { teams: await service.listTeams(await principal(req)) });
      return;
    }
    if (path.join("/") === "v1/teams" && method === "POST") {
      send(res, 201, { team: await service.createTeam(await principal(req), b.name) });
      return;
    }
    if (path.join("/") === "v1/invitations/accept" && method === "POST") {
      send(res, 200, { team: await service.acceptInvitation(await principal(req), b.token) });
      return;
    }
    if (path[0] !== "v1" || path[1] !== "teams" || !path[2]) throw new HttpError(404, "Not found");
    const p = await principal(req);
    const teamId = path[2];
    if (path[3] === "conversations" && path.length === 6 && path[5] === "events" && method === "GET") {
      const conversationId = path[4] ?? "";
      await service.assertConversationAccess(p, teamId, conversationId);
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write(": connected\n\n");
      const checkAccess = async (): Promise<boolean> => {
        try {
          await service.assertConversationAccess(p, teamId, conversationId);
          return !res.destroyed && !res.writableEnded;
        } catch {
          if (!res.destroyed && !res.writableEnded) res.end();
          return false;
        }
      };
      const publish = () => {
        void checkAccess().then((allowed) => { if (allowed) res.write("event: update\ndata: {}\n\n"); });
      };
      const unsubscribe = events.subscribe(conversationId, publish);
      const heartbeat = setInterval(() => {
        void checkAccess().then((allowed) => { if (allowed) res.write(": keep-alive\n\n"); });
      }, 20_000);
      const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
      res.on("close", cleanup);
      return;
    }
    if (path.length === 3 && method === "GET") {
      const role = await service.requireMembership(p, teamId);
      const team = (await service.listTeams(p)).find((item) => item.id === teamId);
      if (!team) throw new HttpError(404, "Team not found");
      send(res, 200, { team: { ...team, role } });
      return;
    }
    if (path.length === 3 && method === "DELETE") {
      await service.deleteTeam(p, teamId, b.confirmName);
      send(res, 200, { ok: true });
      return;
    }
    if (path[3] === "model-config" && path.length === 4 && method === "GET") {
      send(res, 200, { modelConfig: await service.getModelConfig(p, teamId) });
      return;
    }
    if (path[3] === "model-config" && path.length === 4 && method === "PUT") {
      send(res, 200, { modelConfig: await service.saveModelConfig(p, teamId, b) });
      return;
    }
    if (path[3] === "model-config" && path.length === 4 && method === "DELETE") {
      await service.deleteModelConfig(p, teamId);
      send(res, 200, { ok: true });
      return;
    }
    // 团队模型授权策略：owner/admin 设置范围，成员在自己范围内自主选择模型
    if (path[3] === "model-policy" && path.length === 4 && method === "GET") {
      send(res, 200, { modelPolicy: await service.getModelPolicy(p, teamId) });
      return;
    }
    if (path[3] === "model-policy" && path.length === 4 && method === "PUT") {
      send(res, 200, { modelPolicy: await service.saveModelPolicy(p, teamId, b) });
      return;
    }
    if (path[3] === "model-policy" && path.length === 5 && path[4] === "model" && method === "PUT") {
      send(res, 200, { modelPolicy: await service.saveMemberModel(p, teamId, b.model) });
      return;
    }
    // 叠加限制层：多条规则，与基线授权一起生效（命中任一条即拒绝）
    if (path[3] === "model-policy-rules" && path.length === 4 && method === "GET") {
      send(res, 200, { rules: await service.listPolicyRules(p, teamId) });
      return;
    }
    if (path[3] === "model-policy-rules" && path.length === 4 && method === "POST") {
      send(res, 201, { rule: await service.createPolicyRule(p, teamId, b) });
      return;
    }
    // 批量启用/停用：PUT /model-policy-rules/enabled，body 里带 ruleIds
    if (path[3] === "model-policy-rules" && path.length === 5 && path[4] === "enabled" && method === "PUT") {
      await service.setPolicyRulesEnabled(p, teamId, Array.isArray(b.ruleIds) ? b.ruleIds : [], b.enabled === true);
      send(res, 200, { ok: true });
      return;
    }
    // 单条规则的启停：PUT /model-policy-rules/:ruleId/enabled
    if (path[3] === "model-policy-rules" && path.length === 6 && path[5] === "enabled" && method === "PUT") {
      await service.setPolicyRulesEnabled(p, teamId, [path[4] ?? ""], b.enabled === true);
      send(res, 200, { ok: true });
      return;
    }
    if (path[3] === "model-policy-rules" && path.length === 5 && method === "GET") {
      send(res, 200, { rule: await service.getPolicyRule(p, teamId, path[4] ?? "") });
      return;
    }
    if (path[3] === "model-policy-rules" && path.length === 5 && method === "PUT") {
      send(res, 200, { rule: await service.updatePolicyRule(p, teamId, path[4] ?? "", b) });
      return;
    }
    if (path[3] === "model-policy-rules" && path.length === 5 && method === "DELETE") {
      await service.deletePolicyRule(p, teamId, path[4] ?? "");
      send(res, 200, { ok: true });
      return;
    }
    if (path[3] === "model-policy-violations" && path.length === 4 && method === "GET") {
      send(res, 200, { violations: await service.listPolicyViolations(p, teamId) });
      return;
    }
    // 策略告警与策略用量指标
    if (path[3] === "model-policy-alerts" && path.length === 4 && method === "GET") {
      send(res, 200, { alerts: await service.listPolicyAlerts(p, teamId) });
      return;
    }
    if (path[3] === "model-policy-metrics" && path.length === 4 && method === "GET") {
      const period = url.searchParams.get("period") === "day" ? "day" : "hour";
      send(res, 200, { metrics: await service.getPolicyUsageMetrics(p, teamId, period) });
      return;
    }
    // 策略模板：可直接套用的规则模板，团队内任何成员都可查看
    if (path[3] === "model-policy-templates" && path.length === 4 && method === "GET") {
      send(res, 200, { templates: service.listPolicyTemplates() });
      return;
    }
    if (path[3] === "usage" && path.length === 4 && method === "GET") {
      send(res, 200, { usage: await service.getUsage(p, teamId) });
      return;
    }
    if (path[3] === "audit" && path.length === 4 && method === "GET") {
      send(res, 200, { events: await service.listAuditEvents(p, teamId) });
      return;
    }
    if (path[3] === "git-credentials" && path.length === 4 && method === "GET") {
      send(res, 200, { credentials: await service.getGitCredentialStatus(p, teamId) });
      return;
    }
    if (path[3] === "git-credentials" && path.length === 5 && method === "PUT") {
      send(res, 200, { credentials: await service.saveGitCredential(p, teamId, path[4], b.token) });
      return;
    }
    if (path[3] === "git-credentials" && path.length === 5 && method === "DELETE") {
      await service.deleteGitCredential(p, teamId, path[4]);
      send(res, 200, { ok: true });
      return;
    }
    if (path[3] === "projects" && path.length === 4 && method === "GET") {
      send(res, 200, { projects: await service.listProjects(p, teamId) });
      return;
    }
    if (path[3] === "projects" && path.length === 4 && method === "POST") {
      send(res, 201, { project: await service.createProject(p, teamId, b) });
      return;
    }
    if (path[3] === "projects" && path.length === 5 && method === "GET") {
      send(res, 200, { project: await service.getProject(p, teamId, path[4] ?? "") });
      return;
    }
    if (path[3] === "projects" && path.length === 5 && method === "DELETE") {
      await service.deleteProject(p, teamId, path[4] ?? "");
      send(res, 200, { ok: true });
      return;
    }
    if (path[3] === "projects" && path.length === 6 && path[5] === "code-tasks" && method === "GET") {
      send(res, 200, { tasks: await service.listCodeTasks(p, teamId, path[4] ?? "") });
      return;
    }
    if (path[3] === "projects" && path.length === 6 && path[5] === "code-tasks" && method === "POST") {
      send(res, 201, { task: await service.createCodeTask(p, teamId, path[4] ?? "", b) });
      return;
    }
    if (path[3] === "projects" && path.length === 8 && path[5] === "code-tasks" && (path[7] === "approve" || path[7] === "reject") && method === "POST") {
      send(res, 200, { task: await service.decideCodeTask(p, teamId, path[4] ?? "", path[6] ?? "", path[7] as "approve" | "reject", b.reason) });
      return;
    }
    if (path[3] === "projects" && path.length === 8 && path[5] === "code-tasks" && path[7] === "cancel" && method === "POST") {
      send(res, 200, { task: await service.cancelCodeTask(p, teamId, path[4] ?? "", path[6] ?? "") });
      return;
    }
    if (path[3] === "projects" && path.length === 6 && path[5] === "reviews" && method === "POST") {
      send(res, 201, { review: await service.createProjectReview(p, teamId, path[4] ?? "", b) });
      return;
    }
    if (path[3] === "projects" && path.length === 6 && path[5] === "diff" && method === "GET") {
      send(res, 200, { comparison: await service.getProjectDiff(p, teamId, path[4] ?? "", url.searchParams.get("head")) });
      return;
    }
    if (path[3] === "bots" && path.length === 4 && method === "GET") {
      send(res, 200, { bots: await service.listBots(p, teamId) });
      return;
    }
    if (path[3] === "bots" && path.length === 4 && method === "POST") {
      send(res, 201, { bot: await service.createBot(p, teamId, b) });
      return;
    }
    if (path[3] === "conversations" && path.length === 4 && method === "GET") {
      send(res, 200, { conversations: await service.listConversations(p, teamId) });
      return;
    }
    if (path[3] === "conversations" && path.length === 4 && method === "POST") {
      send(res, 201, { conversation: await service.createConversation(p, teamId, b) });
      return;
    }
    if (path[3] === "conversations" && path.length === 6 && path[5] === "messages" && method === "GET") {
      const conversationId = path[4] ?? "";
      send(res, 200, { messages: await service.listMessages(p, teamId, conversationId), jobs: await service.listJobs(p, teamId, conversationId) });
      return;
    }
    if (path[3] === "conversations" && path.length === 6 && path[5] === "messages" && method === "POST") {
      const result = await service.postMessage(p, teamId, path[4] ?? "", b.content);
      events.publish(path[4] ?? "");
      send(res, 201, result);
      return;
    }
    if (path[3] === "members" && path.length === 4 && method === "GET") {
      send(res, 200, { members: await service.listMembers(p, teamId) });
      return;
    }
    if (path[3] === "members" && path.length === 5 && path[4] === "me" && method === "DELETE") {
      await service.leaveTeam(p, teamId);
      send(res, 200, { ok: true });
      return;
    }
    if (path[3] === "members" && path.length === 6 && path[5] === "role" && method === "PATCH") {
      send(res, 200, { member: await service.updateMemberRole(p, teamId, path[4] ?? "", b.role) });
      return;
    }
    if (path[3] === "members" && path.length === 5 && method === "DELETE") {
      await service.removeMember(p, teamId, path[4] ?? "");
      send(res, 200, { ok: true });
      return;
    }
    if (path[3] === "invitations" && path.length === 4 && method === "GET") {
      send(res, 200, { invitations: await service.listInvitations(p, teamId) });
      return;
    }
    if (path[3] === "invitations" && path.length === 4 && method === "POST") {
      send(res, 201, await service.createInvitation(p, teamId, b.email, b.role));
      return;
    }
    if (path[3] === "invitations" && path.length === 5 && method === "DELETE") {
      await service.revokeInvitation(p, teamId, path[4] ?? "");
      send(res, 200, { ok: true });
      return;
    }
    throw new HttpError(404, "Not found");
  }

  return server;
}

function originAllowed(origin: string | string[] | undefined, config: Config): boolean {
  return typeof origin !== "string" || config.corsOrigins.has(origin);
}

function safePath(raw: string | undefined): string {
  try {
    const path = new URL(raw ?? "/", "http://team.local").pathname;
    return path.slice(0, 180);
  } catch { return "/"; }
}
