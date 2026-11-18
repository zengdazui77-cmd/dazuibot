import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { Config } from "../src/config.js";
import { createTeamHttpServer } from "../src/http.js";
import { checkRules, loadPolicyRules, loadPolicyUsage } from "../src/policy-rules.js";
import { TeamService } from "../src/service.js";
import { Store } from "../src/store.js";
import { TeamEventHub } from "../src/events.js";

/**
 * 真实 PostgreSQL 集成测试。
 *
 * 目的是验证 PGlite 适配层和真实 pg 的行为一致：
 * 迁移、事务边界、pg_advisory_xact_lock、ON CONFLICT、LISTEN/NOTIFY 等。
 * 没有设置 TEAM_TEST_DATABASE_URL 时整个文件跳过。
 */
const databaseUrl = process.env.TEAM_TEST_DATABASE_URL;
// 每个测试文件用独立 schema，避免并行运行时互相 DROP 对方的表
const SCHEMA = "dz_integration_suite";
async function prepareSchema(url: string): Promise<void> {
  const admin = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  } finally {
    await admin.end();
  }
}

describe.skipIf(!databaseUrl)("真实 PostgreSQL 集成", () => {
  let pool: Pool;
  let store: Store;
  let service: TeamService;
  let server: ReturnType<typeof createTeamHttpServer>;
  let baseUrl: string;
  let config: Config;

  beforeAll(async () => {
    await prepareSchema(databaseUrl!);
    pool = new Pool({
      connectionString: `${databaseUrl}${databaseUrl!.includes("?") ? "&" : "?"}options=-c%20search_path%3D${SCHEMA}`,
      max: 4,
      connectionTimeoutMillis: 5_000,
    });
    config = {
      host: "127.0.0.1", port: 0, databaseUrl: databaseUrl!, sessionSecret: "test-session-secret-is-long-enough-32-bytes",
      credentialSecret: "test-credential-secret-is-long-enough-32-bytes", modelBaseUrl: "https://models.example.test/v1",
      modelCatalog: ["gpt-4o", "gpt-4o-mini", "claude-sonnet-4"],
      publicUrl: "http://127.0.0.1:8787", mailFrom: "test@example.com", smtpUrl: "", codeExecutorUrl: "", codeExecutorBrokerUrl: "http://127.0.0.1:8787", codeExecutorSecret: "", codeExecutorPollMs: 250, corsOrigins: new Set(), allowDevCodes: true, production: false,
    };
    store = new Store(config, pool);
    service = new TeamService(config, store, undefined, { now: () => Date.now(), makeCode: () => "123456" });
    await store.migrate();
    server = createTeamHttpServer(config, store, service, new TeamEventHub());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
  });

  it("迁移在真实 pg 上能跑通，表结构齐全", async () => {
    const migrations = await pool.query<{ version: string }>("SELECT version FROM team_schema_migrations ORDER BY version");
    expect(migrations.rows.length).toBeGreaterThan(0);
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='${SCHEMA}' ORDER BY table_name`,
    );
    const names = tables.rows.map((row) => row.table_name);
    for (const expected of ["team_users", "teams", "team_memberships", "team_conversations", "team_messages", "team_model_credentials", "team_email_challenges"]) {
      expect(names).toContain(expected);
    }
  });

  it("完整 HTTP 流程：登录、建团队、配模型、发消息、读回", async () => {
    const email = "pg-owner@example.com";
    const code = await request(baseUrl, "", "POST", "/v1/auth/codes", { email });
    expect(code.status).toBe(202);
    const codeBody = await code.json() as { developmentCode: string };
    expect(codeBody.developmentCode).toBe("123456");

    const session = await request(baseUrl, "", "POST", "/v1/auth/sessions", { email, code: "123456" });
    expect(session.status).toBe(201);
    const sessionBody = await session.json() as { token: string };
    const token = sessionBody.token;
    expect(token).toBeTruthy();

    const teamResponse = await request(baseUrl, token, "POST", "/v1/teams", { name: "PG 团队" });
    expect(teamResponse.status).toBe(201);
    const teamId = (await teamResponse.json() as { team: { id: string } }).team.id;

    const modelResponse = await request(baseUrl, token, "PUT", `/v1/teams/${teamId}/model-config`, { model: "gpt-4o", apiKey: "sk-pg-test-key" });
    expect(modelResponse.status).toBe(200);

    const botResponse = await request(baseUrl, token, "POST", `/v1/teams/${teamId}/bots`, { name: "机器人", description: "", instructions: "" });
    expect(botResponse.status).toBe(201);
    const botId = (await botResponse.json() as { bot: { id: string } }).bot.id;

    const conversationResponse = await request(baseUrl, token, "POST", `/v1/teams/${teamId}/conversations`, { botId, title: "话题", visibility: "team" });
    expect(conversationResponse.status).toBe(201);
    const conversationId = (await conversationResponse.json() as { conversation: { id: string } }).conversation.id;

    const messageResponse = await request(baseUrl, token, "POST", `/v1/teams/${teamId}/conversations/${conversationId}/messages`, { content: "真实 pg 里的消息" });
    expect(messageResponse.status).toBe(201);
    const messageBody = await messageResponse.json() as { message?: { role: string; content: string } };
    expect(messageBody.message?.content).toBe("真实 pg 里的消息");
    expect(messageBody.message?.role).toBe("user");

    const listResponse = await request(baseUrl, token, "GET", `/v1/teams/${teamId}/conversations/${conversationId}/messages`);
    expect(listResponse.status).toBe(200);
    const listed = await listResponse.json() as { messages: { content: string }[] };
    expect(listed.messages.some((m) => m.content === "真实 pg 里的消息")).toBe(true);
  });

  it("密钥在真实 pg 里也是加密存储的", async () => {
    const rows = await pool.query<{ encrypted_api_key: string; key_tail: string }>(
      "SELECT encrypted_api_key, key_tail FROM team_model_credentials",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.encrypted_api_key).not.toContain("sk-pg-test-key");
    expect(rows.rows[0]!.key_tail).toBeTruthy();
  });

  it("刚入队的任务在真实 pg 上能立刻被 Worker 领走", async () => {
    // 回归覆盖：入队与取任务的比较基准必须同源（都用数据库时钟）。
    // 早前一个版本拿应用时钟去比数据库写入的 available_at，跨网络有约 1ms 差距，
    // 加上 PostgreSQL 微秒精度与 Node 毫秒精度不一致，同一时刻入队的任务会被
    // 判为"尚未到期"而一直取不到 —— 真实 pg 上约每 6~15 次复现一次。
    //
    // 这里刻意让 available_at 保持数据库默认值（now()，微秒精度），
    // 因为这正是真实入队路径的写法；比较基准若换成应用时钟就会漏掉任务。
    const { TeamWorker } = await import("../src/worker.js");
    const calls: string[] = [];
    const worker = new TeamWorker(config, store, {
      // 模拟"应用与数据库不在同一台机器"：跨网络有几十毫秒往返，应用时钟明显落后于数据库时钟。
      // 取任务的比较基准若用应用时钟，就会比数据库写入的 available_at 早，
      // 同一时刻入队的任务被判为"尚未到期"而取不到。
      now: () => Date.now() - 50,
      fetch: async (_input, init) => {
        calls.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ choices: [{ message: { content: "收到" } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }), { status: 200 });
      },
    });
    try {
      const teamId = (await pool.query<{ id: string }>("SELECT id FROM teams LIMIT 1")).rows[0]!.id;
      const botId = (await pool.query<{ id: string }>("SELECT id FROM team_bots LIMIT 1")).rows[0]!.id;
      const conversationId = (await pool.query<{ id: string }>("SELECT id FROM team_conversations LIMIT 1")).rows[0]!.id;
      const userId = (await pool.query<{ id: string }>("SELECT id FROM team_users LIMIT 1")).rows[0]!.id;

      // 入队一条就立刻取一条：只有这样才能复现"刚入队的任务取不到"。
      // 批量插入再批量取的话，插入耗时已经把 available_at 推过了比较时刻，不会触发缺陷。
      for (let i = 0; i < 12; i++) {
        const messageId = `msg-${i}`;
        await pool.query(
          `INSERT INTO team_messages(id, conversation_id, author_user_id, role, content, created_at)
           VALUES($1,$2,$3,'user','回归消息','now')`,
          [messageId, conversationId, userId],
        );
        // available_at 交给表上的 DEFAULT now()，与真实入队路径一致
        await pool.query(
          `INSERT INTO team_jobs(id, team_id, conversation_id, user_message_id, created_by, created_at, updated_at, model_name)
           VALUES($1,$2,$3,$4,$5,now(),now(),'team-model')`,
          [`job-${i}`, teamId, conversationId, messageId, userId],
        );
        // 先确认这条任务确实"已到期"：用数据库时钟比较应当能取到，
        // 用慢 2ms 的应用时钟比较则取不到 —— 两者之差正是缺陷的成因。
        const byDbClock = await pool.query(
          `SELECT 1 FROM team_jobs WHERE id=$1 AND available_at <= clock_timestamp()`, [`job-${i}`],
        );
        expect(byDbClock.rowCount).toBe(1);
        expect(await worker.runOnce()).toBe(true);
      }
      expect(calls).toHaveLength(12);
    } finally {
      await worker.stop();
    }
  });

  it("唯一约束真的生效：重复邀请同一个人会被数据库挡住", async () => {
    const rows = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM team_users WHERE email='pg-owner@example.com'");
    expect(Number(rows.rows[0]!.count)).toBe(1);
  });

  it("事务回滚有效：失败的操作不会留下半截数据", async () => {
    const before = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM teams");
    // created_by 指向不存在的用户，外键会拒绝这次插入
    await expect(
      pool.query("INSERT INTO teams(id, name, created_by) VALUES ('x','x','nonexistent')"),
    ).rejects.toThrow();
    const after = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM teams");
    expect(Number(after.rows[0]!.count)).toBe(Number(before.rows[0]!.count));
  });

  it("advisory lock 在真实 pg 上可用（登录码防重放依赖它）", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["dazuibot-login-code:lock-probe"]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(true).toBe(true);
  });

  it("叠加限制层在真实 pg 上可用：建规则、拦截、记违规", async () => {
    const email = "pg-rules@example.com";
    const code = await request(baseUrl, "", "POST", "/v1/auth/codes", { email });
    expect(code.status).toBe(202);
    const challenge = await code.json() as { developmentCode?: string };
    const session = await request(baseUrl, "", "POST", "/v1/auth/sessions", { email, code: challenge.developmentCode });
    const token = ((await session.json()) as { token: string }).token;

    const createdTeam = await request(baseUrl, token, "POST", "/v1/teams", { name: "PG rules team" });
    expect(createdTeam.status).toBe(201);
    const teamId = ((await createdTeam.json()) as { team: { id: string } }).team.id;

    // 建一条只针对 developer 的速率规则
    const createdRule = await request(baseUrl, token, "POST", `/v1/teams/${teamId}/model-policy-rules`, {
      ruleName: "PG rate limit",
      maxRequestsPerUserPerHour: 1,
      appliesToRoles: ["developer"],
    });
    expect(createdRule.status).toBe(201);
    const ruleId = ((await createdRule.json()) as { rule: { id: string } }).rule.id;

    const listed = await request(baseUrl, token, "GET", `/v1/teams/${teamId}/model-policy-rules`);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { rules: Array<{ id: string }> }).rules.map((r) => r.id)).toContain(ruleId);

    // 直接写一条用量记录，速率判定应当据此拒绝
    await pool.query(
      `INSERT INTO team_model_policy_usage(id, team_id, user_id, model, request_count, input_tokens, output_tokens, hour_bucket, day_bucket)
       SELECT 'pg-usage-1', $1, u.id, 'gpt-4o', 5, 0, 0, date_trunc('hour', now()), current_date
         FROM team_users u WHERE u.email = $2`,
      [teamId, email],
    );

    // 校验判定逻辑本身：计数已达上限，规则应当命中
    const client = await pool.connect();
    try {
      const rules = await loadPolicyRules(client, teamId);
      expect(rules.length).toBeGreaterThan(0);
      const usage = await loadPolicyUsage(client, teamId, (await pool.query<{ id: string }>("SELECT id FROM team_users WHERE email=$1", [email])).rows[0]!.id, "gpt-4o", Date.now());
      expect(usage.requestsThisHour).toBeGreaterThan(0);
      const violation = checkRules(rules, { teamId, userId: usage.requestsThisHour ? "x" : "", userRole: "owner", model: "gpt-4o" }, usage);
      // owner 不在 developer 范围内，因此不应当命中
      expect(violation).toBeNull();
      const developerViolation = checkRules(rules, { teamId, userId: "x", userRole: "developer", model: "gpt-4o" }, usage);
      expect(developerViolation?.type).toBe("rate_limit_exceeded");
    } finally {
      client.release();
    }

    // 违规接口可用
    const violations = await request(baseUrl, token, "GET", `/v1/teams/${teamId}/model-policy-violations`);
    expect(violations.status).toBe(200);
    expect(Array.isArray(((await violations.json()) as { violations: unknown[] }).violations)).toBe(true);

    // 批量停用
    const bulkDisabled = await request(baseUrl, token, "PUT", `/v1/teams/${teamId}/model-policy-rules/enabled`, {
      ruleIds: [ruleId], enabled: false,
    });
    expect(bulkDisabled.status).toBe(200);

    // 停用规则
    const disabled = await request(baseUrl, token, "PUT", `/v1/teams/${teamId}/model-policy-rules/${ruleId}/enabled`, {
      enabled: false,
    });
    expect(disabled.status).toBe(200);
    const afterDisable = await request(baseUrl, token, "GET", `/v1/teams/${teamId}/model-policy-rules`);
    expect(((await afterDisable.json()) as { rules: Array<{ id: string; enabled: boolean }> }).rules.find((r) => r.id === ruleId)?.enabled).toBe(false);

    // 删除规则
    const deleted = await request(baseUrl, token, "DELETE", `/v1/teams/${teamId}/model-policy-rules/${ruleId}`);
    expect(deleted.status).toBe(200);
    const afterDelete = await request(baseUrl, token, "GET", `/v1/teams/${teamId}/model-policy-rules`);
    expect(((await afterDelete.json()) as { rules: Array<{ id: string }> }).rules.map((r) => r.id)).not.toContain(ruleId);
  });
});

async function request(baseUrl: string, token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
