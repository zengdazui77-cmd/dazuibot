import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { Config } from "../src/config.js";
import { PGlitePool } from "../src/pglite-pool.js";
import { PolicyMonitor } from "../src/policy-monitoring.js";
import { getTemplateById, getTemplatesByCategory, listAllTemplates } from "../src/policy-templates.js";
import { recordPolicyUsage, recordPolicyViolation, usageBuckets } from "../src/policy-rules.js";
import { TeamService } from "../src/service.js";
import { Store } from "../src/store.js";

const pool = new PGlitePool() as unknown as Pool;

const config: Config = {
  host: "127.0.0.1", port: 0, databaseUrl: "postgres://unused",
  sessionSecret: "test-session-secret-is-long-enough-32-bytes",
  credentialSecret: "test-credential-secret-is-long-enough-32-bytes",
  modelBaseUrl: "https://models.example.test/v1",
  modelCatalog: ["gpt-4o", "gpt-4o-mini"],
  publicUrl: "http://127.0.0.1:8787", mailFrom: "test@example.com", smtpUrl: "",
  codeExecutorUrl: "", codeExecutorBrokerUrl: "http://127.0.0.1:8787", codeExecutorSecret: "", codeExecutorPollMs: 250,
  corsOrigins: new Set(), allowDevCodes: true, production: false,
};

let now = Date.parse("2026-12-05T10:30:00Z");
const store = new Store(config, pool);
const service = new TeamService(config, store, undefined, { now: () => now, makeCode: () => "123456" });

async function signIn(email: string) {
  // 同一个邮箱 60 秒内只能要一次验证码；测试里每次都用不同的邮箱，
  // 但最后一个用例要复用 owner-quota，所以先把时钟往前拨。
  const challenge = await service.requestLoginCode(email);
  return service.createSession(email, challenge.developmentCode!);
}

async function setupTeam(slug: string) {
  const owner = await service.authenticate((await signIn(`owner-${slug}@example.com`)).token);
  const team = await service.createTeam(owner, "Monitor team");
  const invite = await service.createInvitation(owner, team.id, `dev-${slug}@example.com`, "developer");
  const token = new URL(invite.invitation.inviteUrl!).searchParams.get("token")!;
  const developer = await service.authenticate((await signIn(`dev-${slug}@example.com`)).token);
  await service.acceptInvitation(developer, token);
  return { owner, team, developer };
}

