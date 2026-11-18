import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { Config } from "../src/config.js";
import { PGlitePool } from "../src/pglite-pool.js";
import { checkAgainstRule, checkRules, type PolicyRule, type PolicyUsage } from "../src/policy-rules.js";
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

let now = Date.parse("2026-12-02T00:00:00Z");
const store = new Store(config, pool);
const service = new TeamService(config, store, undefined, { now: () => now, makeCode: () => "123456" });

async function signIn(email: string) {
  const challenge = await service.requestLoginCode(email);
  return service.createSession(email, challenge.developmentCode!);
}

async function addDeveloper(slug: string) {
  const email = `${slug}@example.com`;
  const owner = await service.authenticate((await signIn(`owner-${slug}@example.com`)).token);
  const team = await service.createTeam(owner, "Rule team");
  const invite = await service.createInvitation(owner, team.id, email, "developer");
  const token = new URL(invite.invitation.inviteUrl!).searchParams.get("token")!;
  const developer = await service.authenticate((await signIn(email)).token);
  await service.acceptInvitation(developer, token);
  return { owner, team, developer };
}

/** 构造一条规则用于纯函数判定。 */
function rule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id: "rule-1",
    teamId: "team-1",
    ruleName: "Rule",
    enabled: true,
    allowedModels: [],
    blockedModels: [],
    maxRequestsPerUserPerHour: null,
    maxRequestsPerTeamPerHour: null,
    maxInputTokensPerRequest: null,
    maxOutputTokensPerRequest: null,
    maxTotalTokensPerUserPerDay: null,
    appliesToRoles: ["owner", "admin", "developer", "viewer"],
    priority: 100,
    ...overrides,
  };
}

const noUsage: PolicyUsage = { requestsThisHour: 0, teamRequestsThisHour: 0, tokensToday: 0n };

