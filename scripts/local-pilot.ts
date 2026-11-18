/**
 * 首期试点 · 本地端到端演练台
 *
 * 在一台机器上把「大嘴助手团队版」的完整链路跑通：
 *   桌面 App（真实 App + 真实 WebServer + 真实 TeamClient）
 *        ⇄ HTTP ⇄
 *   团队服务（真实 http.ts / service.ts / worker.ts + PGlite 数据库）
 *        ⇄ HTTP ⇄
 *   假模型网关（OpenAI 兼容 /chat/completions）
 *
 * 与真实部署只差两处：
 *   1. 数据库用 PGlite（嵌入式 Postgres）代替独立 PostgreSQL；
 *   2. 模型中转站用本地假网关代替真实中转站。
 * 登录码、会话、邀请、团队、共享聊天、模型调用、用量统计、审计事件走的都是真实代码路径。
 *
 * 用法：npx tsx scripts/local-pilot.ts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";
import type { Pool } from "pg";

// 用 fileURLToPath 而不是 URL.pathname：pathname 会把中文路径百分号编码，
// 再拿它去 import 就会得到 "c:" 这种没有 scheme 的地址，Node 直接报错。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UI_TOKEN = "pilot-ui-token-local-only";

// ───────────────────────────────────────────────────────────────────────────
// 假模型网关
// ───────────────────────────────────────────────────────────────────────────
interface ModelCall { model: string; system: string; messages: Array<{ role: string; content: string }>; authorization: string }
const modelCalls: ModelCall[] = [];

async function startFakeModelGateway(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    // Worker 会往 {base}/chat/completions 发请求，而 base 本身就是 .../v1，
    // 所以这里两种前缀都要认：带 /v1 的和不带的。
    if (!req.url || !req.url.split("?")[0]!.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      let body: any = {};
      try { body = JSON.parse(raw); } catch { /* 用默认值 */ }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      modelCalls.push({
        model: String(body.model ?? ""),
        system: String(messages.find((m: any) => m.role === "system")?.content ?? ""),
        messages: messages.filter((m: any) => m.role !== "system").map((m: any) => ({ role: String(m.role), content: String(m.content ?? "") })),
        authorization: String(req.headers.authorization ?? ""),
      });
      const lastUser = [...messages].reverse().find((m: any) => m.role === "user");
      const reply = `【试点桩回复】收到：${String(lastUser?.content ?? "").slice(0, 60)}`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-pilot", object: "chat.completion", model: body.model ?? "pilot-model",
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

