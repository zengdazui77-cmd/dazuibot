import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import type { Config } from "../src/config.js";
import { createTeamHttpServer } from "../src/http.js";
import { decryptCredential, encryptCredential } from "../src/credentials.js";
import { PGlitePool } from "../src/pglite-pool.js";
import { TeamService } from "../src/service.js";
import { Store } from "../src/store.js";
import { TeamWorker } from "../src/worker.js";
import { CodeTaskDispatcher, executorSignature } from "../src/code-executor.js";

// 默认走真正的 PGlite 连接池：和内嵌模式跑的是同一条代码路径。
// 设置 TEAM_TEST_DATABASE_URL 后改连真实 PostgreSQL，用来验证两边行为一致。
const postgresUrl = process.env.TEAM_TEST_DATABASE_URL;
// 真实 pg 上每个测试文件用独立 schema，避免并行运行时互相 DROP 对方的表。
const SCHEMA = "dz_main_suite";
// 用一条独立的 admin 连接先建好 schema，再让业务连接带着 search_path 进来。
async function prepareSchema(): Promise<void> {
  if (!postgresUrl) return;
  const admin = new Pool({ connectionString: postgresUrl, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  } finally {
    await admin.end();
  }
}
const pool = (postgresUrl
  ? new Pool({
    connectionString: `${postgresUrl}${postgresUrl.includes("?") ? "&" : "?"}options=-c%20search_path%3D${SCHEMA}`,
    max: 8,
    connectionTimeoutMillis: 5_000,
  })
  : new PGlitePool()) as unknown as Pool;
const config: Config = {
  host: "127.0.0.1", port: 0, databaseUrl: postgresUrl ?? "postgres://unused", sessionSecret: "test-session-secret-is-long-enough-32-bytes",
  credentialSecret: "test-credential-secret-is-long-enough-32-bytes", modelBaseUrl: "https://models.example.test/v1",
  modelCatalog: ["gpt-4o", "gpt-4o-mini", "claude-sonnet-4"],
  publicUrl: "http://127.0.0.1:8787", mailFrom: "test@example.com", smtpUrl: "", codeExecutorUrl: "", codeExecutorBrokerUrl: "http://127.0.0.1:8787", codeExecutorSecret: "", codeExecutorPollMs: 250, corsOrigins: new Set(), allowDevCodes: true, production: false,
};
let now = Date.parse("2026-11-10T00:00:00Z");
const store = new Store(config, pool);
const service = new TeamService(config, store, undefined, { now: () => now, makeCode: () => "123456" });

async function signIn(email: string) {
  const challenge = await service.requestLoginCode(email);
  expect(challenge.developmentCode).toBe("123456");
  return service.createSession(email, challenge.developmentCode);
}

async function expectDeniedAfterTransactionBoundary(teamId: string, actorId: string, action: () => Promise<unknown>): Promise<void> {
  const transaction = store.transaction.bind(store);
  let revokeBeforeTransaction = true;
  const transactionSpy = vi.spyOn(store, "transaction").mockImplementation(async (callback) => {
    if (revokeBeforeTransaction) {
      revokeBeforeTransaction = false;
      await store.pool.query("UPDATE team_memberships SET role='viewer' WHERE team_id=$1 AND user_id=$2", [teamId, actorId]);
    }
    return transaction(callback);
  });
  try {
    await expect(action()).rejects.toMatchObject({ status: 403 });
  } finally {
    transactionSpy.mockRestore();
    await store.pool.query("UPDATE team_memberships SET role='admin' WHERE team_id=$1 AND user_id=$2", [teamId, actorId]);
  }
}

describe("cloud team identity and invitations", () => {
  beforeAll(async () => {
    // 真实 pg 上先清空本文件专属的 schema，保证迁移可以从零开始、且不受上次运行残留影响
    await prepareSchema();
    await store.migrate();
  });
  afterAll(async () => { await store.close(); });

  it("supports personal email login, one-time invites, team roles, and audit events", async () => {
    await store.migrate();
    const migrations = await store.pool.query<{ version: string }>("SELECT version FROM team_schema_migrations ORDER BY version");
    expect(migrations.rows.map((row) => row.version)).toEqual(["001_initial.sql", "002_shared_workspace.sql", "003_projects.sql", "004_usage.sql", "005_git_credentials.sql", "006_auth_retention.sql", "007_code_tasks.sql", "008_code_executor.sql", "009_executor_heartbeats.sql", "010_executor_capabilities.sql", "011_model_policy.sql", "012_model_policy_default_all.sql", "013_policy_rules.sql"]);
    const ownerSession = await signIn(" OWNER@example.com ");
    expect(ownerSession.user.email).toBe("owner@example.com");
    const owner = await service.authenticate(ownerSession.token);
    const team = await service.createTeam(owner, "Engineering");
    expect(team.role).toBe("owner");

    const created = await service.createInvitation(owner, team.id, "dev@example.com", "developer");
    expect(created.emailSent).toBe(false);
    expect(created.invitation.inviteUrl).toContain("/invite?token=");
    const token = new URL(created.invitation.inviteUrl!).searchParams.get("token");
    expect(token).toBeTruthy();

    const developerSession = await signIn("dev@example.com");
    const developer = await service.authenticate(developerSession.token);
    const joined = await service.acceptInvitation(developer, token);
    expect(joined.id).toBe(team.id);
    expect(joined.role).toBe("developer");
    await expect(service.acceptInvitation(developer, token)).rejects.toMatchObject({ status: 410 });
    await expect(service.createInvitation(developer, team.id, "another@example.com", "viewer")).rejects.toMatchObject({ status: 403 });
    await expect(service.listInvitations(developer, team.id)).rejects.toMatchObject({ status: 403 });
    expect(await service.listMembers(developer, team.id)).toHaveLength(2);

    const otherSession = await signIn("other@example.com");
    const other = await service.authenticate(otherSession.token);
    const otherTeam = await service.createTeam(other, "Private");
    await expect(service.requireMembership(developer, otherTeam.id)).rejects.toMatchObject({ status: 404 });

    const events = await store.pool.query<{ action: string }>("SELECT action FROM team_audit_events WHERE team_id=$1 ORDER BY created_at", [team.id]);
    expect(events.rows.map((row) => row.action)).toEqual(["team.created", "invitation.created", "invitation.accepted"]);
  });

  it("binds an invite to the invited email and prevents removing the final owner", async () => {
    now += 60_000;
    const ownerSession = await signIn("owner@example.com");
    const owner = await service.authenticate(ownerSession.token);
    const team = (await service.listTeams(owner))[0]!;
    const invite = await service.createInvitation(owner, team.id, "wanted@example.com", "viewer");
    const token = new URL(invite.invitation.inviteUrl!).searchParams.get("token")!;
    const wrongSession = await signIn("wrong@example.com");
    await expect(service.acceptInvitation(await service.authenticate(wrongSession.token), token)).rejects.toMatchObject({ status: 403 });
    const targetSession = await signIn("wanted@example.com");
    const target = await service.authenticate(targetSession.token);
    await service.acceptInvitation(target, token);
    await expect(service.removeMember(owner, team.id, owner.userId)).rejects.toMatchObject({ status: 400 });
  });

  it("rechecks admin authority inside the transaction for invitation and member mutations", async () => {
    now += 60_000;
    const owner = await service.authenticate((await signIn("role-race-owner@example.com")).token);
    const team = await service.createTeam(owner, "Role race team");
    const adminInvite = await service.createInvitation(owner, team.id, "role-race-admin@example.com", "admin");
    const adminToken = new URL(adminInvite.invitation.inviteUrl!).searchParams.get("token")!;
    const admin = await service.authenticate((await signIn("role-race-admin@example.com")).token);
    await service.acceptInvitation(admin, adminToken);
    const developerInvite = await service.createInvitation(owner, team.id, "role-race-developer@example.com", "developer");
    const developerToken = new URL(developerInvite.invitation.inviteUrl!).searchParams.get("token")!;
    const developer = await service.authenticate((await signIn("role-race-developer@example.com")).token);
    await service.acceptInvitation(developer, developerToken);
    const revokeTarget = await service.createInvitation(owner, team.id, "role-race-pending@example.com", "viewer");

    await expectDeniedAfterTransactionBoundary(team.id, admin.userId, () => service.createInvitation(admin, team.id, "role-race-new@example.com", "viewer"));
    await expectDeniedAfterTransactionBoundary(team.id, admin.userId, () => service.revokeInvitation(admin, team.id, revokeTarget.invitation.id));
    await expectDeniedAfterTransactionBoundary(team.id, admin.userId, () => service.updateMemberRole(admin, team.id, developer.userId, "viewer"));
    await expectDeniedAfterTransactionBoundary(team.id, admin.userId, () => service.removeMember(admin, team.id, developer.userId));

    expect((await service.listMembers(owner, team.id)).find((member) => member.userId === developer.userId)?.role).toBe("developer");
    expect((await service.listInvitations(owner, team.id)).some((invitation) => invitation.id === revokeTarget.invitation.id)).toBe(true);
  });

  it("expires invitations and revokes member sessions without exposing raw session tokens in storage", async () => {
    now += 60_000;
    const ownerSession = await signIn("owner@example.com");
    const owner = await service.authenticate(ownerSession.token);
    const team = (await service.listTeams(owner))[0]!;
    const invite = await service.createInvitation(owner, team.id, "expired@example.com", "viewer");
    const token = new URL(invite.invitation.inviteUrl!).searchParams.get("token")!;
    now += 8 * 24 * 60 * 60_000;
    const expiredUser = await signIn("expired@example.com");
    await expect(service.acceptInvitation(await service.authenticate(expiredUser.token), token)).rejects.toMatchObject({ status: 410 });
    await service.revokeSession(ownerSession.token);
    await expect(service.authenticate(ownerSession.token)).rejects.toMatchObject({ status: 401 });
    const stored = await store.pool.query<{ token_digest: string }>("SELECT token_digest FROM team_sessions");
    expect(stored.rows.every((row) => row.token_digest !== ownerSession.token)).toBe(true);
  });

  it("allows only the owner to permanently delete a confirmed team and cascades its data", async () => {
    now += 60_000;
    const owner = await service.authenticate((await signIn("delete-owner@example.com")).token);
    const team = await service.createTeam(owner, "Delete me");
    await service.saveModelConfig(owner, team.id, { model: "team-model", apiKey: "delete-model-secret" });
    const bot = await service.createBot(owner, team.id, { name: "Delete bot" });
    const conversation = await service.createConversation(owner, team.id, { botId: bot.id, title: "Delete history", visibility: "team" });
    await service.postMessage(owner, team.id, conversation.id, "Delete this message too");
    await service.createProject(owner, team.id, { name: "Delete repo", repositoryUrl: "https://github.com/acme/delete-repo", defaultBranch: "main" });
    await service.saveGitCredential(owner, team.id, "github", "github_pat_delete_1234");
    const invitation = await service.createInvitation(owner, team.id, "delete-dev@example.com", "developer");
    const inviteToken = new URL(invitation.invitation.inviteUrl!).searchParams.get("token")!;
    const developer = await service.authenticate((await signIn("delete-dev@example.com")).token);
    await service.acceptInvitation(developer, inviteToken);

    await expect(service.deleteTeam(developer, team.id, team.name)).rejects.toMatchObject({ status: 403 });
    await expect(service.deleteTeam(owner, team.id, "Wrong name")).rejects.toMatchObject({ status: 409 });
    await service.deleteTeam(owner, team.id, team.name);

    expect((await service.listTeams(owner)).some((item) => item.id === team.id)).toBe(false);
    for (const table of ["team_memberships", "team_invitations", "team_audit_events", "team_bots", "team_conversations", "team_messages", "team_jobs", "team_model_credentials", "team_projects", "team_git_credentials"]) {
      const result = table === "team_messages"
        ? await store.pool.query("SELECT 1 FROM team_messages m JOIN team_conversations c ON c.id=m.conversation_id WHERE c.team_id=$1", [team.id])
        : await store.pool.query(`SELECT 1 FROM ${table} WHERE team_id=$1`, [team.id]);
      expect(result.rowCount, `${table} should be removed`).toBe(0);
    }
  });

  it("lets members leave, cancels their jobs, and requires an owner transfer first", async () => {
    now += 60_000;
    const owner = await service.authenticate((await signIn("leave-owner@example.com")).token);
    const team = await service.createTeam(owner, "Leaving team");
    await service.saveModelConfig(owner, team.id, { model: "team-model", apiKey: "sk-leave-key-1234" });
    const bot = await service.createBot(owner, team.id, { name: "Leave bot" });
    const conversation = await service.createConversation(owner, team.id, { botId: bot.id, title: "Leaving", visibility: "team" });
    const invite = await service.createInvitation(owner, team.id, "leave-dev@example.com", "developer");
    const token = new URL(invite.invitation.inviteUrl!).searchParams.get("token")!;
    const developer = await service.authenticate((await signIn("leave-dev@example.com")).token);
    await service.acceptInvitation(developer, token);
    const pending = await service.postMessage(developer, team.id, conversation.id, "Cancel after leaving");

    await expect(service.leaveTeam(owner, team.id)).rejects.toMatchObject({ status: 409 });
    await service.leaveTeam(developer, team.id);
    expect((await service.listJobs(owner, team.id, conversation.id)).find((job) => job.id === pending.job.id)?.status).toBe("cancelled");
    await expect(service.requireMembership(developer, team.id)).rejects.toMatchObject({ status: 404 });
    expect((await service.listConversations(owner, team.id)).some((item) => item.id === conversation.id)).toBe(true);

    const successorInvite = await service.createInvitation(owner, team.id, "leave-successor@example.com", "developer");
    const successorToken = new URL(successorInvite.invitation.inviteUrl!).searchParams.get("token")!;
    const successor = await service.authenticate((await signIn("leave-successor@example.com")).token);
    await service.acceptInvitation(successor, successorToken);
    await service.updateMemberRole(owner, team.id, successor.userId, "owner");
    await service.leaveTeam(owner, team.id);
    await expect(service.requireMembership(owner, team.id)).rejects.toMatchObject({ status: 404 });
    expect(await service.listConversations(successor, team.id)).toHaveLength(1);
    const audit = await store.pool.query<{ action: string }>("SELECT action FROM team_audit_events WHERE team_id=$1 ORDER BY created_at", [team.id]);
    expect(audit.rows.map((row) => row.action)).toContain("member.left");
  });

  it("lets only an owner change the role of an owner or another admin", async () => {
    now += 60_000;
    const owner = await service.authenticate((await signIn("rank-owner@example.com")).token);
    const team = await service.createTeam(owner, "Rank team");
    const join = async (email: string, role: "admin" | "developer") => {
      const invite = await service.createInvitation(owner, team.id, email, role);
      const member = await service.authenticate((await signIn(email)).token);
      await service.acceptInvitation(member, new URL(invite.invitation.inviteUrl!).searchParams.get("token")!);
      return member;
    };
    const admin = await join("rank-admin@example.com", "admin");
    const otherAdmin = await join("rank-admin-2@example.com", "admin");
    const coOwner = await join("rank-co-owner@example.com", "developer");
    await service.updateMemberRole(owner, team.id, coOwner.userId, "owner");

    await expect(service.updateMemberRole(admin, team.id, otherAdmin.userId, "viewer")).rejects.toMatchObject({ status: 403 });
    await expect(service.updateMemberRole(admin, team.id, coOwner.userId, "developer")).rejects.toMatchObject({ status: 403 });
    const members = await service.listMembers(owner, team.id);
    expect(members.find((member) => member.userId === otherAdmin.userId)?.role).toBe("admin");
    expect(members.find((member) => member.userId === coOwner.userId)?.role).toBe("owner");
    expect((await service.updateMemberRole(owner, team.id, otherAdmin.userId, "developer")).role).toBe("developer");
  });

  it("authenticates encrypted model credentials and rejects ciphertext tampering", () => {
    const encrypted = encryptCredential(config.credentialSecret, "secret-model-key");
    expect(encryptCredential(config.credentialSecret, "secret-model-key")).not.toBe(encrypted);
    expect(decryptCredential(config.credentialSecret, encrypted)).toBe("secret-model-key");
    const parts = encrypted.split(":");
    parts[3] = `${parts[3]![0] === "A" ? "B" : "A"}${parts[3]!.slice(1)}`;
    expect(() => decryptCredential(config.credentialSecret, parts.join(":"))).toThrow();
  });

  it("persists failed email-code attempts and consumes a challenge after eight failures", async () => {
    now += 60_000;
    await service.requestLoginCode("brute@example.com");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(service.createSession("brute@example.com", "000000")).rejects.toMatchObject({ status: 401 });
    }
    const row = await store.pool.query<{ attempts: number; consumed_at: Date | null }>(
      "SELECT attempts, consumed_at FROM team_email_challenges WHERE email=$1 ORDER BY created_at DESC LIMIT 1",
      ["brute@example.com"],
    );
    expect(row.rows[0]?.attempts).toBe(8);
    expect(row.rows[0]?.consumed_at).toBeTruthy();
    await expect(service.createSession("brute@example.com", "123456")).rejects.toMatchObject({ status: 401 });
  });

  it("removes stale sign-in challenges and expired sessions when issuing a new code", async () => {
    now += 60_000;
    const session = await signIn("retention@example.com");
    const principal = await service.authenticate(session.token);
    const old = new Date(now - 2 * 24 * 60 * 60_000);
    await store.pool.query("INSERT INTO team_email_challenges(id,email,code_digest,expires_at,created_at) VALUES($1,$2,$3,$4,$5)", ["old-retention-challenge", "old@example.com", "digest", old, old]);
    await store.pool.query("UPDATE team_sessions SET expires_at=$2 WHERE user_id=$1", [principal.userId, old]);

    await service.requestLoginCode("cleanup-trigger@example.com");

    const oldChallenges = await store.pool.query("SELECT 1 FROM team_email_challenges WHERE id=$1", ["old-retention-challenge"]);
    const expiredSessions = await store.pool.query("SELECT 1 FROM team_sessions WHERE user_id=$1", [principal.userId]);
    expect(oldChallenges.rowCount).toBe(0);
    expect(expiredSessions.rowCount).toBe(0);
  });

  it("protects the owner role from being removed as the final owner", async () => {
    now += 60_000;
    const ownerSession = await signIn("owner@example.com");
    const owner = await service.authenticate(ownerSession.token);
    const team = (await service.listTeams(owner))[0]!;
    await expect(service.updateMemberRole(owner, team.id, owner.userId, "developer")).rejects.toMatchObject({ status: 409 });
  });

  it("encrypts team Git host credentials and creates reviews only for authorized members", async () => {
    now += 60_000;
    const owner = await service.authenticate((await signIn("review-owner@example.com")).token);
    const team = await service.createTeam(owner, "Code review");
    const invite = await service.createInvitation(owner, team.id, "review-dev@example.com", "developer");
    const developer = await service.authenticate((await signIn("review-dev@example.com")).token);
    await service.acceptInvitation(developer, new URL(invite.invitation.inviteUrl!).searchParams.get("token"));
    const project = await service.createProject(owner, team.id, { name: "App", repositoryUrl: "https://github.com/acme/app", defaultBranch: "main" });
    await expect(service.getGitCredentialStatus(developer, team.id)).resolves.toEqual({ github: { configured: false }, gitlab: { configured: false } });
    await expect(service.saveGitCredential(developer, team.id, "github", "github_pat_secret_1234")).rejects.toMatchObject({ status: 403 });
    await service.saveGitCredential(owner, team.id, "github", "github_pat_secret_1234");
    const stored = await store.pool.query<{ encrypted_token: string }>("SELECT encrypted_token FROM team_git_credentials WHERE team_id=$1 AND provider='github'", [team.id]);
    expect(stored.rows[0]?.encrypted_token).not.toContain("github_pat_secret_1234");
    expect(decryptCredential(config.credentialSecret, stored.rows[0]!.encrypted_token)).toBe("github_pat_secret_1234");

    const calls: Array<{ url: string; authorization: string; payload: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const requestUrl = String(url);
      calls.push({ url: requestUrl, authorization: new Headers(init.headers).get("authorization") ?? new Headers(init.headers).get("private-token") ?? "", payload: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
      if (requestUrl.includes("feature%2Flarge")) return new Response("x".repeat(300 * 1024), { status: 200 });
      if (requestUrl.includes("/compare/")) return new Response("diff --git a/a.txt b/a.txt\n+committed\n", { status: 200 });
      if (requestUrl.includes("/repository/compare")) return new Response(JSON.stringify({ diffs: [{ old_path: "a.txt", new_path: "a.txt", diff: "+committed" }] }), { status: 200 });
      return requestUrl.includes("gitlab.com")
        ? new Response(JSON.stringify({ web_url: "https://gitlab.com/group/sub/app/-/merge_requests/12", iid: 12, state: "opened" }), { status: 201 })
        : new Response(JSON.stringify({ html_url: "https://github.com/acme/app/pull/8", number: 8, state: "open" }), { status: 201 });
    });
    try {
      const review = await service.createProjectReview(developer, team.id, project.id, { head: "feature/team-review", title: "Add review integration", body: "Ready for review." });
      expect(review).toEqual({ url: "https://github.com/acme/app/pull/8", number: 8, title: "Add review integration", state: "open" });
      expect(calls).toEqual([{
        url: "https://api.github.com/repos/acme/app/pulls",
        authorization: "Bearer github_pat_secret_1234",
        payload: { title: "Add review integration", body: "Ready for review.", head: "feature/team-review", base: "main" },
      }]);
      expect(await service.getGitCredentialStatus(developer, team.id)).toEqual({ github: { configured: true }, gitlab: { configured: false } });
      const githubDiff = await service.getProjectDiff(developer, team.id, project.id, "feature/team-review");
      expect(githubDiff).toEqual({ head: "feature/team-review", base: "main", diff: "diff --git a/a.txt b/a.txt\n+committed\n", truncated: false });
      const largeDiff = await service.getProjectDiff(developer, team.id, project.id, "feature/large");
      expect(largeDiff.diff).toHaveLength(256 * 1024);
      expect(largeDiff.truncated).toBe(true);
      await expect(service.createProjectReview(developer, team.id, project.id, { head: "../main", title: "Invalid" })).rejects.toMatchObject({ status: 400 });
      const gitlabProject = await service.createProject(owner, team.id, { name: "GitLab App", repositoryUrl: "https://gitlab.com/group/sub/app", defaultBranch: "trunk" });
      await service.saveGitCredential(owner, team.id, "gitlab", "glpat_secret_5678");
      const mergeRequest = await service.createProjectReview(developer, team.id, gitlabProject.id, { head: "feature/review", title: "GitLab review", body: "Ready." });
      expect(mergeRequest).toEqual({ url: "https://gitlab.com/group/sub/app/-/merge_requests/12", number: 12, title: "GitLab review", state: "opened" });
      expect(calls[3]).toEqual({
        url: "https://gitlab.com/api/v4/projects/group%2Fsub%2Fapp/merge_requests",
        authorization: "glpat_secret_5678",
        payload: { title: "GitLab review", description: "Ready.", source_branch: "feature/review", target_branch: "trunk" },
      });
      const gitlabDiff = await service.getProjectDiff(developer, team.id, gitlabProject.id, "feature/review");
      expect(gitlabDiff).toEqual({ head: "feature/review", base: "trunk", diff: "diff -- a.txt -> a.txt\n+committed\n", truncated: false });
      await service.deleteGitCredential(owner, team.id, "github");
      await service.deleteGitCredential(owner, team.id, "gitlab");
      expect(await service.getGitCredentialStatus(developer, team.id)).toEqual({ github: { configured: false }, gitlab: { configured: false } });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shares team bots and team conversations while keeping private conversations and roles isolated", async () => {
    now += 60_000;
    const ownerSession = await signIn("workspace-owner@example.com");
    const owner = await service.authenticate(ownerSession.token);
    const team = await service.createTeam(owner, "Workspace");
    const devInvite = await service.createInvitation(owner, team.id, "workspace-dev@example.com", "developer");
    const devToken = new URL(devInvite.invitation.inviteUrl!).searchParams.get("token")!;
    const developer = await service.authenticate((await signIn("workspace-dev@example.com")).token);
    await service.acceptInvitation(developer, devToken);
    const viewerInvite = await service.createInvitation(owner, team.id, "workspace-viewer@example.com", "viewer");
    const viewerToken = new URL(viewerInvite.invitation.inviteUrl!).searchParams.get("token")!;
    const viewer = await service.authenticate((await signIn("workspace-viewer@example.com")).token);
    await service.acceptInvitation(viewer, viewerToken);
    expect((await service.listAuditEvents(owner, team.id)).some((event) => event.action === "invitation.accepted")).toBe(true);
    await expect(service.listAuditEvents(viewer, team.id)).rejects.toMatchObject({ status: 403 });

    const other = await service.authenticate((await signIn("workspace-outsider@example.com")).token);
    const otherTeam = await service.createTeam(other, "Other workspace");
    expect(await service.getModelConfig(owner, team.id)).toMatchObject({ configured: false, modelBaseUrl: config.modelBaseUrl });
    await expect(service.saveModelConfig(developer, team.id, { model: "test-model", apiKey: "dev-secret-key" })).rejects.toMatchObject({ status: 403 });
    const savedModel = await service.saveModelConfig(owner, team.id, { model: "team-model", apiKey: "sk-team-secret-1234" });
    expect(savedModel).toMatchObject({ configured: true, model: "team-model", keyTail: "1234" });
    expect(await service.getModelConfig(developer, team.id)).toEqual({ configured: true, modelBaseUrl: config.modelBaseUrl, model: "team-model" });
    expect(JSON.stringify(savedModel)).not.toContain("sk-team-secret-1234");
    const storedKey = await store.pool.query<{ encrypted_api_key: string }>("SELECT encrypted_api_key FROM team_model_credentials WHERE team_id=$1", [team.id]);
    expect(storedKey.rows[0]?.encrypted_api_key).not.toContain("sk-team-secret-1234");
    expect(decryptCredential(config.credentialSecret, storedKey.rows[0]!.encrypted_api_key)).toBe("sk-team-secret-1234");
    const bot = await service.createBot(owner, team.id, { name: "Release helper", description: "Shared workflow", instructions: "Never include credentials in the prompt." });
    await expect(service.createBot(developer, team.id, { name: "Unapproved" })).rejects.toMatchObject({ status: 403 });
    expect((await service.listBots(developer, team.id)).map((item) => item.id)).toEqual([bot.id]);
    expect(await service.listBots(other, team.id)).toEqual([]);
    await expect(service.createConversation(developer, otherTeam.id, { botId: bot.id, title: "Cross-team", visibility: "team" })).rejects.toMatchObject({ status: 404 });

    const shared = await service.createConversation(owner, team.id, { botId: bot.id, title: "Release planning", visibility: "team" });
    const modelRequests: Array<{ authorization: string; body: string }> = [];
    const modelFetch: typeof fetch = async (_input, init) => {
      modelRequests.push({ authorization: new Headers(init?.headers).get("authorization") ?? "", body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ choices: [{ message: { content: "I prepared a draft for the team." } }], usage: { prompt_tokens: 120, completion_tokens: 18 } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const worker = new TeamWorker(config, store, { fetch: modelFetch });
    const firstPost = await service.postMessage(owner, team.id, shared.id, "Prepare the release notes");
    expect(firstPost.job.status).toBe("queued");
    expect(await worker.runOnce()).toBe(true);
    expect((await service.listJobs(owner, team.id, shared.id))[0]?.status).toBe("succeeded");
    await service.postMessage(developer, team.id, shared.id, "I will draft them");
    expect(await worker.runOnce()).toBe(true);
    expect(modelRequests).toHaveLength(2);
    expect(modelRequests[0]?.authorization).toBe("Bearer sk-team-secret-1234");
    expect(modelRequests[0]?.body).toContain("team-model");
    expect(modelRequests[0]?.body).not.toContain("sk-team-secret-1234");
    expect(JSON.parse(modelRequests[0]!.body)).not.toHaveProperty("tools");
    expect(await service.getUsage(owner, team.id)).toMatchObject({ scope: "team", successfulJobs: 2, reportedJobs: 2, inputTokens: 240, outputTokens: 36 });
    expect(await service.getUsage(developer, team.id)).toMatchObject({ scope: "member", successfulJobs: 1, reportedJobs: 1, inputTokens: 120, outputTokens: 18, members: [{ email: "workspace-dev@example.com" }] });
    await expect(service.getUsage(other, team.id)).rejects.toMatchObject({ status: 404 });
    expect((await service.listConversations(developer, team.id)).map((item) => item.id)).toContain(shared.id);
    expect((await service.listMessages(developer, team.id, shared.id)).map((item) => item.authorEmail)).toEqual([
      "workspace-owner@example.com", "Dazuibot AI", "workspace-dev@example.com", "Dazuibot AI",
    ]);
    await expect(service.postMessage(viewer, team.id, shared.id, "Should be read-only")).rejects.toMatchObject({ status: 403 });

    await service.postMessage(owner, team.id, shared.id, "Provider did not include usage metadata");
    const unreportedWorker = new TeamWorker(config, store, { fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "Reply without token data." } }] }), { status: 200 }) });
    expect(await unreportedWorker.runOnce()).toBe(true);
    expect(await service.getUsage(owner, team.id)).toMatchObject({ scope: "team", successfulJobs: 3, reportedJobs: 2, inputTokens: 240, outputTokens: 36 });

    const privateConversation = await service.createConversation(owner, team.id, { botId: bot.id, title: "Owner notes", visibility: "private" });
    await service.postMessage(owner, team.id, privateConversation.id, "Private planning detail");
    expect(await worker.runOnce()).toBe(true);
    expect((await service.listConversations(developer, team.id)).map((item) => item.id)).not.toContain(privateConversation.id);
    expect(await service.getUsage(owner, team.id)).toMatchObject({ scope: "team", successfulJobs: 4, reportedJobs: 3, inputTokens: 360, outputTokens: 54 });
    await expect(service.listMessages(developer, team.id, privateConversation.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.postMessage(developer, team.id, privateConversation.id, "Not allowed")).rejects.toMatchObject({ status: 404 });

    const pendingBeforeRemoval = await service.postMessage(developer, team.id, shared.id, "This queued work should be revoked");
    await service.updateMemberRole(owner, team.id, developer.userId, "viewer");
    expect((await service.listJobs(owner, team.id, shared.id)).find((job) => job.id === pendingBeforeRemoval.job.id)?.status).toBe("cancelled");
    expect(await worker.runOnce()).toBe(false);
    await expect(service.postMessage(developer, team.id, shared.id, "Viewer must not post")).rejects.toMatchObject({ status: 403 });
    await service.removeMember(owner, team.id, developer.userId);
    expect((await service.listJobs(owner, team.id, shared.id)).find((job) => job.id === pendingBeforeRemoval.job.id)?.status).toBe("cancelled");
    expect(await worker.runOnce()).toBe(false);
    expect(await service.listBots(developer, team.id)).toEqual([]);
    expect(await service.listConversations(developer, team.id)).toEqual([]);
    const audit = await store.pool.query<{ action: string }>("SELECT action FROM team_audit_events WHERE team_id=$1 ORDER BY created_at", [team.id]);
    expect(audit.rows.map((row) => row.action).sort()).toEqual([
      "team.created", "invitation.created", "invitation.accepted", "invitation.created", "invitation.accepted",
      "model_credentials.updated", "bot.created", "conversation.created", "job.queued", "job.succeeded", "job.queued", "job.succeeded", "job.queued", "job.succeeded",
      "conversation.created", "job.queued", "job.succeeded", "job.queued", "member.role_changed", "member.removed",
    ].sort());
  });

  it("backs off transient model errors and stops retrying after three attempts", async () => {
    now += 60_000;
    const owner = await service.authenticate((await signIn("retry-owner@example.com")).token);
    const team = await service.createTeam(owner, "Retry workspace");
    await service.saveModelConfig(owner, team.id, { model: "team-model", apiKey: "sk-retry-secret-9876" });
    const bot = await service.createBot(owner, team.id, { name: "Retry bot" });
    const conversation = await service.createConversation(owner, team.id, { botId: bot.id, title: "Transient failure", visibility: "team" });
    await service.postMessage(owner, team.id, conversation.id, "Try again safely");
    let requests = 0;
    const worker = new TeamWorker(config, store, {
      // 退避用数据库时钟（写入与比较必须同源），所以这里用很短的退避并真实等待，
      // 而不是用假时钟推进时间——假时钟推不动数据库时钟。
      retryDelayMs: 50,
      fetch: async () => { requests += 1; return new Response("unavailable", { status: 503 }); },
    });
    expect(await worker.runOnce()).toBe(true);
    expect((await service.listJobs(owner, team.id, conversation.id))[0]).toMatchObject({ status: "queued", attemptCount: 1 });
    expect(await worker.runOnce()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await worker.runOnce()).toBe(true);
    expect((await service.listJobs(owner, team.id, conversation.id))[0]).toMatchObject({ status: "queued", attemptCount: 2 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(await worker.runOnce()).toBe(true);
    expect((await service.listJobs(owner, team.id, conversation.id))[0]).toMatchObject({ status: "failed", attemptCount: 3, errorCode: "attempt_limit" });
    expect(requests).toBe(3);
  });

  it("marks exhausted expired leases failed and publishes the conversation update", async () => {
    now += 60_000;
    const owner = await service.authenticate((await signIn("lease-owner@example.com")).token);
    const team = await service.createTeam(owner, "Lease recovery");
    await service.saveModelConfig(owner, team.id, { model: "team-model", apiKey: "sk-lease-secret-1234" });
    const bot = await service.createBot(owner, team.id, { name: "Lease bot" });
    const conversation = await service.createConversation(owner, team.id, { botId: bot.id, title: "Expired lease", visibility: "team" });
    const { job } = await service.postMessage(owner, team.id, conversation.id, "This worker will not finish");
    await store.pool.query(
      "UPDATE team_jobs SET status='running', attempt_count=3, lease_token='expired-lease', lease_until=$2 WHERE id=$1",
      [job.id, new Date(0)],
    );
    const publish = vi.fn();
    const events = { publish } as unknown as import("../src/events.js").TeamEventHub;
    const worker = new TeamWorker(config, store, { events });

    expect(await worker.runOnce()).toBe(false);
    expect((await service.listJobs(owner, team.id, conversation.id))[0]).toMatchObject({ status: "failed", attemptCount: 3, errorCode: "attempt_limit" });
    expect(publish).toHaveBeenCalledWith(conversation.id);
  });

  it("registers GitHub and GitLab projects without accepting unsafe URLs or cross-team access", async () => {
    now += 60_000;
    const owner = await service.authenticate((await signIn("project-owner@example.com")).token);
    const team = await service.createTeam(owner, "Code team");
    const developerInvite = await service.createInvitation(owner, team.id, "project-dev@example.com", "developer");
    const token = new URL(developerInvite.invitation.inviteUrl!).searchParams.get("token")!;
    const developer = await service.authenticate((await signIn("project-dev@example.com")).token);
    await service.acceptInvitation(developer, token);
    const outsider = await service.authenticate((await signIn("project-outsider@example.com")).token);

    const github = await service.createProject(owner, team.id, { name: "Docs", repositoryUrl: "https://github.com/Acme/Docs.git", defaultBranch: "main" });
    expect(github).toMatchObject({ provider: "github", repositoryUrl: "https://github.com/acme/docs", cloneUrl: "https://github.com/acme/docs.git" });
    expect((await service.listProjects(developer, team.id)).map((project) => project.id)).toEqual([github.id]);
    expect(await service.listProjects(outsider, team.id)).toEqual([]);
    expect(await service.getProject(developer, team.id, github.id)).toEqual(github);
    await expect(service.createProject(developer, team.id, { name: "No", repositoryUrl: "https://github.com/acme/private", defaultBranch: "main" })).rejects.toMatchObject({ status: 403 });
    await expect(service.deleteProject(developer, team.id, github.id)).rejects.toMatchObject({ status: 403 });
    await expect(service.createProject(owner, team.id, { name: "Duplicate", repositoryUrl: "https://github.com/acme/docs", defaultBranch: "main" })).rejects.toMatchObject({ status: 409 });
    await expect(service.createProject(owner, team.id, { name: "Bad URL", repositoryUrl: "https://evil.example/acme/docs", defaultBranch: "main" })).rejects.toMatchObject({ status: 400 });
    await expect(service.createProject(owner, team.id, { name: "Bad branch", repositoryUrl: "https://github.com/acme/other", defaultBranch: "../../main" })).rejects.toMatchObject({ status: 400 });

    const gitlab = await service.createProject(owner, team.id, { name: "Service", repositoryUrl: "https://gitlab.com/acme/platform/service.git", defaultBranch: "develop" });
    expect(gitlab).toMatchObject({ provider: "gitlab", repositoryUrl: "https://gitlab.com/acme/platform/service", cloneUrl: "https://gitlab.com/acme/platform/service.git" });
    await expect(service.getProject(outsider, team.id, github.id)).rejects.toMatchObject({ status: 404 });
    await service.deleteProject(owner, team.id, github.id);
    expect((await service.listProjects(owner, team.id)).map((project) => project.id)).toEqual([gitlab.id]);
  });

  it("未指定分支时代码任务使用项目的默认分支", async () => {
    now += 60_000;
    const owner = await service.authenticate((await signIn("task-default-branch@example.com")).token);
    const team = await service.createTeam(owner, "Default branch team");
    const project = await service.createProject(owner, team.id, { name: "Legacy repo", repositoryUrl: "https://github.com/acme/legacy-repo", defaultBranch: "master" });
    const task = await service.createCodeTask(owner, team.id, project.id, { instructions: "List the repository root files." });
    expect(task).toMatchObject({ projectId: project.id, branch: "master", status: "pending_approval" });
  });

  it("creates code tasks as pending approval and never executes them in the text worker", async () => {
    now += 60_000;
    const owner = await service.authenticate((await signIn("task-owner@example.com")).token);
    const team = await service.createTeam(owner, "Code task team");
    const invite = await service.createInvitation(owner, team.id, "task-dev@example.com", "developer");
    const token = new URL(invite.invitation.inviteUrl!).searchParams.get("token")!;
    const developer = await service.authenticate((await signIn("task-dev@example.com")).token);
    await service.acceptInvitation(developer, token);
    const project = await service.createProject(owner, team.id, { name: "Task repo", repositoryUrl: "https://github.com/acme/task-repo", defaultBranch: "main" });
    const task = await service.createCodeTask(developer, team.id, project.id, { branch: "feature/task", instructions: "Update the parser and run the repository tests." });
    expect(task).toMatchObject({ projectId: project.id, branch: "feature/task", status: "pending_approval" });
    expect((await service.listCodeTasks(owner, team.id, project.id)).map((item) => item.id)).toContain(task.id);
    await expect(service.decideCodeTask(developer, team.id, project.id, task.id, "approve", "developer cannot approve")).rejects.toMatchObject({ status: 403 });
    const approved = await service.decideCodeTask(owner, team.id, project.id, task.id, "approve", "Reviewed scope");
    expect(approved).toMatchObject({ status: "approved_waiting_executor", decisionReason: "Reviewed scope", decidedBy: owner.userId });
    await expect(service.decideCodeTask(owner, team.id, project.id, task.id, "reject", "Too late")).rejects.toMatchObject({ status: 409 });
    const cancelled = await service.cancelCodeTask(developer, team.id, project.id, task.id);
    expect(cancelled.status).toBe("cancelled");
    const audit = await store.pool.query<{ action: string }>("SELECT action FROM team_audit_events WHERE team_id=$1 AND target_id=$2 ORDER BY created_at", [team.id, task.id]);
    expect(audit.rows.map((row) => row.action)).toEqual(["code_task.created", "code_task.approved", "code_task.cancelled"]);
  });

  it("revokes approved executor capabilities when team model credentials rotate or are deleted", async () => {
    now += 60_000;
    const owner = await service.authenticate((await signIn("executor-credential-owner@example.com")).token);
    const team = await service.createTeam(owner, "Executor credential rotation");
    await service.saveModelConfig(owner, team.id, { model: "team-code-model", apiKey: "sk-before-rotation" });
    const project = await service.createProject(owner, team.id, { name: "Rotation repo", repositoryUrl: "https://github.com/acme/rotation-repo", defaultBranch: "main" });
    const task = await service.createCodeTask(owner, team.id, project.id, { branch: "feature/credential-rotation", instructions: "Inspect changes safely." });
    await service.decideCodeTask(owner, team.id, project.id, task.id, "approve", "Reviewed");
    const dispatch = await service.claimCodeTaskForExecutor();
    expect(dispatch).toMatchObject({ taskId: task.id });
    await service.markCodeTaskDispatchAccepted(dispatch!.jobId);
    await service.saveModelConfig(owner, team.id, { model: "team-code-model", apiKey: "sk-after-rotation" });
    expect((await service.listCodeTasks(owner, team.id, project.id))[0]).toMatchObject({ status: "cancelled", executorError: "model_key_rotated" });
    await expect(service.getCodeTaskSnapshot(dispatch!.jobId, dispatch!.capabilityToken)).rejects.toMatchObject({ status: 401 });

    const next = await service.createCodeTask(owner, team.id, project.id, { branch: "feature/credential-delete", instructions: "This task will stop when the model key is deleted." });
    await service.decideCodeTask(owner, team.id, project.id, next.id, "approve", "Reviewed");
    const nextDispatch = await service.claimCodeTaskForExecutor();
    expect(nextDispatch).toMatchObject({ taskId: next.id });
    await service.markCodeTaskDispatchAccepted(nextDispatch!.jobId);
    await service.deleteModelConfig(owner, team.id);
    expect((await service.listCodeTasks(owner, team.id, project.id)).find((item) => item.id === next.id)).toMatchObject({ status: "cancelled", executorError: "model_key_deleted" });
    await expect(service.getCodeTaskSnapshot(nextDispatch!.jobId, nextDispatch!.capabilityToken)).rejects.toMatchObject({ status: 401 });
  });

  it("dispatches approved code tasks only through the signed external executor boundary", async () => {
    now += 60_000;
    const owner = await service.authenticate((await signIn("executor-owner@example.com")).token);
    const team = await service.createTeam(owner, "Executor boundary");
    const project = await service.createProject(owner, team.id, { name: "Executor repo", repositoryUrl: "https://github.com/acme/executor-repo", defaultBranch: "main" });
    await service.saveModelConfig(owner, team.id, { model: "team-code-model", apiKey: "sk-team-model-secret" });
    await service.saveGitCredential(owner, team.id, "github", "github_pat_repo_secret");
    const task = await service.createCodeTask(owner, team.id, project.id, { branch: "feature/isolated", instructions: "Run the bounded repository checks." });
    await service.decideCodeTask(owner, team.id, project.id, task.id, "approve", "Scope reviewed");
    const executorSecret = "executor-secret-that-is-at-least-32-characters";
    const requests: Array<{ url: string; body: Record<string, unknown>; signature: string }> = [];
    const executorConfig = { ...config, codeExecutorUrl: "http://127.0.0.1:9911", codeExecutorSecret: executorSecret };
    const dispatcher = new CodeTaskDispatcher(executorConfig, service, {
      fetch: async (input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push({ url: String(input), body, signature: new Headers(init?.headers).get("x-executor-signature") ?? "" });
        return new Response(null, { status: 202 });
      },
    });
    expect(await dispatcher.runOnce()).toBe(true);
    expect(requests[0]?.url).toBe("http://127.0.0.1:9911/v1/code-tasks");
    expect(requests[0]?.body).toMatchObject({ version: 1, taskId: task.id, teamId: team.id, projectId: project.id, branch: "feature/isolated" });
    const capabilityToken = String(requests[0]?.body.capabilityToken);
    expect(capabilityToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(requests[0]?.body).toMatchObject({ brokerUrl: config.publicUrl });
    expect(requests[0]?.body).not.toHaveProperty("apiKey");
    expect(JSON.stringify(requests[0]?.body)).not.toContain("sk-team-model-secret");
    expect(JSON.stringify(requests[0]?.body)).not.toContain("github_pat_repo_secret");
    expect(executorSignature(executorSecret, String(requests[0]?.body.jobId), requests[0]?.body)).toBe(requests[0]?.signature);
    expect((await service.listCodeTasks(owner, team.id, project.id))[0]).toMatchObject({ status: "running", executorJobId: requests[0]?.body.jobId });

    const brokerRequests: Array<{ url: string; authorization?: string; privateToken?: string; body?: Record<string, unknown> }> = [];
    const broker = new TeamService(config, store, undefined, {
      now: () => now,
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const headers = new Headers(init?.headers);
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
        brokerRequests.push({ url: url.toString(), authorization: headers.get("authorization") ?? undefined, privateToken: headers.get("private-token") ?? undefined, body });
        if (url.hostname === "api.github.com") return new Response(null, { status: 302, headers: { location: "https://codeload.github.com/acme/executor-repo/legacy.tar.gz/refs/heads/main" } });
        if (url.hostname === "codeload.github.com") return new Response(new Uint8Array([31, 139, 8, 0]), { status: 200, headers: { "content-type": "application/gzip" } });
        if (url.hostname === "models.example.test") return Response.json({ choices: [{ message: { role: "assistant", content: "model reply" } }] });
        throw new Error(`Unexpected upstream host ${url.hostname}`);
      },
    });
    const server = createTeamHttpServer(executorConfig, store, broker);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    now += 20_000;
    const heartbeatBody = { sequence: 1, sentAt: now };
    const heartbeatHeaders = {
      "content-type": "application/json",
      "x-executor-job-id": String(requests[0]?.body.jobId),
      "x-executor-signature": executorSignature(executorSecret, String(requests[0]?.body.jobId), heartbeatBody),
    };
    try {
      const rejectedHeartbeat = await fetch(`http://127.0.0.1:${address.port}/v1/internal/code-tasks/${encodeURIComponent(String(requests[0]?.body.jobId))}/heartbeat`, {
        method: "POST", headers: { ...heartbeatHeaders, "x-executor-signature": "0".repeat(64) }, body: JSON.stringify(heartbeatBody),
      });
      expect(rejectedHeartbeat.status).toBe(401);
      const heartbeat = await fetch(`http://127.0.0.1:${address.port}/v1/internal/code-tasks/${encodeURIComponent(String(requests[0]?.body.jobId))}/heartbeat`, {
        method: "POST", headers: heartbeatHeaders, body: JSON.stringify(heartbeatBody),
      });
      expect(heartbeat.status).toBe(200);
      const heartbeatState = await heartbeat.json();
      expect(heartbeatState).toMatchObject({ state: { status: "running", shouldStop: false, leaseExpiresAt: new Date(now + 45_000).toISOString() } });
      const replay = await fetch(`http://127.0.0.1:${address.port}/v1/internal/code-tasks/${encodeURIComponent(String(requests[0]?.body.jobId))}/heartbeat`, {
        method: "POST", headers: heartbeatHeaders, body: JSON.stringify(heartbeatBody),
      });
      expect(await replay.json()).toEqual(heartbeatState);
      const internalBase = `http://127.0.0.1:${address.port}/v1/internal/code-tasks/${encodeURIComponent(String(requests[0]?.body.jobId))}`;
      const deniedSnapshot = await fetch(`${internalBase}/snapshot`, { headers: { "x-executor-capability": "x".repeat(43) } });
      expect(deniedSnapshot.status).toBe(401);
      const snapshot = await fetch(`${internalBase}/snapshot`, { headers: { "x-executor-capability": capabilityToken } });
      expect(snapshot.status).toBe(200);
      expect(snapshot.headers.get("content-type")).toBe("application/gzip");
      expect([...new Uint8Array(await snapshot.arrayBuffer())]).toEqual([31, 139, 8, 0]);
      expect(brokerRequests[0]).toMatchObject({ authorization: "Bearer github_pat_repo_secret" });
      expect(brokerRequests[1]).toMatchObject({ url: "https://codeload.github.com/acme/executor-repo/legacy.tar.gz/refs/heads/main" });
      expect(brokerRequests[1]?.authorization).toBeUndefined();

      const capabilityState = await store.pool.query<{ status: string; model: string | null; role: string; lease_valid: boolean }>(
        `SELECT t.status, c.model, m.role, (t.executor_lease_until>$2) AS lease_valid
           FROM team_code_tasks t JOIN team_memberships m ON m.team_id=t.team_id AND m.user_id=t.created_by
           LEFT JOIN team_model_credentials c ON c.team_id=t.team_id WHERE t.executor_job_id=$1`,
        [String(requests[0]?.body.jobId), new Date(now)],
      );
      expect(capabilityState.rows[0]).toMatchObject({ status: "running", model: "team-code-model", role: "owner", lease_valid: true });
      const modelRequest = { model: "team-code-model", messages: [{ role: "user", content: "check the source" }], max_tokens: 20_000, stream: false };
      const modelResponse = await fetch(`${internalBase}/model/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", "x-executor-capability": capabilityToken }, body: JSON.stringify(modelRequest),
      });
      const modelResponseText = await modelResponse.text();
      expect(modelResponse.status, modelResponseText).toBe(200);
      expect(JSON.parse(modelResponseText)).toMatchObject({ choices: [{ message: { content: "model reply" } }] });
      const forwardedModelRequest = brokerRequests.find((entry) => entry.url === "https://models.example.test/v1/chat/completions");
      expect(forwardedModelRequest?.authorization).toBe("Bearer sk-team-model-secret");
      expect(forwardedModelRequest?.body).toMatchObject({ model: "team-code-model", max_tokens: 8_192, n: 1 });
      expect(JSON.stringify(modelRequest)).not.toContain("sk-team-model-secret");
      const wrongModel = await fetch(`${internalBase}/model/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", "x-executor-capability": capabilityToken },
        body: JSON.stringify({ model: "other-model", messages: [{ role: "user", content: "try switching" }] }),
      });
      expect(wrongModel.status).toBe(400);
    } catch (error) {
      throw error;
    }
    const callbackBody = { outcome: "succeeded", result: "checks passed" };
    const callbackHeaders = {
      "content-type": "application/json",
      "x-executor-job-id": String(requests[0]?.body.jobId),
      "x-executor-signature": executorSignature(executorSecret, String(requests[0]?.body.jobId), callbackBody),
    };
    try {
      const rejected = await fetch(`http://127.0.0.1:${address.port}/v1/internal/code-tasks/${encodeURIComponent(String(requests[0]?.body.jobId))}/result`, {
        method: "POST", headers: { ...callbackHeaders, "x-executor-signature": "0".repeat(64) }, body: JSON.stringify(callbackBody),
      });
      expect(rejected.status).toBe(401);
      const accepted = await fetch(`http://127.0.0.1:${address.port}/v1/internal/code-tasks/${encodeURIComponent(String(requests[0]?.body.jobId))}/result`, {
        method: "POST", headers: callbackHeaders, body: JSON.stringify(callbackBody),
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({ task: { id: task.id, status: "succeeded", executorResult: "checks passed" } });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const retryTask = await service.createCodeTask(owner, team.id, project.id, { branch: "feature/retry-dispatch", instructions: "Retry the isolated dispatch." });
    await service.decideCodeTask(owner, team.id, project.id, retryTask.id, "approve", "Retry test");
    const firstClaim = await service.claimCodeTaskForExecutor();
    expect(firstClaim).toMatchObject({ taskId: retryTask.id, executorAttempts: 1 });
    await store.pool.query("UPDATE team_code_tasks SET executor_lease_until=$2 WHERE id=$1", [retryTask.id, new Date(0)]);
    const secondClaim = await service.claimCodeTaskForExecutor();
    expect(secondClaim).toMatchObject({ taskId: retryTask.id, jobId: firstClaim?.jobId, executorAttempts: 2 });
    expect(secondClaim?.capabilityToken).toBe(firstClaim?.capabilityToken);
    await service.markCodeTaskDispatchAccepted(secondClaim!.jobId);
    await service.completeCodeTask(secondClaim!.jobId, "failed", undefined, "dispatch retry test complete");
  });

  it("expires abandoned executor runs and returns cancellation to signed heartbeats", async () => {
    now += 60_000;
    const owner = await service.authenticate((await signIn("executor-lease-owner@example.com")).token);
    const team = await service.createTeam(owner, "Executor lease");
    await service.saveModelConfig(owner, team.id, { model: "team-code-model", apiKey: "sk-team-code-secret" });
    const project = await service.createProject(owner, team.id, { name: "Lease repo", repositoryUrl: "https://github.com/acme/lease-repo", defaultBranch: "main" });
    const task = await service.createCodeTask(owner, team.id, project.id, { branch: "feature/lease", instructions: "Run the isolated task." });
    await service.decideCodeTask(owner, team.id, project.id, task.id, "approve", "Lease test");
    const dispatch = await service.claimCodeTaskForExecutor();
    expect(dispatch).toMatchObject({ taskId: task.id });
    await service.markCodeTaskDispatchAccepted(dispatch!.jobId);
    expect(await service.heartbeatCodeTask(dispatch!.jobId, 1, now)).toMatchObject({ status: "running", shouldStop: false });
    expect(await service.cancelCodeTask(owner, team.id, project.id, task.id)).toMatchObject({ status: "cancelled" });
    expect(await service.heartbeatCodeTask(dispatch!.jobId, 2, now)).toMatchObject({ status: "cancelled", shouldStop: true });
    const revokedCapabilityService = new TeamService(config, store, undefined, { now: () => now, fetch: async () => { throw new Error("cancelled tasks must not fetch source"); } });
    await expect(revokedCapabilityService.getCodeTaskSnapshot(dispatch!.jobId, dispatch!.capabilityToken)).rejects.toMatchObject({ status: 401 });
    const revokedCapability = await store.pool.query<{ executor_capability_hash: string | null; executor_capability_encrypted: string | null }>(
      "SELECT executor_capability_hash, executor_capability_encrypted FROM team_code_tasks WHERE id=$1", [task.id],
    );
    expect(revokedCapability.rows[0]).toEqual({ executor_capability_hash: null, executor_capability_encrypted: null });

    const abandoned = await service.createCodeTask(owner, team.id, project.id, { branch: "feature/abandoned", instructions: "This runner will disappear." });
    await service.decideCodeTask(owner, team.id, project.id, abandoned.id, "approve", "Timeout test");
    const abandonedDispatch = await service.claimCodeTaskForExecutor();
    expect(abandonedDispatch).toMatchObject({ taskId: abandoned.id });
    await service.markCodeTaskDispatchAccepted(abandonedDispatch!.jobId);
    await store.pool.query("UPDATE team_code_tasks SET executor_lease_until=$2 WHERE id=$1", [abandoned.id, new Date(now - 1)]);
    const housekeepingDispatcher = new CodeTaskDispatcher(config, service);
    expect(await housekeepingDispatcher.runOnce()).toBe(true);
    expect(await service.completeCodeTask(abandonedDispatch!.jobId, "succeeded", "late result", undefined)).toMatchObject({ status: "failed", executorError: "executor_lease_expired" });
  });

  it("cancels a member's open code tasks when that member loses team access", async () => {
    now += 60_000;
    const owner = await service.authenticate((await signIn("task-revoke-owner@example.com")).token);
    const team = await service.createTeam(owner, "Task revocation");
    const invite = await service.createInvitation(owner, team.id, "task-revoke-dev@example.com", "developer");
    const developer = await service.authenticate((await signIn("task-revoke-dev@example.com")).token);
    await service.acceptInvitation(developer, new URL(invite.invitation.inviteUrl!).searchParams.get("token"));
    const project = await service.createProject(owner, team.id, { name: "Revocation repo", repositoryUrl: "https://github.com/acme/revocation-repo", defaultBranch: "main" });
    const task = await service.createCodeTask(developer, team.id, project.id, { branch: "feature/revocation", instructions: "This task must be cancelled." });
    await service.updateMemberRole(owner, team.id, developer.userId, "viewer");
    expect((await service.listCodeTasks(owner, team.id, project.id)).find((item) => item.id === task.id)).toMatchObject({ status: "cancelled", executorError: "member_read_only" });
  });

  it("exposes authenticated JSON routes for the desktop client", async () => {
    const server = createTeamHttpServer(config, store, service);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const challenge = await fetch(`${base}/v1/auth/codes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "http-user@example.com" }) });
      expect(challenge.status).toBe(202);
      const { developmentCode } = await challenge.json() as { developmentCode: string };
      const sessionResponse = await fetch(`${base}/v1/auth/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "http-user@example.com", code: developmentCode }) });
      expect(sessionResponse.status).toBe(201);
      const session = await sessionResponse.json() as { token: string };
      const unauthorized = await fetch(`${base}/v1/teams`);
      expect(unauthorized.status).toBe(401);
      const created = await fetch(`${base}/v1/teams`, { method: "POST", headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "HTTP Team" }) });
      expect(created.status).toBe(201);
      const createdTeam = (await created.json() as { team: { id: string; role: string } }).team;
      expect(createdTeam.role).toBe("owner");
      const auth = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };
      const auditResponse = await fetch(`${base}/v1/teams/${createdTeam.id}/audit`, { headers: auth });
      expect(auditResponse.status).toBe(200);
      expect((await auditResponse.json() as { events: Array<{ action: string; actorEmail: string }> }).events).toMatchObject([{ action: "team.created", actorEmail: "http-user@example.com" }]);
      const usageResponse = await fetch(`${base}/v1/teams/${createdTeam.id}/usage`, { headers: auth });
      expect(usageResponse.status).toBe(200);
      expect((await usageResponse.json() as { usage: { scope: string; successfulJobs: number } }).usage).toMatchObject({ scope: "team", successfulJobs: 0 });
      const modelConfigResponse = await fetch(`${base}/v1/teams/${createdTeam.id}/model-config`, { method: "PUT", headers: auth, body: JSON.stringify({ model: "team-model", apiKey: "sk-http-key-secret" }) });
      expect(modelConfigResponse.status).toBe(200);
      const publicConfig = await modelConfigResponse.json() as { modelConfig: { configured: boolean; keyTail: string } };
      expect(publicConfig.modelConfig).toMatchObject({ configured: true, keyTail: "cret" });
      expect(JSON.stringify(publicConfig)).not.toContain("sk-http-key-secret");
      const botResponse = await fetch(`${base}/v1/teams/${createdTeam.id}/bots`, { method: "POST", headers: auth, body: JSON.stringify({ name: "HTTP bot", description: "Shared", instructions: "Keep the discussion focused." }) });
      expect(botResponse.status).toBe(201);
      const bot = (await botResponse.json() as { bot: { id: string; name: string } }).bot;
      expect(bot.name).toBe("HTTP bot");
      const projectResponse = await fetch(`${base}/v1/teams/${createdTeam.id}/projects`, { method: "POST", headers: auth, body: JSON.stringify({ name: "HTTP repo", repositoryUrl: "https://github.com/acme/http-repo", defaultBranch: "main" }) });
      expect(projectResponse.status).toBe(201);
      const project = (await projectResponse.json() as { project: { id: string } }).project;
      const codeTaskResponse = await fetch(`${base}/v1/teams/${createdTeam.id}/projects/${project.id}/code-tasks`, { method: "POST", headers: auth, body: JSON.stringify({ branch: "feature/http-task", instructions: "Review the parser changes." }) });
      expect(codeTaskResponse.status).toBe(201);
      const codeTask = (await codeTaskResponse.json() as { task: { id: string; status: string } }).task;
      expect(codeTask.status).toBe("pending_approval");
      const codeTaskList = await fetch(`${base}/v1/teams/${createdTeam.id}/projects/${project.id}/code-tasks`, { headers: auth });
      expect(codeTaskList.status).toBe(200);
      expect(await codeTaskList.json()).toMatchObject({ tasks: [{ id: codeTask.id, branch: "feature/http-task", status: "pending_approval" }] });
      const approvedCodeTask = await fetch(`${base}/v1/teams/${createdTeam.id}/projects/${project.id}/code-tasks/${codeTask.id}/approve`, { method: "POST", headers: auth, body: JSON.stringify({ reason: "Reviewed for the desktop flow." }) });
      expect(approvedCodeTask.status).toBe(200);
      expect(await approvedCodeTask.json()).toMatchObject({ task: { id: codeTask.id, status: "approved_waiting_executor" } });
      const cancelledCodeTask = await fetch(`${base}/v1/teams/${createdTeam.id}/projects/${project.id}/code-tasks/${codeTask.id}/cancel`, { method: "POST", headers: auth });
      expect(cancelledCodeTask.status).toBe(200);
      expect(await cancelledCodeTask.json()).toMatchObject({ task: { id: codeTask.id, status: "cancelled" } });
      const credentialResponse = await fetch(`${base}/v1/teams/${createdTeam.id}/git-credentials/github`, { method: "PUT", headers: auth, body: JSON.stringify({ token: "github_pat_http_1234" }) });
      expect(credentialResponse.status).toBe(200);
      expect(await credentialResponse.json()).toMatchObject({ credentials: { github: { configured: true, keyTail: "1234" } } });
      const credentialStatus = await fetch(`${base}/v1/teams/${createdTeam.id}/git-credentials`, { headers: auth });
      expect(await credentialStatus.json()).toMatchObject({ credentials: { github: { configured: true } } });
      const originalFetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const requestUrl = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (requestUrl.hostname === "api.github.com") {
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer github_pat_http_1234");
          return requestUrl.pathname.includes("/compare/")
            ? new Response("diff --git a/a b/a\n+ok\n", { status: 200 })
            : new Response(JSON.stringify({ html_url: "https://github.com/acme/http-repo/pull/25", number: 25, state: "open" }), { status: 201 });
        }
        return originalFetch(input, init);
      });
      try {
        const diffResponse = await fetch(`${base}/v1/teams/${createdTeam.id}/projects/${project.id}/diff?head=feature%2Fapi`, { headers: auth });
        expect(diffResponse.status).toBe(200);
        expect(await diffResponse.json()).toMatchObject({ comparison: { head: "feature/api", base: "main", diff: "diff --git a/a b/a\n+ok\n", truncated: false } });
        const reviewResponse = await fetch(`${base}/v1/teams/${createdTeam.id}/projects/${project.id}/reviews`, { method: "POST", headers: auth, body: JSON.stringify({ head: "feature/api", title: "HTTP review", body: "Ready." }) });
        expect(reviewResponse.status).toBe(201);
        expect(await reviewResponse.json()).toMatchObject({ review: { url: "https://github.com/acme/http-repo/pull/25", number: 25 } });
      } finally {
        vi.unstubAllGlobals();
      }
      const conversationResponse = await fetch(`${base}/v1/teams/${createdTeam.id}/conversations`, { method: "POST", headers: auth, body: JSON.stringify({ botId: bot.id, title: "HTTP discussion", visibility: "team" }) });
      expect(conversationResponse.status).toBe(201);
      const conversation = (await conversationResponse.json() as { conversation: { id: string } }).conversation;
      const eventsAbort = new AbortController();
      const eventsResponse = await fetch(`${base}/v1/teams/${createdTeam.id}/conversations/${conversation.id}/events`, { headers: { authorization: auth.authorization, accept: "text/event-stream" }, signal: eventsAbort.signal });
      expect(eventsResponse.status).toBe(200);
      expect(eventsResponse.headers.get("content-type")).toContain("text/event-stream");
      const eventReader = eventsResponse.body!.getReader();
      const decoder = new TextDecoder();
      expect(decoder.decode((await eventReader.read()).value)).toContain(": connected");
      const messageResponse = await fetch(`${base}/v1/teams/${createdTeam.id}/conversations/${conversation.id}/messages`, { method: "POST", headers: auth, body: JSON.stringify({ content: "Hello from the desktop" }) });
      expect(messageResponse.status).toBe(201);
      expect((await messageResponse.json() as { message: { authorEmail: string } }).message.authorEmail).toBe("http-user@example.com");
      expect(decoder.decode((await eventReader.read()).value)).toContain("event: update");
      eventsAbort.abort();
      await eventReader.cancel().catch(() => undefined);
      const httpOwner = await service.authenticate(session.token);
      const privateConversation = await service.createConversation(httpOwner, createdTeam.id, { botId: bot.id, title: "Private HTTP thread", visibility: "private" });
      const privateInvite = await service.createInvitation(httpOwner, createdTeam.id, "http-outsider@example.com", "developer");
      const privateInviteToken = new URL(privateInvite.invitation.inviteUrl!).searchParams.get("token")!;
      const outsiderSession = await signIn("http-outsider@example.com");
      const outsider = await service.authenticate(outsiderSession.token);
      await service.acceptInvitation(outsider, privateInviteToken);
      const privateEvents = await fetch(`${base}/v1/teams/${createdTeam.id}/conversations/${privateConversation.id}/events`, { headers: { authorization: `Bearer ${outsiderSession.token}` } });
      expect(privateEvents.status).toBe(404);
      const sharedEventsAbort = new AbortController();
      const sharedEvents = await fetch(`${base}/v1/teams/${createdTeam.id}/conversations/${conversation.id}/events`, { headers: { authorization: `Bearer ${outsiderSession.token}` }, signal: sharedEventsAbort.signal });
      expect(sharedEvents.status).toBe(200);
      const sharedReader = sharedEvents.body!.getReader();
      expect(decoder.decode((await sharedReader.read()).value)).toContain(": connected");
      await service.removeMember(httpOwner, createdTeam.id, outsider.userId);
      const revokedMemberUpdate = await fetch(`${base}/v1/teams/${createdTeam.id}/conversations/${conversation.id}/messages`, { method: "POST", headers: auth, body: JSON.stringify({ content: "Notify remaining members" }) });
      expect(revokedMemberUpdate.status).toBe(201);
      expect((await sharedReader.read()).done).toBe(true);
      sharedEventsAbort.abort();
      await sharedReader.cancel().catch(() => undefined);
      const inviteToken = "A".repeat(40);
      const invitePage = await fetch(`${base}/invite?token=${inviteToken}`);
      expect(invitePage.status).toBe(200);
      expect(invitePage.headers.get("cache-control")).toBe("no-store");
      expect(invitePage.headers.get("referrer-policy")).toBe("no-referrer");
      expect(invitePage.headers.get("content-security-policy")).toContain("script-src 'nonce-");
      const inviteHtml = await invitePage.text();
      expect(inviteHtml).toContain(inviteToken);
      expect(inviteHtml).toContain(`href="dazuibot://invite?token=${inviteToken}"`);
      expect((await fetch(`${base}/invite?token=bad`)).status).toBe(400);
      const leaveInviteResponse = await fetch(`${base}/v1/teams/${createdTeam.id}/invitations`, { method: "POST", headers: auth, body: JSON.stringify({ email: "http-leaver@example.com", role: "developer" }) });
      const leaveInvite = (await leaveInviteResponse.json() as { invitation: { inviteUrl: string } }).invitation;
      const leaveToken = new URL(leaveInvite.inviteUrl).searchParams.get("token")!;
      const leaveUser = await signIn("http-leaver@example.com");
      const leaveUserAuth = { authorization: `Bearer ${leaveUser.token}`, "content-type": "application/json" };
      const accept = await fetch(`${base}/v1/invitations/accept`, { method: "POST", headers: leaveUserAuth, body: JSON.stringify({ token: leaveToken }) });
      expect(accept.status).toBe(200);
      const leaveResponse = await fetch(`${base}/v1/teams/${createdTeam.id}/members/me`, { method: "DELETE", headers: leaveUserAuth });
      expect(leaveResponse.status).toBe(200);
      const deletedTeam = await fetch(`${base}/v1/teams/${createdTeam.id}`, { method: "DELETE", headers: auth, body: JSON.stringify({ confirmName: "HTTP Team" }) });
      expect(deletedTeam.status).toBe(200);
      expect(await deletedTeam.json()).toEqual({ ok: true });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
