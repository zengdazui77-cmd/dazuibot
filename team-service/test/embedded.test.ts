import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startEmbeddedTeamService, type EmbeddedService } from "../src/embedded.js";

describe("内嵌模式", () => {
  let dataDir: string;
  let embedded: EmbeddedService;
  let token: string;
  let email = "";
  let teamId = "";
  let conversationId = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "dazuibot-embedded-"));
    embedded = await startEmbeddedTeamService({ dataDir });
  });
  afterAll(async () => {
    await embedded.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("迁移完可以连上", async () => {
    const response = await fetch(`${embedded.url}/readyz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: true });
  });

  it("没有令牌就拒绝", async () => {
    const response = await fetch(`${embedded.url}/v1/teams`);
    expect(response.status).toBe(401);
  });

  it("能走完登录、建团队、发消息的完整流程", async () => {
    email = "owner@example.com";
    const code = await requestCode(embedded.url, email);
    token = await createSession(embedded.url, email, code);

    const teamResponse = await request(embedded.url, token, "POST", "/v1/teams", { name: "内嵌团队" });
    expect(teamResponse.status).toBe(201);
    teamId = (await teamResponse.json() as { team: { id: string } }).team.id;

    const botResponse = await request(embedded.url, token, "POST", `/v1/teams/${teamId}/bots`, { name: "小助手", description: "", instructions: "" });
    expect(botResponse.status).toBe(201);
    const botId = (await botResponse.json() as { bot: { id: string } }).bot.id;

    // 发消息前要先配好团队的模型（业务规则：没配模型不允许发消息）
    const modelResponse = await request(embedded.url, token, "PUT", `/v1/teams/${teamId}/model-config`, { model: "gpt-4o", apiKey: "sk-test-key" });
    expect(modelResponse.status).toBe(200);
    expect((await modelResponse.json() as { modelConfig: { configured: boolean } }).modelConfig.configured).toBe(true);

    const conversationResponse = await request(embedded.url, token, "POST", `/v1/teams/${teamId}/conversations`, { botId, title: "日常", visibility: "team" });
    expect(conversationResponse.status).toBe(201);
    conversationId = (await conversationResponse.json() as { conversation: { id: string } }).conversation.id;

    const messageResponse = await request(embedded.url, token, "POST", `/v1/teams/${teamId}/conversations/${conversationId}/messages`, { content: "在吗" });
    expect(messageResponse.status).toBe(201);
    const body = await messageResponse.json() as { message?: { role: string; content: string }; messages?: { role: string; content: string }[] };
    const sent = body.message ?? body.messages?.[body.messages.length - 1];
    expect(sent?.role).toBe("user");
    expect(sent?.content).toBe("在吗");

    // 再读回来，确认真的写进数据库了
    const listResponse = await request(embedded.url, token, "GET", `/v1/teams/${teamId}/conversations/${conversationId}/messages`);
    expect(listResponse.status).toBe(200);
    const listed = await listResponse.json() as { messages: { role: string; content: string }[] };
    expect(listed.messages.some((m) => m.content === "在吗")).toBe(true);
  });

  it("入队的任务能被 Worker 立刻领走并生成回复", async () => {
    // 覆盖一个真实缺陷：任务刚入队时，若取任务的比较基准和写入基准不同源，
    // 或精度不同（PostgreSQL 微秒 vs Node 毫秒），任务会被判为"尚未到期"而一直取不到。
    const { TeamWorker } = await import("../src/worker.js");
    const calls: string[] = [];
    const worker = new TeamWorker(embedded.config, embedded.store, {
      fetch: async (_input, init) => {
        calls.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ choices: [{ message: { content: "收到" } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }), { status: 200 });
      },
    });
    try {
      // 连续多次入队，每次都必须立刻被领走
      for (let i = 0; i < 5; i++) {
        const posted = await request(embedded.url, token, "POST", `/v1/teams/${teamId}/conversations/${conversationId}/messages`, { content: `第 ${i} 条` });
        expect(posted.status).toBe(201);
        expect(await worker.runOnce()).toBe(true);
      }
      expect(calls).toHaveLength(5);
    } finally {
      await worker.stop();
    }
  });

  it("会话还能用，拿到的是同一个用户和同一个团队", async () => {
    const me = await request(embedded.url, token, "GET", "/v1/me");
    expect(me.status).toBe(200);
    const body = await me.json() as { user: { email: string }; teams: { id: string }[] };
    expect(body.user.email).toBe(email);
    expect(body.teams.length).toBe(1);
  });

  it("模型密钥是加密存的，不会明文落库", async () => {
    const row = await embedded.store.pool.query<{ encrypted_api_key: string }>("SELECT encrypted_api_key FROM team_model_credentials");
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.encrypted_api_key).not.toContain("sk-test-key");
  });

  it("重启服务后数据还在、密钥也还在", async () => {
    await embedded.close();
    embedded = await startEmbeddedTeamService({ dataDir });

    const me = await request(embedded.url, token, "GET", "/v1/me");
    expect(me.status).toBe(200);
    const body = await me.json() as { teams: { id: string }[] };
    expect(body.teams.length).toBe(1);

    // 老会话还能用，说明 sessionSecret 是从磁盘读回来的，不是新生成的
    const teams = await request(embedded.url, token, "GET", "/v1/teams");
    expect(teams.status).toBe(200);
  });
});

async function requestCode(baseUrl: string, email: string): Promise<string> {
  const response = await request(baseUrl, "", "POST", "/v1/auth/codes", { email });
  expect(response.status).toBe(202);
  const body = await response.json() as { developmentCode?: string };
  expect(body.developmentCode).toBeDefined();
  return body.developmentCode!;
}

async function createSession(baseUrl: string, email: string, code: string): Promise<string> {
  const response = await request(baseUrl, "", "POST", "/v1/auth/sessions", { email, code });
  expect(response.status).toBe(201);
  const body = await response.json() as { token?: string; session?: { token?: string } };
  const token = body.token ?? body.session?.token;
  expect(token).toBeDefined();
  return token!;
}

async function request(baseUrl: string, token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