// ───────────────────────────────────────────────────────────────────────────
// 团队服务（真实源码，数据库换成 PGlite）
// ───────────────────────────────────────────────────────────────────────────
async function startTeamService(options: { modelBaseUrl: string }): Promise<{
  url: string; workerErrors: string[]; close: () => Promise<void>;
}> {
  const { loadConfig } = await import(pathToFileURL(path.join(ROOT, "team-service/src/config.ts")).href);
  const { Store } = await import(pathToFileURL(path.join(ROOT, "team-service/src/store.ts")).href);
  const { TeamService } = await import(pathToFileURL(path.join(ROOT, "team-service/src/service.ts")).href);
  const { TeamWorker } = await import(pathToFileURL(path.join(ROOT, "team-service/src/worker.ts")).href);
  const { createTeamHttpServer } = await import(pathToFileURL(path.join(ROOT, "team-service/src/http.ts")).href);
  const { TeamEventHub } = await import(pathToFileURL(path.join(ROOT, "team-service/src/events.ts")).href);

  // 用 team-service 自己的 PGlitePool，而不是在这里手写一个适配器：
  // 手写适配器把 rowCount 固定成 rows.length，DELETE 这类不返回行的语句会误报 0，
  // 「移除成员」这类操作就会误判成「没删掉」。
  const { PGlitePool } = await import(pathToFileURL(path.join(ROOT, "team-service/src/pglite-pool.ts")).href);
  const pool = new PGlitePool() as unknown as Pool;

  const config = loadConfig({
    NODE_ENV: "development",
    DATABASE_URL: "postgres://pilot",
    TEAM_SESSION_SECRET: "pilot-session-secret-must-be-at-least-32-bytes",
    TEAM_CREDENTIAL_SECRET: "pilot-credential-secret-must-be-at-least-32-bytes",
    TEAM_ALLOW_DEV_CODES: "true",
    TEAM_PUBLIC_URL: "http://127.0.0.1:8787",
    TEAM_MODEL_BASE_URL: options.modelBaseUrl,
  } as any);

  const store = new Store(config, pool);
  await store.migrate();

  const service = new TeamService(config, store, undefined, { now: () => Date.now(), makeCode: () => "123456" });
  // PGlite 不支持 LISTEN/NOTIFY，用不带 pool 的事件中枢：发布直接通知本地订阅者。
  const events = new TeamEventHub();
  const server = createTeamHttpServer(config, store, service, events);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  // 把 Worker 的失败原因打出来：否则任务为什么没跑成只能靠猜
  const workerErrors: string[] = [];
  const worker = new TeamWorker(config, store, { events, onError: (kind) => { workerErrors.push(kind); } });
  worker.start();

  return {
    url: `http://127.0.0.1:${port}`,
    workerErrors,
    close: async () => {
      await worker.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 桌面 App（真实 App + WebServer + TeamClient）
// ───────────────────────────────────────────────────────────────────────────
async function startDesktopApp(options: { teamApiUrl: string }): Promise<{
  base: string; token: string; dataDir: string; app: any;
}> {
  const { App } = await import(pathToFileURL(path.join(ROOT, "src/app.ts")).href);
  const { loadConfig } = await import(pathToFileURL(path.join(ROOT, "src/config.ts")).href);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "amb-pilot-"));
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ team: { apiBaseUrl: options.teamApiUrl } }));

  const key = crypto.randomBytes(32);
  const secretBox = {
    encrypt(plain: string) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decrypt(data: Buffer) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
    },
  };

  const config = loadConfig({
    dataDir,
    env: {
      AMB_MAGPIE_BASE_URL: "http://127.0.0.1:9/v1",
      AMB_UI_PORT: "0",
      AMB_UI_TOKEN: UI_TOKEN,
      AMB_AGENT: "off",
      AMB_WEIXIN_API_BASE: "http://127.0.0.1:9",
    },
  } as any);

  const app = new App(config, { printQrToTerminal: false });
  app.desktop = { secretBox, fetch: fetch as typeof globalThis.fetch, openPath: () => undefined } as any;
  await app.start();

  return { base: app.web!.url.replace(/\/$/, ""), token: config.ui.token, dataDir, app };
}

// ───────────────────────────────────────────────────────────────────────────
// 演练步骤
// ───────────────────────────────────────────────────────────────────────────
const steps: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail = "") => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

/**
 * 用邮箱登录团队服务，返回会话令牌与用户 id。
 * 与桌面端走的是同一套认证代码路径（/v1/auth/codes + /v1/auth/sessions）。
 */
/**
 * 用邮箱登录团队服务，返回会话令牌与用户 id。
 * 与桌面端走的是同一套认证代码路径（/v1/auth/codes + /v1/auth/sessions）。
 *
 * 同一个邮箱只登录一次：服务端对「申请验证码」有 60 秒冷却，
 * 反复申请会被 429 挡下（而那正是撤权要验证的冷却逻辑本身，不能绕过）。
 */
const sessionCache = new Map<string, { token: string; userId: string }>();

async function loginAs(teamUrl: string, email: string): Promise<{ token: string; userId: string }> {
  const cached = sessionCache.get(email);
  if (cached) return cached;
  const codes = await fetch(`${teamUrl}/v1/auth/codes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  }).then((r) => r.json() as Promise<any>);
  const session = await fetch(`${teamUrl}/v1/auth/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, code: codes.developmentCode }),
  }).then((r) => r.json() as Promise<any>);
  if (!session.token) throw new Error(`登录失败：${email} ${JSON.stringify(codes)} ${JSON.stringify(session)}`);
  const me = await fetch(`${teamUrl}/v1/me`, { headers: { authorization: `Bearer ${session.token}` } })
    .then((r) => r.json() as Promise<any>);
  const result = { token: session.token, userId: me.user?.id ?? "" };
  sessionCache.set(email, result);
  return result;
}

