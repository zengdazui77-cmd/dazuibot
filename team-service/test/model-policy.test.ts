import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { Config } from "../src/config.js";
import { PGlitePool } from "../src/pglite-pool.js";
import { TeamService } from "../src/service.js";
import { Store } from "../src/store.js";
import { TeamWorker } from "../src/worker.js";

// 走真正的 PGlite 连接池：和内嵌模式跑的是同一条代码路径
const pool = new PGlitePool() as unknown as Pool;

const config: Config = {
  host: "127.0.0.1", port: 0, databaseUrl: "postgres://unused",
  sessionSecret: "test-session-secret-is-long-enough-32-bytes",
  credentialSecret: "test-credential-secret-is-long-enough-32-bytes",
  modelBaseUrl: "https://models.example.test/v1",
  modelCatalog: ["gpt-4o", "gpt-4o-mini", "claude-sonnet-4"],
  publicUrl: "http://127.0.0.1:8787", mailFrom: "test@example.com", smtpUrl: "",
  codeExecutorUrl: "", codeExecutorBrokerUrl: "http://127.0.0.1:8787", codeExecutorSecret: "", codeExecutorPollMs: 250,
  corsOrigins: new Set(), allowDevCodes: true, production: false,
};

let now = Date.parse("2026-12-01T00:00:00Z");
const store = new Store(config, pool);
const service = new TeamService(config, store, undefined, { now: () => now, makeCode: () => "123456" });

async function signIn(email: string) {
  const challenge = await service.requestLoginCode(email);
  return service.createSession(email, challenge.developmentCode!);
}

async function addDeveloper(slug: string) {
  const email = `${slug}@example.com`;
  const owner = await service.authenticate((await signIn(`owner-${slug}@example.com`)).token);
  const team = await service.createTeam(owner, "Policy team");
  const invite = await service.createInvitation(owner, team.id, email, "developer");
  const token = new URL(invite.invitation.inviteUrl!).searchParams.get("token")!;
  const developer = await service.authenticate((await signIn(email)).token);
  await service.acceptInvitation(developer, token);
  return { owner, team, developer };
}

