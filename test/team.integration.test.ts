import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const SESSION_TOKEN = "team-session-token-must-stay-out-of-renderer";
const UI_TOKEN = "local-ui-team-test-token";
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

describe("桌面 App 团队登录代理", () => {
  let app: App;
  let dataDir: string;
  let uiBase = "";
  let teamBase = "";
  let teamServer: http.Server;
  let revoked = false;
  let openedPath = "";
  const seenAuthorization: string[] = [];

  const json = (res: http.ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const readBody = async (req: http.IncomingMessage) => {
    let value = "";
    for await (const chunk of req) value += chunk;
    return value ? JSON.parse(value) as Record<string, unknown> : {};
  };
  const call = async (p: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${uiBase}/amb/api${p}`, {
      method,
      headers: { "x-amb-token": UI_TOKEN, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() as Record<string, any> };
  };

  beforeAll(async () => {
    teamServer = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://team.test");
      const body = req.method === "POST" || req.method === "PATCH" || req.method === "PUT" ? await readBody(req) : {};
      if (req.headers.authorization) seenAuthorization.push(String(req.headers.authorization));
      if (url.pathname === "/v1/auth/codes" && req.method === "POST") return json(res, 202, { expiresInSeconds: 600, developmentCode: "123456" });
      if (url.pathname === "/v1/auth/sessions" && req.method === "POST") return json(res, 201, { token: SESSION_TOKEN, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), user: { id: "u-owner", email: body.email } });
      if (url.pathname === "/v1/auth/sessions/current" && req.method === "DELETE") { revoked = true; return json(res, 200, { ok: true }); }
      if (req.headers.authorization !== `Bearer ${SESSION_TOKEN}`) return json(res, 401, { error: "Sign in to continue" });
      if (url.pathname === "/v1/me" && req.method === "GET") return json(res, 200, { user: { id: "u-owner", email: "owner@example.com" }, teams: [{ id: "t-1", name: "Design", role: "owner", createdAt: new Date().toISOString() }] });
      if (url.pathname === "/v1/teams" && req.method === "POST") return json(res, 201, { team: { id: "t-new", name: body.name, role: "owner", createdAt: new Date().toISOString() } });
      if (url.pathname === "/v1/teams/t-1/members" && req.method === "GET") return json(res, 200, { members: [{ userId: "u-owner", email: "owner@example.com", role: "owner", joinedAt: new Date().toISOString() }] });
      if (url.pathname === "/v1/teams/t-1/model-config" && req.method === "GET") return json(res, 200, { modelConfig: { configured: false, modelBaseUrl: "https://models.example.test/v1" } });
      if (url.pathname === "/v1/teams/t-1/model-config" && req.method === "PUT") return json(res, 200, { modelConfig: { configured: true, model: body.model, keyTail: String(body.apiKey).slice(-4), modelBaseUrl: "https://models.example.test/v1" } });
      if (url.pathname === "/v1/teams/t-1/model-config" && req.method === "DELETE") return json(res, 200, { ok: true });
      if (url.pathname === "/v1/teams/t-1/usage" && req.method === "GET") return json(res, 200, { usage: { scope: "team", periodStart: new Date().toISOString(), successfulJobs: 1, reportedJobs: 1, inputTokens: 17, outputTokens: 4, members: [] } });
      if (url.pathname === "/v1/teams/t-1/audit" && req.method === "GET") return json(res, 200, { events: [{ id: "a-1", actorEmail: "owner@example.com", action: "team.created", targetType: "team", targetId: "t-1", details: {}, createdAt: new Date().toISOString() }] });
      if (url.pathname === "/v1/teams/t-1/projects" && req.method === "GET") return json(res, 200, { projects: [{ id: "p-1", teamId: "t-1", name: "Docs", provider: "github", repositoryUrl: "https://github.com/zdzui/docs", cloneUrl: "https://github.com/zdzui/docs.git", defaultBranch: "main", createdBy: "u-owner", createdAt: new Date().toISOString() }] });
      if (url.pathname === "/v1/teams/t-1/projects" && req.method === "POST") return json(res, 201, { project: { id: "p-2", teamId: "t-1", name: body.name, provider: "github", repositoryUrl: body.repositoryUrl, cloneUrl: `${body.repositoryUrl}.git`, defaultBranch: body.defaultBranch, createdBy: "u-owner", createdAt: new Date().toISOString() } });
      if (url.pathname === "/v1/teams/t-1/projects/p-1" && req.method === "GET") return json(res, 200, { project: { id: "p-1", teamId: "t-1", name: "Docs", provider: "github", repositoryUrl: "https://github.com/zdzui/docs", cloneUrl: "https://github.com/zdzui/docs.git", defaultBranch: "main", createdBy: "u-owner", createdAt: new Date().toISOString() } });
      if (url.pathname === "/v1/teams/t-1/projects/p-1" && req.method === "DELETE") return json(res, 200, { ok: true });
      if (url.pathname === "/v1/teams/t-1/bots" && req.method === "GET") return json(res, 200, { bots: [{ id: "b-1", teamId: "t-1", name: "Release helper", description: "", instructions: "", createdBy: "u-owner", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] });
      if (url.pathname === "/v1/teams/t-1/bots" && req.method === "POST") return json(res, 201, { bot: { id: "b-2", teamId: "t-1", name: body.name, description: body.description, instructions: body.instructions, createdBy: "u-owner", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
      if (url.pathname === "/v1/teams/t-1/conversations" && req.method === "GET") return json(res, 200, { conversations: [{ id: "c-1", teamId: "t-1", botId: "b-1", botName: "Release helper", title: "Release notes", visibility: "team", createdBy: "u-owner", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] });
      if (url.pathname === "/v1/teams/t-1/conversations" && req.method === "POST") return json(res, 201, { conversation: { id: "c-2", teamId: "t-1", botId: body.botId, botName: "Release helper", title: body.title, visibility: body.visibility, createdBy: "u-owner", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
      if (url.pathname === "/v1/teams/t-1/conversations/c-1/messages" && req.method === "GET") return json(res, 200, { messages: [{ id: "m-1", conversationId: "c-1", authorUserId: "u-owner", authorEmail: "owner@example.com", role: "user", content: "Hello team", createdAt: new Date().toISOString() }], jobs: [] });
      if (url.pathname === "/v1/teams/t-1/conversations/c-1/messages" && req.method === "POST") return json(res, 201, { message: { id: "m-2", conversationId: "c-1", authorUserId: "u-owner", authorEmail: "owner@example.com", role: "user", content: body.content, createdAt: new Date().toISOString() }, job: { id: "j-1", conversationId: "c-1", status: "queued", attemptCount: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
      if (url.pathname === "/v1/teams/t-1/invitations" && req.method === "POST") return json(res, 201, { invitation: { id: "i-1", teamId: "t-1", email: body.email, role: body.role, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), createdAt: new Date().toISOString(), inviteUrl: "https://team.example.com/invite?token=invite-token" }, emailSent: false });
      if (url.pathname === "/v1/teams/t-1/invitations" && req.method === "GET") return json(res, 200, { invitations: [] });
      return json(res, 404, { error: "not found" });
    });
    await new Promise<void>((resolve) => teamServer.listen(0, "127.0.0.1", resolve));
    const addr = teamServer.address();
    if (!addr || typeof addr === "string") throw new Error("team test server did not bind");
    teamBase = `http://127.0.0.1:${addr.port}`;

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "amb-team-app-"));
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ team: { apiBaseUrl: teamBase } }));
    const config = loadConfig({ dataDir, env: { AMB_MAGPIE_BASE_URL: "http://127.0.0.1:9/v1", AMB_UI_PORT: "0", AMB_UI_TOKEN: UI_TOKEN, AMB_AGENT: "off", AMB_WEIXIN_API_BASE: "http://127.0.0.1:9" } });
    app = new App(config, { printQrToTerminal: false });
    app.desktop = { secretBox, fetch, openPath: (value: string) => { openedPath = value; } } as any;
    await app.start();
    app.ensureTeam().checkoutProject = async () => ({ path: "C:\\Local\\workspace\\docs", branch: "team/member-123", reused: false });
    uiBase = app.web!.url.replace(/\/$/, "");
  });

  afterAll(async () => {
    await app?.stop();
    await new Promise<void>((resolve, reject) => teamServer?.close((error) => error ? reject(error) : resolve()));
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("lets an invited teammate sign in without exposing the session token to the renderer", async () => {
    expect((await call("/team/config")).data.apiBaseUrl).toBe(teamBase);
    expect((await call("/team/status")).data).toMatchObject({ configured: true, signedIn: false });
    expect((await call("/team/auth/codes", "POST", { email: "owner@example.com" })).data.developmentCode).toBe("123456");

    const signedIn = await call("/team/auth/sessions", "POST", { email: "owner@example.com", code: "123456" });
    expect(signedIn.status).toBe(201);
    expect(signedIn.data).toMatchObject({ configured: true, signedIn: true, user: { email: "owner@example.com" } });
    expect(JSON.stringify(signedIn.data)).not.toContain(SESSION_TOKEN);
    const stored = fs.readFileSync(path.join(dataDir, "team-session.json"), "utf8");
    expect(stored).not.toContain(SESSION_TOKEN);

    expect((await call("/team/teams", "POST", { name: "Platform" })).data.team.name).toBe("Platform");
    expect((await call("/team/teams/t-1/members")).data.members).toHaveLength(1);
    expect((await call("/team/teams/t-1/bots")).data.bots[0].name).toBe("Release helper");
    expect((await call("/team/teams/t-1/bots", "POST", { name: "Docs", description: "", instructions: "" })).data.bot.id).toBe("b-2");
    expect((await call("/team/teams/t-1/conversations")).data.conversations[0].id).toBe("c-1");
    expect((await call("/team/teams/t-1/conversations", "POST", { botId: "b-1", title: "Planning", visibility: "team" })).data.conversation.id).toBe("c-2");
    expect((await call("/team/teams/t-1/conversations/c-1/messages")).data.messages[0].content).toBe("Hello team");
    const message = await call("/team/teams/t-1/conversations/c-1/messages", "POST", { content: "Shared" });
    expect(message.data.message.content).toBe("Shared");
    expect(message.data.job.status).toBe("queued");
    expect((await call("/team/teams/t-1/model-config")).data.modelConfig.configured).toBe(false);
    expect((await call("/team/teams/t-1/usage")).data.usage).toMatchObject({ scope: "team", successfulJobs: 1, inputTokens: 17, outputTokens: 4 });
    expect((await call("/team/teams/t-1/audit")).data.events[0].action).toBe("team.created");
    const modelConfig = await call("/team/teams/t-1/model-config", "PUT", { model: "test-model", apiKey: "sk-do-not-leak-4321" });
    expect(modelConfig.data.modelConfig.keyTail).toBe("4321");
    expect(JSON.stringify(modelConfig.data)).not.toContain("sk-do-not-leak-4321");
    expect((await call("/team/teams/t-1/model-config", "DELETE")).data.ok).toBe(true);
    expect((await call("/team/teams/t-1/projects")).data.projects[0].id).toBe("p-1");
    expect((await call("/team/teams/t-1/projects", "POST", { name: "Plans", repositoryUrl: "https://github.com/zdzui/plans", defaultBranch: "main" })).data.project.id).toBe("p-2");
    expect((await call("/team/teams/t-1/projects/p-1")).data.project.name).toBe("Docs");
    expect((await call("/team/teams/t-1/projects/p-1", "DELETE")).data.ok).toBe(true);
    const checkout = await call("/team/teams/t-1/projects/p-1/checkout", "POST", {});
    expect(checkout.data).toMatchObject({ branch: "team/member-123", opened: true });
    expect(openedPath).toBe("C:\\Local\\workspace\\docs");
    expect((await call("/team/teams/t-1/projects/p-1/inspect")).data).toMatchObject({ available: false, files: [], diff: "" });
    const invitation = await call("/team/teams/t-1/invitations", "POST", { email: "dev@example.com", role: "developer" });
    expect(invitation.data.invitation.inviteUrl).toContain("invite-token");
    expect(seenAuthorization.every((header) => header === `Bearer ${SESSION_TOKEN}`)).toBe(true);

    expect((await call("/team/auth/sessions/current", "DELETE")).data.ok).toBe(true);
    expect(revoked).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "team-session.json"))).toBe(false);
    expect((await call("/team/status")).data.signedIn).toBe(false);
  });
});