describe("model policy overlay rules", () => {
  beforeAll(async () => { await store.migrate(); });
  afterAll(async () => { await store.close(); });

  describe("pure evaluation", () => {
    it("passes when no rule applies", () => {
      const request = { teamId: "team-1", userId: "u1", userRole: "developer" as const, model: "gpt-4o" };
      expect(checkRules([], request, noUsage)).toBeNull();
      expect(checkRules([rule()], request, noUsage)).toBeNull();
    });

    it("skips disabled rules", () => {
      const request = { teamId: "team-1", userId: "u1", userRole: "developer" as const, model: "gpt-4o" };
      const violation = checkRules([rule({ enabled: false, blockedModels: ["gpt-4o"] })], request, noUsage);
      expect(violation).toBeNull();
    });

    it("only applies to the roles a rule names", () => {
      const restricted = rule({ appliesToRoles: ["viewer"], blockedModels: ["gpt-4o"] });
      const developer = { teamId: "team-1", userId: "u1", userRole: "developer" as const, model: "gpt-4o" };
      const viewer = { ...developer, userRole: "viewer" as const };
      expect(checkRules([restricted], developer, noUsage)).toBeNull();
      expect(checkRules([restricted], viewer, noUsage)?.type).toBe("model_blocked");
    });

    it("treats an empty role list as applying to every role", () => {
      const open = rule({ appliesToRoles: [], blockedModels: ["gpt-4o"] });
      const viewer = { teamId: "team-1", userId: "u1", userRole: "viewer" as const, model: "gpt-4o" };
      expect(checkRules([open], viewer, noUsage)?.type).toBe("model_blocked");
    });

    it("rejects a model outside a rule's allowlist", () => {
      const violation = checkAgainstRule(
        rule({ allowedModels: ["gpt-4o"] }),
        { teamId: "team-1", userId: "u1", userRole: "developer", model: "claude-sonnet-4" },
        noUsage,
      );
      expect(violation?.type).toBe("model_not_allowed");
    });

    it("rejects a blocked model", () => {
      const violation = checkAgainstRule(
        rule({ blockedModels: ["claude-sonnet-4"] }),
        { teamId: "team-1", userId: "u1", userRole: "developer", model: "claude-sonnet-4" },
        noUsage,
      );
      expect(violation?.type).toBe("model_blocked");
    });

    it("enforces the hourly request limit at the boundary", () => {
      const limited = rule({ maxRequestsPerUserPerHour: 3 });
      const request = { teamId: "team-1", userId: "u1", userRole: "developer" as const, model: "gpt-4o" };
      // 计数 2 时还有余量；计数达到 3 时下一次请求应当被拒。
      expect(checkAgainstRule(limited, request, { ...noUsage, requestsThisHour: 2 })).toBeNull();
      expect(checkAgainstRule(limited, request, { ...noUsage, requestsThisHour: 3 })?.type).toBe("rate_limit_exceeded");
    });

    it("enforces the hourly team request limit", () => {
      const violation = checkAgainstRule(
        rule({ maxRequestsPerTeamPerHour: 10 }),
        { teamId: "team-1", userId: "u1", userRole: "developer", model: "gpt-4o" },
        { ...noUsage, teamRequestsThisHour: 10 },
      );
      expect(violation?.type).toBe("rate_limit_exceeded");
      expect(violation?.details?.scope).toBe("team");
    });

    it("enforces per-request input and output token limits", () => {
      const request = { teamId: "team-1", userId: "u1", userRole: "developer" as const, model: "gpt-4o" };
      const inputViolation = checkAgainstRule(
        rule({ maxInputTokensPerRequest: 100 }),
        { ...request, estimatedInputTokens: 101 },
        noUsage,
      );
      expect(inputViolation?.type).toBe("token_limit_exceeded");
      const outputViolation = checkAgainstRule(
        rule({ maxOutputTokensPerRequest: 100 }),
        { ...request, estimatedOutputTokens: 101 },
        noUsage,
      );
      expect(outputViolation?.type).toBe("token_limit_exceeded");
      // 未提供估算值时无法判定，不应误伤
      expect(checkAgainstRule(rule({ maxInputTokensPerRequest: 100 }), request, noUsage)).toBeNull();
    });

    it("enforces the daily token quota including the estimated request", () => {
      const violation = checkAgainstRule(
        rule({ maxTotalTokensPerUserPerDay: 1000n }),
        { teamId: "team-1", userId: "u1", userRole: "developer", model: "gpt-4o", estimatedInputTokens: 400, estimatedOutputTokens: 400 },
        { ...noUsage, tokensToday: 300n },
      );
      expect(violation?.type).toBe("token_limit_exceeded");
      // 恰好等于上限不算超限
      expect(checkAgainstRule(
        rule({ maxTotalTokensPerUserPerDay: 1000n }),
        { teamId: "team-1", userId: "u1", userRole: "developer", model: "gpt-4o", estimatedInputTokens: 400, estimatedOutputTokens: 400 },
        { ...noUsage, tokensToday: 200n },
      )).toBeNull();
    });

    it("reports the highest-priority rule first", () => {
      const low = rule({ id: "low", priority: 1, blockedModels: ["gpt-4o"] });
      const high = rule({ id: "high", priority: 50, maxRequestsPerUserPerHour: 1 });
      const violation = checkRules(
        [low, high],
        { teamId: "team-1", userId: "u1", userRole: "developer", model: "gpt-4o" },
        { ...noUsage, requestsThisHour: 5 },
      );
      expect(violation?.ruleId).toBe("high");
    });

    it("requires every rule to pass — hitting any one rejects", () => {
      const permissive = rule({ id: "permissive", priority: 10 });
      const restrictive = rule({ id: "restrictive", priority: 5, blockedModels: ["gpt-4o"] });
      const violation = checkRules(
        [permissive, restrictive],
        { teamId: "team-1", userId: "u1", userRole: "developer", model: "gpt-4o" },
        noUsage,
      );
      expect(violation?.ruleId).toBe("restrictive");
    });
  });

  describe("rule management", () => {
    it("lets an owner create, read, update, and delete a rule", async () => {
      now += 60_000;
      const { owner, team } = await addDeveloper("rule-crud");
      const created = await service.createPolicyRule(owner, team.id, {
        ruleName: "Limit developers",
        blockedModels: ["claude-sonnet-4"],
        maxRequestsPerUserPerHour: 20,
        appliesToRoles: ["developer"],
        priority: 30,
      });
      expect(created.ruleName).toBe("Limit developers");
      expect(created.blockedModels).toEqual(["claude-sonnet-4"]);
      expect(created.maxRequestsPerUserPerHour).toBe(20);
      expect(created.appliesToRoles).toEqual(["developer"]);
      expect(created.enabled).toBe(true);

      const listed = await service.listPolicyRules(owner, team.id);
      expect(listed.map((item) => item.id)).toContain(created.id);

      const updated = await service.updatePolicyRule(owner, team.id, created.id, { maxRequestsPerUserPerHour: 5 });
      expect(updated.maxRequestsPerUserPerHour).toBe(5);

      await service.deletePolicyRule(owner, team.id, created.id);
      expect((await service.listPolicyRules(owner, team.id)).map((item) => item.id)).not.toContain(created.id);
    });

    it("keeps rule management to owners and admins", async () => {
      now += 60_000;
      const { owner, team, developer } = await addDeveloper("rule-roles");
      await expect(service.createPolicyRule(developer, team.id, { ruleName: "nope" }))
        .rejects.toMatchObject({ status: 403 });
      // 成员可以读规则：需要知道自己受哪些约束
      expect(await service.listPolicyRules(developer, team.id)).toEqual([]);
    });

    it("rejects invalid rule content", async () => {
      now += 60_000;
      const { owner, team } = await addDeveloper("rule-validation");
      await expect(service.createPolicyRule(owner, team.id, { ruleName: "" })).rejects.toMatchObject({ status: 400 });
      await expect(service.createPolicyRule(owner, team.id, { ruleName: "x", maxRequestsPerUserPerHour: 0 }))
        .rejects.toMatchObject({ status: 400 });
      await expect(service.createPolicyRule(owner, team.id, { ruleName: "x", maxRequestsPerUserPerHour: 1.5 }))
        .rejects.toMatchObject({ status: 400 });
      await expect(service.createPolicyRule(owner, team.id, { ruleName: "x", appliesToRoles: ["wizard"] }))
        .rejects.toMatchObject({ status: 400 });
      await expect(service.createPolicyRule(owner, team.id, { ruleName: "x", priority: 5000 }))
        .rejects.toMatchObject({ status: 400 });
      await expect(service.createPolicyRule(owner, team.id, { ruleName: "x", blockedModels: ["not a model!"] }))
        .rejects.toMatchObject({ status: 400 });
    });

    it("enables and disables rules in bulk", async () => {
      now += 60_000;
      const { owner, team } = await addDeveloper("rule-bulk");
      const first = await service.createPolicyRule(owner, team.id, { ruleName: "A" });
      const second = await service.createPolicyRule(owner, team.id, { ruleName: "B" });
      await service.setPolicyRulesEnabled(owner, team.id, [first.id, second.id], false);
      const disabled = await service.listPolicyRules(owner, team.id);
      expect(disabled.every((item) => item.enabled === false)).toBe(true);
      await service.setPolicyRulesEnabled(owner, team.id, [first.id], true);
      const mixed = await service.listPolicyRules(owner, team.id);
      expect(mixed.find((item) => item.id === first.id)?.enabled).toBe(true);
      expect(mixed.find((item) => item.id === second.id)?.enabled).toBe(false);
    });
  });

  describe("enforcement in the worker", () => {
    it("blocks a model that a rule forbids and records the violation", async () => {
      now += 60_000;
      const { owner, team, developer } = await addDeveloper("rule-worker-block");
      await service.saveModelConfig(owner, team.id, { model: "gpt-4o", apiKey: "sk-rule-secret-1234" });
      await service.createPolicyRule(owner, team.id, {
        ruleName: "No claude",
        blockedModels: ["claude-sonnet-4"],
        appliesToRoles: ["developer"],
      });

      const bot = await service.createBot(owner, team.id, { name: "Rule bot" });
      const conversation = await service.createConversation(owner, team.id, { botId: bot.id, title: "Rule thread", visibility: "team" });

      let calls = 0;
      const worker = new TeamWorker(config, store, {
        fetch: async () => {
          calls += 1;
          return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
        },
      });

      // 成员把模型选成被禁用的那个
      await service.saveMemberModel(developer, team.id, "claude-sonnet-4");
      await service.postMessage(developer, team.id, conversation.id, "use claude");

      expect(await worker.runOnce()).toBe(true);
      expect(calls).toBe(0);

      const violations = await service.listPolicyViolations(owner, team.id);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]?.violationType).toBe("model_blocked");
      expect(violations[0]?.userEmail).toBe(developer.email);
    });

    it("lets a request through when no rule forbids it", async () => {
      now += 60_000;
      const { owner, team, developer } = await addDeveloper("rule-worker-pass");
      await service.saveModelConfig(owner, team.id, { model: "gpt-4o", apiKey: "sk-rule-pass-1234" });
      await service.createPolicyRule(owner, team.id, { ruleName: "No claude", blockedModels: ["claude-sonnet-4"] });

      const bot = await service.createBot(owner, team.id, { name: "Rule bot" });
      const conversation = await service.createConversation(owner, team.id, { botId: bot.id, title: "Rule thread", visibility: "team" });

      let calls = 0;
      const worker = new TeamWorker(config, store, {
        fetch: async () => {
          calls += 1;
          return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
        },
      });

      await service.postMessage(developer, team.id, conversation.id, "use gpt");
      expect(await worker.runOnce()).toBe(true);
      expect(calls).toBe(1);
      expect(await service.listPolicyViolations(owner, team.id)).toEqual([]);
    });

    it("blocks a request that exceeds the hourly limit", async () => {
      now += 60_000;
      const { owner, team, developer } = await addDeveloper("rule-worker-rate");
      await service.saveModelConfig(owner, team.id, { model: "gpt-4o", apiKey: "sk-rule-rate-1234" });
      await service.createPolicyRule(owner, team.id, {
        ruleName: "Slow down",
        maxRequestsPerUserPerHour: 1,
        appliesToRoles: ["developer"],
      });

      const bot = await service.createBot(owner, team.id, { name: "Rule bot" });
      const conversation = await service.createConversation(owner, team.id, { botId: bot.id, title: "Rule thread", visibility: "team" });

      let calls = 0;
      const worker = new TeamWorker(config, store, {
        fetch: async () => {
          calls += 1;
          return new Response(JSON.stringify({
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }), { status: 200 });
        },
      });

      // 第一次请求成功，并被记入用量
      await service.postMessage(developer, team.id, conversation.id, "first");
      expect(await worker.runOnce()).toBe(true);
      expect(calls).toBe(1);

      // 第二次应当被速率限制拦下
      await service.postMessage(developer, team.id, conversation.id, "second");
      expect(await worker.runOnce()).toBe(true);
      expect(calls).toBe(1);

      const violations = await service.listPolicyViolations(owner, team.id);
      expect(violations.some((item) => item.violationType === "rate_limit_exceeded")).toBe(true);
    });

    it("combines the baseline allowlist with an overlay rule", async () => {
      now += 60_000;
      const { owner, team, developer } = await addDeveloper("rule-worker-both");
      await service.saveModelConfig(owner, team.id, { model: "gpt-4o", apiKey: "sk-rule-both-1234" });
      // 基线：只有 gpt-4o 和 gpt-4o-mini 可选
      await service.saveModelPolicy(owner, team.id, { mode: "allowlist", allowedModels: ["gpt-4o", "gpt-4o-mini"] });
      // 叠加层：进一步禁掉 gpt-4o-mini
      await service.createPolicyRule(owner, team.id, { ruleName: "No mini", blockedModels: ["gpt-4o-mini"] });

      const bot = await service.createBot(owner, team.id, { name: "Rule bot" });
      const conversation = await service.createConversation(owner, team.id, { botId: bot.id, title: "Rule thread", visibility: "team" });

      let model = "";
      const worker = new TeamWorker(config, store, {
        fetch: async (_input, init) => {
          model = JSON.parse(String(init?.body ?? "{}")).model;
          return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
        },
      });

      await service.saveMemberModel(developer, team.id, "gpt-4o-mini");
      await service.postMessage(developer, team.id, conversation.id, "hi");
      expect(await worker.runOnce()).toBe(true);
      // 叠加层命中，模型调用没有发生
      expect(model).toBe("");
    });
  });
});