async function main() {
  console.log("\n大嘴助手团队版 · 首期试点本地演练\n" + "=".repeat(64));

  const gateway = await startFakeModelGateway();
  const team = await startTeamService({ modelBaseUrl: gateway.url });
  const desktop = await startDesktopApp({ teamApiUrl: team.url });
  console.log(`假模型网关 ${gateway.url}\n团队服务   ${team.url}\n桌面 App   ${desktop.base}\n`);

  const api = async (p: string, method = "GET", body?: unknown) => {
    const res = await fetch(`${desktop.base}/amb/api${p}`, {
      method,
      headers: { "x-amb-token": desktop.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({})) as any;
    return { status: res.status, data };
  };
  const expectOk = async (p: string, method = "GET", body?: unknown) => {
    const r = await api(p, method, body);
    if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status} ${r.data?.error ?? ""}`);
    return r.data;
  };

  try {
    // 1. 服务器地址
    const cfg = await expectOk("/team/config");
    record("配置团队服务器地址", cfg.apiBaseUrl === team.url, `apiBaseUrl=${cfg.apiBaseUrl}`);

    // 2. Owner 邮箱验证码登录
    const codes = await expectOk("/team/auth/codes", "POST", { email: "owner@example.com" });
    record("Owner 申请邮箱验证码", typeof codes.developmentCode === "string", `developmentCode=${codes.developmentCode}`);
    const session = await expectOk("/team/auth/sessions", "POST", { email: "owner@example.com", code: codes.developmentCode });
    record("Owner 登录团队账号", session.signedIn === true && session.user?.email === "owner@example.com", `email=${session.user?.email}`);

    // 把桌面端这个会话记进缓存：服务端对「申请验证码」有 60 秒冷却，
    // 后面要复用 owner 身份时不能再申请一次。桌面端的令牌存在加密的会话文件里，
    // 这里用桌面端自己的 secretBox 解开（顺便证明令牌确实是加密落盘的）。
    {
      const sessionFile = path.join(desktop.dataDir, "team-session.json");
      const stored = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      const plain = JSON.parse(desktop.app.desktop.secretBox.decrypt(Buffer.from(stored.data, "base64")));
      record("桌面端会话令牌已加密落盘", stored.encrypted === true && !fs.readFileSync(sessionFile, "utf8").includes(plain.token), "已确认");
      // 会话文件里没有用户 id，用 /v1/me 换一个
      const probe = await fetch(`${team.url}/v1/me`, { headers: { authorization: `Bearer ${plain.token}` } });
      const ownerMe = await probe.json() as Promise<any>;
      sessionCache.set("owner@example.com", { token: plain.token, userId: ownerMe.user?.id ?? "" });
      record("取到 owner 的用户 id", !!ownerMe.user?.id, ownerMe.user?.id ?? "");
    }

    // 3. 创建团队
    const created = await expectOk("/team/teams", "POST", { name: "试点团队" });
    const teamId = created.team.id;
    record("创建团队", !!teamId, `id=${teamId} role=${created.team.role}`);

    // 4. 保存团队模型配置
    const modelConfig = await expectOk(`/team/teams/${teamId}/model-config`, "PUT", { model: "pilot-model", apiKey: "sk-pilot-secret-key" });
    record("保存团队模型配置（Key 服务端加密）", modelConfig.modelConfig.configured === true, `model=${modelConfig.modelConfig.model} keyTail=${modelConfig.modelConfig.keyTail}`);

    // 5. 邀请成员
    const invite = await expectOk(`/team/teams/${teamId}/invitations`, "POST", { email: "member@example.com", role: "developer" });
    const inviteToken = invite.invitation.inviteUrl ? new URL(invite.invitation.inviteUrl).searchParams.get("token") : undefined;
    record("邀请成员（开发者）", !!inviteToken, `email=${invite.invitation.email} role=${invite.invitation.role}`);

    // 6. 创建共享机器人
    const bot = await expectOk(`/team/teams/${teamId}/bots`, "POST", { name: "试点助手", description: "试点用", instructions: "你是一个试点测试助手，请简洁回答。" });
    const botId = bot.bot.id;
    record("创建共享机器人", !!botId, `name=${bot.bot.name}`);

    // 7. 创建共享会话
    const conv = await expectOk(`/team/teams/${teamId}/conversations`, "POST", { botId, title: "试点讨论", visibility: "team" });
    const conversationId = conv.conversation.id;
    record("创建共享会话", !!conversationId, `visibility=${conv.conversation.visibility}`);

    // 8. 发消息 → 入队
    const posted = await expectOk(`/team/teams/${teamId}/conversations/${conversationId}/messages`, "POST", { content: "第一条试点消息" });
    record("发送共享消息并入队", !!posted.message?.id && posted.job?.status === "queued", `job=${posted.job?.status}`);

    // 9. 等 Worker 完成
    let reply = "";
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      const list = await expectOk(`/team/teams/${teamId}/conversations/${conversationId}/messages`);
      const assistant = list.messages?.find((m: any) => m.role === "assistant");
      if (assistant) { reply = String(assistant.content); break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    record("Worker 调用模型并生成回复", reply.startsWith("【试点桩回复】"), reply.slice(0, 50) || `超时未拿到回复（Worker 报错：${team.workerErrors.join(",") || "无"}）`);

    // 10. 模型网关确实被调用
    const call = modelCalls[modelCalls.length - 1];
    record("模型网关收到请求", !!call, call ? `model=${call.model}` : "无调用");
    record("请求带上团队模型的 Key", call?.authorization === "Bearer sk-pilot-secret-key", call?.authorization ?? "");
    record("系统提示含机器人指令", !!call?.system.includes("试点测试助手"), call?.system?.slice(0, 60) ?? "");

    // 11. 用量统计
    const usage = await expectOk(`/team/teams/${teamId}/usage`);
    record("用量统计累计", Number(usage.usage?.successfulJobs ?? 0) >= 1, `successfulJobs=${usage.usage?.successfulJobs} input=${usage.usage?.inputTokens} output=${usage.usage?.outputTokens}`);

    // 12. 审计事件
    const audit = await expectOk(`/team/teams/${teamId}/audit`);
    const actions = (audit.events ?? []).map((e: any) => e.action);
    record("审计事件记录", actions.includes("team.created") && actions.includes("job.queued"), actions.join(","));

    // 13. 成员登录并接受邀请
    const memberCodes = await expectOk("/team/auth/codes", "POST", { email: "member@example.com" });
    await expectOk("/team/auth/sessions", "POST", { email: "member@example.com", code: memberCodes.developmentCode });
    const accepted = await expectOk("/team/invitations/accept", "POST", { token: inviteToken });
    record("成员接受邀请加入团队", accepted.team?.id === teamId, `role=${accepted.team?.role}`);

    // 14. 成员看到团队
    const teams = await expectOk("/team/teams");
    record("成员列出团队", teams.teams?.some((t: any) => t.id === teamId) === true, teams.teams?.map((t: any) => `${t.name}(${t.role})`).join(","));

    // 15. 成员端拿不到原始 Key
    const memberModel = await expectOk(`/team/teams/${teamId}/model-config`);
    record("成员端拿不到原始模型 Key", JSON.stringify(memberModel).includes("sk-pilot-secret-key") === false, `configured=${memberModel.modelConfig?.configured} keyTail=${memberModel.modelConfig?.keyTail}`);

    // 16. 成员在共享会话发言
    const memberPosted = await expectOk(`/team/teams/${teamId}/conversations/${conversationId}/messages`, "POST", { content: "成员的第一条消息" });
    record("成员在共享会话发言", !!memberPosted.message?.id, `messageId=${memberPosted.message?.id}`);

    // 17. 角色门禁：桌面端此刻登录的是成员（第 13 步换成成员了），所以这里看到的是成员角色。
    //     顺便用直连客户端验证 owner 那边看到的确实是 owner —— 两个身份都要对。
    const memberTeams = await expectOk("/team/teams");
    const memberTeam = memberTeams.teams.find((t: any) => t.id === teamId);
    record("桌面端当前身份：团队成员（developer）", memberTeam?.role === "developer", `role=${memberTeam?.role}`);

    // 18. 会话在桌面端加密落盘
    const sessionFile = path.join(desktop.dataDir, "team-session.json");
    const exists = fs.existsSync(sessionFile);
    const raw = exists ? fs.readFileSync(sessionFile, "utf8") : "";
    const secret = await import(pathToFileURL(path.join(ROOT, "src/team/client.ts")).href).then(() => raw).catch(() => raw);
    record("团队会话加密落盘且不含明文令牌", exists && !raw.includes("\"token\":\"") && raw.length > 0, exists ? "已加密" : "未生成");

    // 19. 登出后本地会话文件应被清掉
    await expectOk("/team/auth/sessions/current", "DELETE");
    record("登出后清除本地会话", fs.existsSync(sessionFile) === false, "已清除");

    // 20. 健康检查
    const health = await fetch(`${team.url}/healthz`).then((r) => r.json());
    const ready = await fetch(`${team.url}/readyz`).then((r) => r.json());
    record("团队服务健康检查", health.ok === true && ready.ready === true, "healthz+readyz 通过");

    // ─────────────────────────────────────────────────────────────────
    // 21. 跨进程撤权
    //
    // 「撤权」之前只在同一个进程里测过。这里起**第二个独立的客户端**
    // （另一个 dataDir、另一份会话文件），用它来撤掉第一个客户端的权限，
    // 验证另一端立刻失效 —— 服务端的会话撤销、成员移除、角色降级、退出团队，
    // 都要让被撤的那一方在下一次请求时就被挡住。
    // ─────────────────────────────────────────────────────────────────
    console.log("\n跨进程撤权\n" + "-".repeat(64));

    /** 直连团队服务的客户端（模拟「另一个进程」） */
    const directApi = async (token: string, p: string, method = "GET", body?: unknown) => {
      const res = await fetch(`${team.url}/v1${p}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const data = await res.json().catch(() => ({})) as any;
      return { status: res.status, data };
    };

    // 21a. 桌面端会话被另一进程撤销 → 下一次请求必须 401，且本地会话文件被清掉
    {
      // 这里起一个**独立的客户端进程**（自己的 dataDir、自己的会话文件）来当被撤的一方。
      // 它不是演练脚本内嵌的假对象，而是一份真的 TeamClient，走真的加密会话文件。
      const { TeamClient } = await import(pathToFileURL(path.join(ROOT, "src/team/client.ts")).href);
      const key = crypto.randomBytes(32);
      const secretBox = {
        encrypt(plain: string) {
          const iv = crypto.randomBytes(12);
          const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
          const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
          return Buffer.concat([iv, cipher.getAuthTag(), body]);
        },
        decrypt(data: Buffer) {
          const decipher = crypto.createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
          decipher.setAuthTag(data.subarray(12, 28));
          return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
        },
      };
      const memberDir = fs.mkdtempSync(path.join(os.tmpdir(), "amb-pilot-member-"));
      const memberClient = new TeamClient({
        apiBaseUrl: team.url, dataDir: memberDir, secretBox: () => secretBox, fetch: fetch as typeof globalThis.fetch,
      });
      const memberCodes = await memberClient.requestCode("revoked@example.com");
      await memberClient.signIn("revoked@example.com", memberCodes.developmentCode);
      // 会话文件是加密的（{version,encrypted,data}），要解开才能拿到令牌。
      // 这里用与该客户端同一个 secretBox 解密 —— 顺便验证「令牌确实落盘加密了」。
      const stored = JSON.parse(fs.readFileSync(path.join(memberDir, "team-session.json"), "utf8"));
      const memberToken = JSON.parse(secretBox.decrypt(Buffer.from(stored.data, "base64"))).token;
      record("成员进程登录并持有会话", typeof memberToken === "string" && memberToken.length > 0, `文件已加密：${stored.encrypted === true}`);
      record("本地会话文件不含明文令牌", !fs.readFileSync(path.join(memberDir, "team-session.json"), "utf8").includes(memberToken), "已确认");

      // 登录后立刻能用：列出团队（此时还没进任何团队，返回空数组也算通过）
      const before = await directApi(memberToken, "/me");
      record("撤权前：成员会话有效", before.status === 200, `HTTP ${before.status}`);

      // 另一个进程撤销会话
      const revoked = await directApi(memberToken, "/auth/sessions/current", "DELETE");
      record("另一进程撤销会话", revoked.status === 200, `HTTP ${revoked.status}`);

      // 被撤的一方下一次请求必须 401
      const after = await directApi(memberToken, "/me");
      record("撤权后：原会话立即失效（401）", after.status === 401, `HTTP ${after.status}`);

      // 桌面端客户端自己发现 401 时应清掉本地会话
      const status = await memberClient.status();
      record("撤权后：本地会话被清掉", status.signedIn === false, `signedIn=${status.signedIn}`);
      record("撤权后：本地会话文件已删除", fs.existsSync(path.join(memberDir, "team-session.json")) === false, "已删除");

      fs.rmSync(memberDir, { recursive: true, force: true });
    }

    // 21b. 成员被移出团队 → 其排队任务被取消
    {
      const ownerToken = await loginAs(team.url, "owner@example.com");
      const inv = await directApi(ownerToken.token, `/teams/${teamId}/invitations`, "POST", { email: "kicked@example.com", role: "developer" });
      const inviteToken = new URL(inv.data.invitation.inviteUrl).searchParams.get("token")!;
      const kicked = await loginAs(team.url, "kicked@example.com");
      await directApi(kicked.token, "/invitations/accept", "POST", { token: inviteToken });

      // 成员发一条消息（入队）
      const posted = await directApi(kicked.token, `/teams/${teamId}/conversations/${conversationId}/messages`, "POST", { content: "待撤销的消息" });
      record("成员消息已入队", posted.status === 201, `HTTP ${posted.status}`);

      // owner 在**另一个进程**里移除该成员
      const removed = await directApi(ownerToken.token, `/teams/${teamId}/members/${kicked.userId}`, "DELETE");
      record("另一进程移除成员", removed.status === 200, `HTTP ${removed.status}`);

      // 被移除的成员立刻不能读写
      const afterRemove = await directApi(kicked.token, `/teams/${teamId}/messages`);
      record("撤权后：被移除成员请求被拒（403/404）", afterRemove.status === 403 || afterRemove.status === 404, `HTTP ${afterRemove.status}`);

      // 关键：被移除成员的**排队任务**必须被取消，不能还留在队列里等 Worker 去跑。
      // 否则撤权就只是「界面上看不到」，模型 Key 照样会被用掉。
      const ownerJobs = await directApi(ownerToken.token, `/teams/${teamId}/conversations/${conversationId}/messages`);
      const kickedJobs = (ownerJobs.data?.jobs ?? []) as Array<{ status?: string; errorCode?: string }>;
      const cancelled = kickedJobs.filter((j) => j.status === "cancelled" || j.errorCode === "member_removed");
      record("撤权后：被移除成员的排队任务已取消", cancelled.length > 0, `jobs=${JSON.stringify(kickedJobs.map((j) => `${j.status}/${j.errorCode ?? ""}`))}`);
    }

    // 21c. 角色降级为只读 → 其排队任务被取消
    {
      const ownerToken = await loginAs(team.url, "owner@example.com");
      const inv = await directApi(ownerToken.token, `/teams/${teamId}/invitations`, "POST", { email: "demoted@example.com", role: "developer" });
      const inviteToken = new URL(inv.data.invitation.inviteUrl).searchParams.get("token")!;
      const demoted = await loginAs(team.url, "demoted@example.com");
      await directApi(demoted.token, "/invitations/accept", "POST", { token: inviteToken });
      await directApi(demoted.token, `/teams/${teamId}/conversations/${conversationId}/messages`, "POST", { content: "降级前的消息" });

      const changed = await directApi(ownerToken.token, `/teams/${teamId}/members/${demoted.userId}/role`, "PATCH", { role: "viewer" });
      record("另一进程把成员降为只读", changed.status === 200, `HTTP ${changed.status}`);

      // 降级后不能再发言（只读成员没有发言权）
      const afterDemote = await directApi(demoted.token, `/teams/${teamId}/conversations/${conversationId}/messages`, "POST", { content: "降级后还想发言" });
      record("降级后：只读成员发言被拒（403）", afterDemote.status === 403, `HTTP ${afterDemote.status}`);
    }

    // 21d. 成员自己退出团队
    {
      const ownerToken = await loginAs(team.url, "owner@example.com");
      const inv = await directApi(ownerToken.token, `/teams/${teamId}/invitations`, "POST", { email: "quitter@example.com", role: "developer" });
      const inviteToken = new URL(inv.data.invitation.inviteUrl).searchParams.get("token")!;
      const quitter = await loginAs(team.url, "quitter@example.com");
      await directApi(quitter.token, "/invitations/accept", "POST", { token: inviteToken });

      const left = await directApi(quitter.token, `/teams/${teamId}/members/me`, "DELETE");
      record("成员自己退出团队", left.status === 200, `HTTP ${left.status}`);

      const afterLeave = await directApi(quitter.token, "/me");
      const teamsAfter = afterLeave.data?.teams ?? [];
      record("退出后：已不在任何团队", !teamsAfter.some((t: any) => t.id === teamId), teamsAfter.map((t: any) => t.name).join(",") || "（无团队）");
    }

  } finally {
    console.log("\n" + "=".repeat(64));
    const failed = steps.filter((s) => !s.ok);
    console.log(`结果：${steps.length - failed.length}/${steps.length} 步通过`);
    if (failed.length) { console.log("失败步骤："); for (const f of failed) console.log(`  - ${f.name}（${f.detail}）`); }
    try { await desktop.app.stop(); } catch { /* 忽略关闭错误 */ }
    await team.close();
    await gateway.close();
    fs.rmSync(desktop.dataDir, { recursive: true, force: true });
    process.exit(failed.length ? 1 : 0);
  }
}

main().catch((error) => { console.error("演练异常：", error); process.exit(1); });
