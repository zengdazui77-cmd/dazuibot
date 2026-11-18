import { randomBytes } from "node:crypto";
import type { Config } from "./config.js";
import { decryptCredential } from "./credentials.js";
import { isModelPermitted } from "./model-policy.js";
import {
  checkRules,
  loadPolicyRules,
  loadPolicyUsage,
  recordPolicyUsage,
  recordPolicyViolation,
  type PolicyViolation,
} from "./policy-rules.js";
import { Store } from "./store.js";
import type { TeamEventHub } from "./events.js";

const REQUEST_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_CONTEXT_CHARS = 90_000;
const MAX_COMPLETION_CHARS = 20_000;

interface JobRow {
  id: string; team_id: string; conversation_id: string; status: string; attempt_count: number; lease_token: string | null;
  model_name?: string | null;
}
interface RunContext {
  model: string; apiKey: string; encryptedApiKey: string; instructions: string; title: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  userId: string; userRole: "owner" | "admin" | "developer" | "viewer";
}
interface WorkerOptions {
  fetch?: typeof fetch;
  now?: () => number;
  onError?: (kind: string) => void;
  events?: TeamEventHub;
  /** 失败后的退避时长（毫秒）。默认 5 秒；测试可以调小以便快速验证重试。 */
  retryDelayMs?: number;
}

