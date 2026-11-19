import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PGlitePool } from "../src/pglite-pool.js";
import type { Config } from "../src/config.js";
import { Store } from "../src/store.js";
import { TeamService } from "../src/service.js";

// 建项目时未显式指定 defaultBranch，服务应向托管方探测真实默认分支。
//
// 探测顺序（2026-11 修正）：
//  1) git smart-HTTP 的 info/refs 响应里有 `symref=HEAD:refs/heads/<branch>`，
//     不消耗 REST API 配额，公开仓库无需凭据 —— 这是首选；
//  2) REST API 兜底（私有仓库 / git 协议不可用时）；
//  3) 都失败则回落到 main，不阻断建项目。
//
// 之前只走 REST API，而 GitHub 对未认证请求只有 60 次/小时的配额，
// 试点环境共享出口 IP 时必然触发 403 速率限制，导致默认分支退化成 main，
// 老仓库（默认分支 master）取快照会 502。

const config: Config = {
  host: "127.0.0.1", port: 0, databaseUrl: "postgres://unused", sessionSecret: "test-session-secret-is-long-enough-32-bytes",
  credentialSecret: "test-credential-secret-is-long-enough-32-bytes", modelBaseUrl: "https://models.example.test/v1",
  modelCatalog: ["gpt-4o"], publicUrl: "http://127.0.0.1:8787", mailFrom: "test@example.com", smtpUrl: "",
  codeExecutorUrl: "", codeExecutorBrokerUrl: "http://127.0.0.1:8787", codeExecutorSecret: "", codeExecutorPollMs: 250,
  corsOrigins: new Set(), allowDevCodes: true, production: false,
};

const pool = new PGlitePool();
const store = new Store(config, pool as never);

let now = Date.parse("2026-11-10T00:00:00Z");

function makeService(fetchImpl: typeof fetch): TeamService {
  return new TeamService(config, store, undefined, { now: () => now, makeCode: () => "123456", fetch: fetchImpl });
}

let emailSeq = 0;

async function ownerSession(service: TeamService): Promise<{ teamId: string; owner: never }> {
  // 每次用不同的邮箱：登录验证码有 60 秒冷却，同一邮箱连续请求会被限流。
  emailSeq += 1;
  const email = `owner-${emailSeq}@example.com`;
  const challenge = await service.requestLoginCode(email);
  const session = await service.createSession(email, challenge.developmentCode!);
  const owner = await service.authenticate(session.token);
  const team = await service.createTeam(owner, "Branch Team");
  return { teamId: team.id, owner };
}

/** 构造 git smart-HTTP 的 info/refs 响应体 */
function smartHttpBody(branch: string): string {
  const head = "001e# service=git-upload-pack\n";
  const payload = `0000015b7fd1a60b01f91b314f59955a4e4d4e80d8edf11d HEAD\x00multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-rel symref=HEAD:refs/heads/${branch} agent=git/github\n`;
  return head + payload;
}

describe("默认分支探测", () => {
  beforeAll(async () => {
    await store.migrate();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("优先用 git smart-HTTP 拿到真实默认分支（master）", async () => {
    const seen: string[] = [];
    const service = makeService(async (input) => {
      const url = new URL(String(input));
      seen.push(url.pathname);
      expect(url.hostname).toBe("github.com");
      expect(url.pathname).toBe("/acme/legacy-app.git/info/refs");
      expect(url.searchParams.get("service")).toBe("git-upload-pack");
      return new Response(smartHttpBody("master"), { status: 200 });
    });
    const { teamId, owner } = await ownerSession(service);
    const project = await service.createProject(owner, teamId, { name: "Legacy", repositoryUrl: "https://github.com/acme/legacy-app" });
    expect(project.defaultBranch).toBe("master");
    // smart-HTTP 成功就不该再打 REST API
    expect(seen).toEqual(["/acme/legacy-app.git/info/refs"]);
  });

  it("smart-HTTP 不可用时回落到 REST API", async () => {
    const seen: string[] = [];
    const service = makeService(async (input) => {
      const url = new URL(String(input));
      seen.push(url.hostname);
      if (url.hostname === "github.com") {
        return new Response("Repository not found.", { status: 401 });
      }
      expect(url.hostname).toBe("api.github.com");
      expect(url.pathname).toBe("/repos/acme/platform-app");
      return Response.json({ default_branch: "trunk" });
    });
    const { teamId, owner } = await ownerSession(service);
    const project = await service.createProject(owner, teamId, { name: "Platform", repositoryUrl: "https://github.com/acme/platform-app" });
    expect(project.defaultBranch).toBe("trunk");
    expect(seen).toEqual(["github.com", "api.github.com"]);
  });

  it("GitLab 仓库同样走 smart-HTTP 优先", async () => {
    const service = makeService(async (input) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe("gitlab.com");
      expect(url.pathname).toBe("/acme/platform.git/info/refs");
      return new Response(smartHttpBody("trunk"), { status: 200 });
    });
    const { teamId, owner } = await ownerSession(service);
    const project = await service.createProject(owner, teamId, { name: "Platform", repositoryUrl: "https://gitlab.com/acme/platform" });
    expect(project.defaultBranch).toBe("trunk");
  });

  it("显式指定分支时不发起探测请求", async () => {
    let calls = 0;
    const service = makeService(async () => {
      calls += 1;
      return Response.json({ default_branch: "master" });
    });
    const { teamId, owner } = await ownerSession(service);
    const project = await service.createProject(owner, teamId, { name: "Explicit", repositoryUrl: "https://github.com/acme/explicit", defaultBranch: "release" });
    expect(project.defaultBranch).toBe("release");
    expect(calls).toBe(0);
  });

  it("两条探测路径都失败时回落到 main，不阻断建项目", async () => {
    const service = makeService(async () => { throw new Error("network down"); });
    const { teamId, owner } = await ownerSession(service);
    const project = await service.createProject(owner, teamId, { name: "Offline", repositoryUrl: "https://github.com/acme/offline" });
    expect(project.defaultBranch).toBe("main");
  });

  it("托管方返回非法分支名时回落到 main", async () => {
    const service = makeService(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "github.com") return new Response(smartHttpBody("../../etc/passwd"), { status: 200 });
      return Response.json({ default_branch: "../../etc/passwd" });
    });
    const { teamId, owner } = await ownerSession(service);
    const project = await service.createProject(owner, teamId, { name: "Bad", repositoryUrl: "https://github.com/acme/bad" });
    expect(project.defaultBranch).toBe("main");
  });

  it("两条路径都返回非 2xx 时回落到 main", async () => {
    const service = makeService(async () => new Response("nope", { status: 404 }));
    const { teamId, owner } = await ownerSession(service);
    const project = await service.createProject(owner, teamId, { name: "Missing", repositoryUrl: "https://github.com/acme/missing" });
    expect(project.defaultBranch).toBe("main");
  });
});