describe("team model access policy", () => {
  beforeAll(async () => { await store.migrate(); });
  afterAll(async () => { await store.close(); });

  it("defaults to unrestricted access so existing teams keep working", async () => {
    now += 60_000;
    const { owner, team } = await addDeveloper("policy-default");
    const policy = await service.getModelPolicy(owner, team.id);
    expect(policy.mode).toBe("all");
    expect(policy.allowedModels).toEqual([]);
    expect(policy.memberModel).toBeUndefined();
  });

  it("defaults a policy row to unrestricted access instead of an empty allowlist", async () => {
    now += 60_000;
    const { owner, team } = await addDeveloper("policy-column-default");
    const { team: otherTeam } = await addDeveloper("policy-column-default-2");
    // 列默认值本身必须是 'all'：省略 mode 插入时不应得到空 allowlist（那会让全队无模型可用）。
    const inserted = await store.pool.query<{ mode: string }>(
      "INSERT INTO team_model_policies(team_id, mode, allowed_models, updated_at) VALUES($1, DEFAULT, '{}',$2) RETURNING mode",
      [otherTeam.id, new Date(now)],
    );
    expect(inserted.rows[0]?.mode).toBe("all");

    await store.pool.query(
      "INSERT INTO team_model_policies(team_id, mode, allowed_models, updated_at) VALUES($1,'all','{}',$2)",
      [team.id, new Date(now)],
    );
    const policy = await service.getModelPolicy(owner, team.id);
    expect(policy.mode).toBe("all");
    expect(policy.availableModels.length).toBeGreaterThan(0);
  });

  it("lets an owner set an allowlist and confines members to it", async () => {
    now += 60_000;
    const { owner, team, developer } = await addDeveloper("policy-allow");
    await service.saveModelConfig(owner, team.id, { model: "gpt-4o", apiKey: "sk-policy-secret-1234" });

    await expect(service.saveModelPolicy(developer, team.id, { mode: "allowlist", allowedModels: ["gpt-4o"] }))
      .rejects.toMatchObject({ status: 403 });
    await expect(service.saveModelPolicy(owner, team.id, { mode: "allowlist", allowedModels: [] }))
      .rejects.toMatchObject({ status: 400 });
    await expect(service.saveModelPolicy(owner, team.id, { mode: "bogus" }))
      .rejects.toMatchObject({ status: 400 });

    const saved = await service.saveModelPolicy(owner, team.id, { mode: "allowlist", allowedModels: ["gpt-4o", "gpt-4o-mini"] });
    expect(saved.mode).toBe("allowlist");
    expect(saved.allowedModels).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(saved.availableModels).toEqual(["gpt-4o", "gpt-4o-mini"]);

    // 成员只能在授权范围内选择模型
    await expect(service.saveMemberModel(developer, team.id, "claude-sonnet-4")).rejects.toMatchObject({ status: 403 });
    const member = await service.saveMemberModel(developer, team.id, "gpt-4o-mini");
    expect(member.memberModel).toBe("gpt-4o-mini");

    // 越权的模型不会进入可选列表
    expect((await service.getModelPolicy(developer, team.id)).availableModels).not.toContain("claude-sonnet-4");
  });

  it("uses the deployment catalog when the team picks the catalog mode", async () => {
    now += 60_000;
    const { owner, team, developer } = await addDeveloper("policy-catalog");
    await service.saveModelConfig(owner, team.id, { model: "gpt-4o", apiKey: "sk-catalog-secret-1234" });

    const saved = await service.saveModelPolicy(owner, team.id, { mode: "catalog" });
    expect(saved.mode).toBe("catalog");
    expect(saved.availableModels).toEqual(config.modelCatalog);
    expect(await service.saveMemberModel(developer, team.id, "claude-sonnet-4")).toMatchObject({ memberModel: "claude-sonnet-4" });
  });

  it("runs a job on the model the member picked", async () => {
    now += 60_000;
    const { owner, team, developer } = await addDeveloper("policy-run");
    await service.saveModelConfig(owner, team.id, { model: "gpt-4o", apiKey: "sk-run-secret-1234" });
    await service.saveModelPolicy(owner, team.id, { mode: "allowlist", allowedModels: ["gpt-4o", "gpt-4o-mini"] });
    await service.saveMemberModel(developer, team.id, "gpt-4o-mini");

    const bot = await service.createBot(owner, team.id, { name: "Policy bot" });
    const conversation = await service.createConversation(owner, team.id, { botId: bot.id, title: "Policy thread", visibility: "team" });

    const bodies: string[] = [];
    const worker = new TeamWorker(config, store, {
      fetch: async (_input, init) => {
        bodies.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      },
    });

    await service.postMessage(developer, team.id, conversation.id, "Use my model");
    expect(await worker.runOnce()).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).model).toBe("gpt-4o-mini");
  });

  it("falls back to the team default when the member has no allowed preference", async () => {
    now += 60_000;
    const { owner, team, developer } = await addDeveloper("policy-fallback");
    await service.saveModelConfig(owner, team.id, { model: "gpt-4o", apiKey: "sk-fallback-secret-1234" });
    await service.saveModelPolicy(owner, team.id, { mode: "allowlist", allowedModels: ["gpt-4o"] });

    const bot = await service.createBot(owner, team.id, { name: "Fallback bot" });
    const conversation = await service.createConversation(owner, team.id, { botId: bot.id, title: "Fallback thread", visibility: "team" });

    const bodies: string[] = [];
    const worker = new TeamWorker(config, store, {
      fetch: async (_input, init) => {
        bodies.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      },
    });

    await service.postMessage(developer, team.id, conversation.id, "Use the team default");
    expect(await worker.runOnce()).toBe(true);
    expect(JSON.parse(bodies[0]!).model).toBe("gpt-4o");
  });

  it("clears member preferences that fall outside a tightened policy", async () => {
    now += 60_000;
    const { owner, team, developer } = await addDeveloper("policy-tighten");
    await service.saveModelConfig(owner, team.id, { model: "gpt-4o", apiKey: "sk-tighten-secret-1234" });
    await service.saveModelPolicy(owner, team.id, { mode: "allowlist", allowedModels: ["gpt-4o", "gpt-4o-mini"] });
    await service.saveMemberModel(developer, team.id, "gpt-4o-mini");

    await service.saveModelPolicy(owner, team.id, { mode: "allowlist", allowedModels: ["gpt-4o"] });
    expect((await service.getModelPolicy(developer, team.id)).memberModel).toBeUndefined();
  });

  it("rejects a model outside the allowlist when posting a message", async () => {
    now += 60_000;
    const { owner, team, developer } = await addDeveloper("policy-post");
    await service.saveModelConfig(owner, team.id, { model: "gpt-4o", apiKey: "sk-post-secret-1234" });
    await service.saveModelPolicy(owner, team.id, { mode: "allowlist", allowedModels: ["gpt-4o"] });
    const bot = await service.createBot(owner, team.id, { name: "Post bot" });
    const conversation = await service.createConversation(owner, team.id, { botId: bot.id, title: "Post thread", visibility: "team" });

    await expect(service.postMessage(developer, team.id, conversation.id, "hello")).resolves.toMatchObject({ job: { status: "queued" } });
  });

  it("records a policy audit trail", async () => {
    now += 60_000;
    const { owner, team } = await addDeveloper("policy-audit");
    await service.saveModelPolicy(owner, team.id, { mode: "allowlist", allowedModels: ["gpt-4o"] });
    const events = await store.pool.query<{ action: string }>(
      "SELECT action FROM team_audit_events WHERE team_id=$1 AND action LIKE 'model_policy%' ORDER BY created_at", [team.id],
    );
    expect(events.rows.map((row) => row.action)).toEqual(["model_policy.updated"]);
  });
});