export class TeamWorker {
  private active = false;
  private stopped = false;
  /** 打断当前轮询等待用；stop() 会调用它，避免关闭被轮询间隔拖住。 */
  private wake: (() => void) | undefined;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly config: Config, private readonly store: Store, private readonly options: WorkerOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.stopped = false;
    void this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    while (this.active) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  /** Runs one durable queue item; exposed for deterministic tests and controlled worker pools. */
  async runOnce(): Promise<boolean> {
    const job = await this.claim();
    if (!job) return false;
    try {
      if (!this.config.modelBaseUrl) return await this.fail(job, "model_endpoint_missing", false);
      const context = await this.context(job);
      if (!context) return await this.fail(job, "model_key_missing", false);
      if (!await this.isAuthorizedForCall(job, context.encryptedApiKey)) return await this.fail(job, "member_or_key_revoked", false);
      const violation = await this.checkOverlayRules(job, context);
      if (violation) return await this.fail(job, `policy_violation_${violation.type}`, false);
      const completion = await this.complete(context);
      await this.succeed(job, completion.reply, context.model, completion.usage);
      if (completion.usage) await this.recordUsage(job, context, completion.usage);
      this.options.events?.publish(job.conversation_id);
    } catch (error) {
      const kind = error instanceof WorkerFailure ? error.kind : "model_unavailable";
      this.options.onError?.(kind);
      const retryable = error instanceof WorkerFailure ? error.retryable : true;
      await this.fail(job, kind, retryable);
    }
    return true;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const worked = await this.runOnce();
        if (!worked) await this.sleep(1_500);
      } catch {
        this.options.onError?.("worker_internal_error");
        await this.sleep(2_000);
      }
    }
    this.active = false;
  }

  /** 可被 stop() 立刻打断的等待：不然关闭时会被整段轮询间隔拖住。 */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.wake = undefined; resolve(); }, ms);
      this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
    });
  }

  private async claim(): Promise<JobRow | undefined> {
    const expiredConversationIds: string[] = [];
    const claim = await this.store.transaction(async (client) => {
      const now = new Date(this.now());
      const expired = await client.query<{ conversation_id: string }>(
        `UPDATE team_jobs SET status='failed', error_code='attempt_limit', lease_token=NULL, lease_until=NULL, updated_at=$1
          WHERE status='running' AND lease_until <= clock_timestamp() AND attempt_count >= 3 RETURNING conversation_id`, [now],
      );
      expiredConversationIds.push(...expired.rows.map((row) => row.conversation_id));
      const result = await client.query<JobRow>(
        `SELECT id, team_id, conversation_id, status, attempt_count, lease_token, model_name FROM team_jobs
          WHERE attempt_count < 3 AND ((status='queued' AND available_at <= clock_timestamp()) OR (status='running' AND lease_until <= clock_timestamp()))
          ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      const row = result.rows[0];
      if (!row) return undefined;
      const leaseToken = randomBytes(24).toString("base64url");
      const updated = await client.query<JobRow>(
        `UPDATE team_jobs SET status='running', attempt_count=attempt_count+1, lease_token=$2,
             lease_until=clock_timestamp() + interval '120 seconds', error_code=NULL, updated_at=$1 WHERE id=$3
         RETURNING id, team_id, conversation_id, status, attempt_count, lease_token, model_name`,
        [now, leaseToken, row.id],
      );
      return updated.rows[0];
    });
    for (const conversationId of expiredConversationIds) this.options.events?.publish(conversationId);
    return claim;
  }

  /**
   * 叠加限制层：在基线授权（选哪些模型）之外，检查速率、token 配额、黑名单等额外约束。
   * 本层只做「拒绝」，不产生「允许」；没有规则命中就放行。
   */
  private async checkOverlayRules(job: JobRow, context: RunContext): Promise<PolicyViolation | null> {
    return this.store.transaction(async (client) => {
      const rules = await loadPolicyRules(client, job.team_id);
      if (!rules.length) return null;
      const usage = await loadPolicyUsage(client, job.team_id, context.userId, context.model, this.now());
      const violation = checkRules(rules, {
        teamId: job.team_id,
        userId: context.userId,
        userRole: context.userRole,
        model: context.model,
      }, usage);
      if (violation) {
        await recordPolicyViolation(client, violation, job.team_id, context.userId, context.model, this.now());
      }
      return violation;
    });
  }

  /** 记录一次成功调用的用量，供速率与配额判定使用。 */
  private async recordUsage(job: JobRow, context: RunContext, usage: { inputTokens: number; outputTokens: number }): Promise<void> {
    try {
      await this.store.transaction(async (client) => {
        await recordPolicyUsage(client, job.team_id, context.userId, context.model, usage.inputTokens, usage.outputTokens, this.now());
      });
    } catch {
      // 用量记录失败不应让已经成功的回复变成失败；下一轮判定会少算一点配额。
    }
  }

  private async context(job: JobRow): Promise<RunContext | undefined> {
    const [credential, bot, messages, active, policy, requester] = await Promise.all([
      this.store.pool.query<{ model: string; encrypted_api_key: string }>("SELECT model, encrypted_api_key FROM team_model_credentials WHERE team_id=$1", [job.team_id]),
      this.store.pool.query<{ instructions: string; title: string }>(
        `SELECT b.instructions, c.title FROM team_conversations c JOIN team_bots b ON b.team_id=c.team_id AND b.id=c.bot_id
          WHERE c.team_id=$1 AND c.id=$2`, [job.team_id, job.conversation_id],
      ),
      this.store.pool.query<{ role: "user" | "assistant"; content: string }>(
        `SELECT role, content FROM (
           SELECT role, content, sequence FROM team_messages WHERE conversation_id=$1 ORDER BY sequence DESC LIMIT 30
         ) recent ORDER BY sequence`, [job.conversation_id],
      ),
      this.store.pool.query<{ active: number }>(
        `SELECT 1 AS active FROM team_jobs j JOIN team_memberships m ON m.team_id=j.team_id AND m.user_id=j.created_by AND m.role IN ('owner','admin','developer')
          WHERE j.id=$1 AND j.status='running' AND j.lease_token=$2`, [job.id, job.lease_token],
      ),
      this.store.pool.query<{ mode: string; allowed_models: string[] }>(
        "SELECT mode, allowed_models FROM team_model_policies WHERE team_id=$1", [job.team_id],
      ),
      this.store.pool.query<{ user_id: string; role: "owner" | "admin" | "developer" | "viewer" }>(
        `SELECT m.user_id, m.role FROM team_jobs j
           JOIN team_memberships m ON m.team_id=j.team_id AND m.user_id=j.created_by
          WHERE j.id=$1`,
        [job.id],
      ),
    ]);
    const c = credential.rows[0];
    const b = bot.rows[0];
    const member = requester.rows[0];
    if (!c || !b || !active.rows[0] || !member) return undefined;
    // 任务入队时已固化成员选定的模型；若该模型已不在当前授权范围内，则回落到团队默认模型
    const requested = job.model_name ?? c.model;
    const permitted = isModelPermitted(
      (policy.rows[0]?.mode ?? "all") as "all" | "catalog" | "allowlist",
      policy.rows[0]?.allowed_models ?? [],
      this.config.modelCatalog,
      requested,
    );
    const model = permitted ? requested : c.model;
    let apiKey: string;
    try { apiKey = decryptCredential(this.config.credentialSecret, c.encrypted_api_key); }
    catch { throw new WorkerFailure("model_key_unavailable", false); }
    return { model, apiKey, encryptedApiKey: c.encrypted_api_key, instructions: b.instructions, title: b.title, messages: boundMessages(messages.rows), userId: member.user_id, userRole: member.role };
  }

  private async isAuthorizedForCall(job: JobRow, encryptedApiKey: string): Promise<boolean> {
    const result = await this.store.pool.query<{ active: number }>(
      `SELECT 1 AS active FROM team_jobs j
         JOIN team_memberships m ON m.team_id=j.team_id AND m.user_id=j.created_by AND m.role IN ('owner','admin','developer')
         JOIN team_model_credentials c ON c.team_id=j.team_id AND c.encrypted_api_key=$3
        WHERE j.id=$1 AND j.status='running' AND j.lease_token=$2`, [job.id, job.lease_token, encryptedApiKey],
    );
    return !!result.rows[0];
  }

  private async complete(context: RunContext): Promise<{ reply: string; usage?: { inputTokens: number; outputTokens: number } }> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.config.modelBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${context.apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          model: context.model,
          messages: [
            { role: "system", content: [context.instructions, `This is the team discussion titled: ${context.title}. Reply as a text-only assistant. You have no tools and cannot execute code.`].filter(Boolean).join("\n\n") },
            ...context.messages,
          ],
          stream: false,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "error",
      });
    } catch { throw new WorkerFailure("model_unavailable", true); }
    if (response.status === 429 || response.status >= 500) throw new WorkerFailure("model_temporarily_unavailable", true);
    if (!response.ok) throw new WorkerFailure(response.status === 401 || response.status === 403 ? "model_key_rejected" : "model_request_rejected", false);
    const value = await boundedJson(response);
    const content = value.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new WorkerFailure("model_empty_reply", false);
    const reply = content.trim();
    if (reply.length > MAX_COMPLETION_CHARS) throw new WorkerFailure("model_reply_too_long", false);
    const promptTokens = tokenCount(value.usage?.prompt_tokens);
    const completionTokens = tokenCount(value.usage?.completion_tokens);
    return { reply, ...(promptTokens !== undefined && completionTokens !== undefined ? { usage: { inputTokens: promptTokens, outputTokens: completionTokens } } : {}) };
  }

  private async succeed(job: JobRow, reply: string, model: string, usage?: { inputTokens: number; outputTokens: number }): Promise<void> {
    await this.store.transaction(async (client) => {
      const completed = await client.query<{ team_id: string }>(
        `UPDATE team_jobs SET status='succeeded', model_name=$4, prompt_tokens=$5, completion_tokens=$6,
             error_code=NULL, lease_token=NULL, lease_until=NULL, updated_at=$1
          WHERE id=$2 AND status='running' AND lease_token=$3 RETURNING team_id`,
        [new Date(this.now()), job.id, job.lease_token, model, usage?.inputTokens ?? null, usage?.outputTokens ?? null],
      );
      if (!completed.rows[0]) return;
      const messageId = randomBytes(16).toString("hex");
      await client.query(
        "INSERT INTO team_messages(id, conversation_id, author_user_id, role, content, created_at) VALUES($1,$2,NULL,'assistant',$3,$4)",
        [messageId, job.conversation_id, reply, new Date(this.now())],
      );
      await client.query("UPDATE team_conversations SET updated_at=$2 WHERE id=$1", [job.conversation_id, new Date(this.now())]);
      await client.query(
        "INSERT INTO team_audit_events(id,team_id,actor_user_id,action,target_type,target_id,details,created_at) VALUES($1,$2,NULL,'job.succeeded','job',$3,$4,$5)",
        [randomBytes(16).toString("hex"), completed.rows[0].team_id, job.id, JSON.stringify({ conversationId: job.conversation_id }), new Date(this.now())],
      );
    });
  }

  private async fail(job: JobRow, errorCode: string, retryable: boolean): Promise<boolean> {
    await this.store.transaction(async (client) => {
      // 退避时间也用数据库时钟：available_at 的写入与比较必须同源，
      // 否则网络往返带来的时钟差会让任务被判为"尚未到期"或"已过期"。
      const retryDelayMs = this.options.retryDelayMs ?? 5_000;
      const result = await client.query<{ team_id: string; status: string; error_code: string }>(
        `UPDATE team_jobs SET status=CASE WHEN $4 AND attempt_count < 3 THEN 'queued' ELSE 'failed' END,
           error_code=CASE WHEN $4 AND attempt_count >= 3 THEN 'attempt_limit' ELSE $2 END,
           available_at=CASE WHEN $4 AND attempt_count < 3 THEN clock_timestamp() + ($6 || ' milliseconds')::interval ELSE available_at END,
           lease_token=NULL, lease_until=NULL, updated_at=$1
        WHERE id=$3 AND status='running' AND lease_token=$5
        RETURNING team_id, status, error_code`,
        [new Date(this.now()), errorCode, job.id, retryable, job.lease_token, String(retryDelayMs)],
      );
      const failed = result.rows[0];
      if (failed?.status === "failed") {
        await client.query(
          "INSERT INTO team_audit_events(id,team_id,actor_user_id,action,target_type,target_id,details,created_at) VALUES($1,$2,NULL,'job.failed','job',$3,$4,$5)",
          [randomBytes(16).toString("hex"), failed.team_id, job.id, JSON.stringify({ conversationId: job.conversation_id, errorCode: failed.error_code }), new Date(this.now())],
        );
      }
    });
    this.options.events?.publish(job.conversation_id);
    return true;
  }
}

interface ChatResponse { choices?: Array<{ message?: { content?: unknown } }>; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function boundedJson(response: Response): Promise<ChatResponse> {
  const advertised = Number(response.headers.get("content-length") ?? 0);
  if (advertised > MAX_RESPONSE_BYTES || !response.body) throw new WorkerFailure("model_invalid_response", false);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new WorkerFailure("model_invalid_response", false);
    }
    chunks.push(part.value);
  }
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes)) as ChatResponse;
  } catch (error) {
    if (error instanceof WorkerFailure) throw error;
    throw new WorkerFailure("model_invalid_response", false);
  }
}

function boundMessages(input: Array<{ role: "user" | "assistant"; content: string }>): RunContext["messages"] {
  const selected: RunContext["messages"] = [];
  let chars = 0;
  for (const item of [...input].reverse()) {
    if (chars >= MAX_CONTEXT_CHARS) break;
    const content = item.content.slice(0, Math.min(item.content.length, MAX_CONTEXT_CHARS - chars));
    selected.push({ role: item.role, content });
    chars += content.length;
  }
  return selected.reverse();
}

class WorkerFailure extends Error {
  constructor(readonly kind: string, readonly retryable: boolean) { super(kind); }
}