describe("policy monitoring", () => {
  beforeAll(async () => { await store.migrate(); });
  afterAll(async () => { await store.close(); });

  it("raises a warning when many violations land in one hour", async () => {
    const { team, owner } = await setupTeam("violations");
    const client = await pool.connect();
    try {
      for (let i = 0; i < 21; i += 1) {
        await recordPolicyViolation(client, { type: "model_blocked", message: "blocked" }, team.id, owner.userId, "gpt-4o", now);
      }
      const alerts = await new PolicyMonitor(() => now).checkAlerts(client, team.id);
      const rate = alerts.find((a) => a.type === "high_violation_rate");
      expect(rate).toBeDefined();
      expect(rate!.severity).toBe("warning");
      expect(rate!.details.count).toBe(21);
    } finally { client.release(); }
  });

  it("raises a critical alert past the high threshold", async () => {
    const { team, owner } = await setupTeam("critical");
    const client = await pool.connect();
    try {
      for (let i = 0; i < 51; i += 1) {
        await recordPolicyViolation(client, { type: "rate_limit_exceeded", message: "too fast" }, team.id, owner.userId, "gpt-4o", now);
      }
      const alerts = await new PolicyMonitor(() => now).checkAlerts(client, team.id);
      const rate = alerts.find((a) => a.type === "high_violation_rate");
      expect(rate!.severity).toBe("critical");
      // 速率限制类违规也要单独出一条告警
      expect(alerts.some((a) => a.type === "rate_limit_spike")).toBe(true);
    } finally { client.release(); }
  });

  it("warns when a member nears their daily token quota", async () => {
    const { team, owner, developer } = await setupTeam("quota");
    await service.createPolicyRule(owner, team.id, {
      ruleName: "daily quota",
      maxTotalTokensPerUserPerDay: "1000",
      appliesToRoles: ["developer"],
    });
    const client = await pool.connect();
    try {
      // 用掉 850 个 token —— 超过 80% 但不到 95%
      await recordPolicyUsage(client, team.id, developer.userId, "gpt-4o", 500, 350, now);
      const alerts = await new PolicyMonitor(() => now).checkAlerts(client, team.id);
      const quota = alerts.find((a) => a.type === "quota_approaching");
      expect(quota).toBeDefined();
      expect(quota!.severity).toBe("warning");
      expect(quota!.details.percentage).toBe(85);
    } finally { client.release(); }
  });

  it("reports a blocked model that is still being requested", async () => {
    const { team, owner } = await setupTeam("blocked");
    const client = await pool.connect();
    try {
      for (let i = 0; i < 6; i += 1) {
        await recordPolicyViolation(client, { type: "model_blocked", message: "blocked" }, team.id, owner.userId, "gpt-3.5", now);
      }
      const alerts = await new PolicyMonitor(() => now).checkAlerts(client, team.id);
      const blocked = alerts.find((a) => a.type === "blocked_model_requested");
      expect(blocked).toBeDefined();
      expect(blocked!.details.model).toBe("gpt-3.5");
      expect(blocked!.severity).toBe("info");
    } finally { client.release(); }
  });

  it("aggregates usage metrics by model and by user", async () => {
    const { team, developer } = await setupTeam("metrics");
    const client = await pool.connect();
    try {
      await recordPolicyUsage(client, team.id, developer.userId, "gpt-4o", 100, 50, now);
      await recordPolicyUsage(client, team.id, developer.userId, "gpt-4o", 100, 50, now);
      await recordPolicyUsage(client, team.id, developer.userId, "gpt-4o-mini", 10, 5, now);
      const metrics = await new PolicyMonitor(() => now).getUsageMetrics(client, team.id, "hour");
      expect(metrics.totalRequests).toBe(3);
      expect(metrics.topModels[0]).toEqual({ model: "gpt-4o", count: 2 });
      expect(metrics.topUsers[0]!.userEmail).toBe("dev-metrics@example.com");
      expect(metrics.topUsers[0]!.requests).toBe(3);
    } finally { client.release(); }
  });

  it("does not count usage from before the period", async () => {
    const { team, developer } = await setupTeam("period");
    const client = await pool.connect();
    try {
      await recordPolicyUsage(client, team.id, developer.userId, "gpt-4o", 100, 50, now - 3 * 60 * 60 * 1000);
      const metrics = await new PolicyMonitor(() => now).getUsageMetrics(client, team.id, "hour");
      expect(metrics.totalRequests).toBe(0);
      const dayMetrics = await new PolicyMonitor(() => now).getUsageMetrics(client, team.id, "day");
      expect(dayMetrics.totalRequests).toBe(1);
    } finally { client.release(); }
  });

  it("exposes alerts and metrics through the service", async () => {
    const { owner, team } = await setupTeam("service");
    const alerts = await service.listPolicyAlerts(owner, team.id);
    expect(Array.isArray(alerts)).toBe(true);
    const metrics = await service.getPolicyUsageMetrics(owner, team.id, "hour");
    expect(metrics.teamId).toBe(team.id);
    expect(metrics.period).toBe("hour");
  });

  it("only lets members see their own alerts", async () => {
    const { owner, team, developer } = await setupTeam("scope");
    const client = await pool.connect();
    try {
      await recordPolicyViolation(client, { type: "model_blocked", message: "blocked" }, team.id, owner.userId, "gpt-4o", now);
      const developerAlerts = await service.listPolicyAlerts(developer, team.id);
      expect(developerAlerts.every((a) => a.details.userId === undefined || a.details.userId === developer.userId)).toBe(true);
    } finally { client.release(); }
  });
});

describe("policy templates", () => {
  it("exposes ready-to-use templates", () => {
    const all = listAllTemplates();
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((t) => t.name && t.description && t.config)).toBe(true);
  });

  it("filters by category and looks up by id", () => {
    const security = getTemplatesByCategory("security");
    expect(security.length).toBeGreaterThan(0);
    expect(security.every((t) => t.category === "security")).toBe(true);
    expect(getTemplateById("strict-rate-limit")?.config.maxRequestsPerUserPerHour).toBe(10);
    expect(getTemplateById("does-not-exist")).toBeUndefined();
  });

  it("produces buckets that align with the usage table", () => {
    const { hourBucket, dayBucket } = usageBuckets(now);
    expect(dayBucket).toBe("2026-12-05");
    expect(hourBucket.getMinutes()).toBe(0);
  });
});
