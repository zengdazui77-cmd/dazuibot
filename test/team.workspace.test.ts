import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { TeamWorkspace } from "../src/team/workspace.js";
import { TeamApiError, type TeamProject } from "../src/team/client.js";

const project: TeamProject = {
  id: "a1b2c3d4e5f60718",
  teamId: "t-1",
  name: "Assistant",
  provider: "github",
  repositoryUrl: "https://github.com/zdzui/assistant",
  cloneUrl: "https://github.com/zdzui/assistant.git",
  defaultBranch: "main",
  createdBy: "owner-id",
  createdAt: new Date().toISOString(),
};
const execFileAsync = promisify(execFile);

describe("per-member team Git workspaces", () => {
  let dataDir = "";
  afterEach(async () => { if (dataDir) await fs.rm(dataDir, { recursive: true, force: true }); dataDir = ""; });

  it("clones into an isolated local directory and creates a member-specific branch without shell interpolation", async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dazuibot-team-git-"));
    const commands: string[][] = [];
    let currentBranch = "main";
    let statusOutput = "";
    let workingDiff = "";
    let stagedDiff = "";
    const runGit = async (args: string[]) => {
      commands.push(args);
      if (args[0] === "clone") {
        const target = args.at(-1)!;
        await fs.mkdir(path.join(target, ".git"), { recursive: true });
        return "";
      }
      if (args.includes("remote")) return project.cloneUrl;
      if (args.includes("status")) return statusOutput;
      if (args.includes("diff")) return args.includes("--cached") ? stagedDiff : workingDiff;
      if (args.includes("--show-current")) return currentBranch;
      if (args.includes("switch")) {
        currentBranch = args.includes("-c") ? args[args.indexOf("-c") + 1]! : args.at(-1)!;
        return "";
      }
      if (args.includes("--list")) return currentBranch === args.at(-1) ? currentBranch : "";
      return "";
    };
    const workspaces = new TeamWorkspace(dataDir, { runGit });
    const first = await workspaces.checkout("team-1", project, "user-1", "developer@example.com");
    expect(first.reused).toBe(false);
    expect(first.branch).toMatch(/^team\/[a-f0-9]{16}\/developer-[a-f0-9]{8}$/);
    expect(first.path.startsWith(`${path.join(dataDir, "team-workspaces")}${path.sep}`)).toBe(true);
    expect(commands.find((args) => args[0] === "clone")).toEqual([
      "clone", "--branch", "main", "--single-branch", "--no-tags", project.cloneUrl, expect.any(String),
    ]);
    expect(commands.every((args) => args.every((part) => !part.includes(";")))).toBe(true);

    const second = await workspaces.checkout("team-1", project, "user-1", "developer@example.com");
    expect(second).toMatchObject({ path: first.path, branch: first.branch, reused: true });
    expect(commands.filter((args) => args[0] === "clone")).toHaveLength(1);

    const third = await workspaces.checkout("team-1", project, "user-2", "reviewer@example.com");
    expect(third.path).not.toBe(first.path);
    expect(third.branch).not.toBe(first.branch);
    expect(commands.filter((args) => args[0] === "clone")).toHaveLength(2);

    statusOutput = " M src/main.ts\0?? notes.txt\0";
    currentBranch = first.branch;
    workingDiff = "diff --git a/src/main.ts b/src/main.ts\n+changed";
    stagedDiff = "diff --git a/package.json b/package.json\n+staged";
    const snapshot = await workspaces.inspect("team-1", project, "user-1");
    expect(snapshot).toMatchObject({ available: true, branch: first.branch, files: [{ status: "M", path: "src/main.ts" }, { status: "??", path: "notes.txt" }] });
    expect(snapshot.diff).toContain("+changed");
    expect(snapshot.diff).toContain("+staged");
    expect(snapshot.reviewUrl).toContain("github.com/zdzui/assistant/compare/main...team/");
  });

  it("rejects unsafe repository URLs before invoking Git and preserves dirty workspaces", async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dazuibot-team-git-"));
    let calls = 0;
    const unsafe = { ...project, cloneUrl: "https://attacker.example/repo.git" };
    await expect(new TeamWorkspace(dataDir, { runGit: async () => { calls += 1; return ""; } }).checkout("team-1", unsafe, "user-1"))
      .rejects.toMatchObject({ status: 502 });
    expect(calls).toBe(0);

    const dirtyWorkspace = new TeamWorkspace(dataDir, { runGit: async (args) => {
      if (args.includes("remote")) return project.cloneUrl;
      if (args.includes("status")) return " M file.ts";
      if (args.includes("--show-current")) return "other-branch";
      return "";
    } });
    const stableKey = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
    const target = path.join(dataDir, "team-workspaces", stableKey("team-1"), stableKey("user-1"), stableKey(project.id));
    await fs.mkdir(path.join(target, ".git"), { recursive: true });
    await expect(dirtyWorkspace.checkout("team-1", project, "user-1"))
      .rejects.toMatchObject({ status: 409 });
  });

  it("creates a GitLab merge-request link from the active member branch", async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dazuibot-team-gitlab-"));
    const gitlabProject = { ...project, id: "gitlab-project", provider: "gitlab" as const, repositoryUrl: "https://gitlab.com/acme/tools/assistant", cloneUrl: "https://gitlab.com/acme/tools/assistant.git" };
    const stableKey = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
    const target = path.join(dataDir, "team-workspaces", stableKey("team-1"), stableKey("user-1"), stableKey(gitlabProject.id));
    await fs.mkdir(path.join(target, ".git"), { recursive: true });
    const workspaces = new TeamWorkspace(dataDir, { runGit: async (args) => {
      if (args.includes("remote")) return gitlabProject.cloneUrl;
      if (args.includes("--show-current")) return "team/member-branch";
      return "";
    } });
    const snapshot = await workspaces.inspect("team-1", gitlabProject, "user-1");
    expect(snapshot.reviewUrl).toContain("gitlab.com/acme/tools/assistant/-/merge_requests/new?");
    const url = new URL(snapshot.reviewUrl!);
    expect(url.searchParams.get("merge_request[source_branch]")).toBe("team/member-branch");
    expect(url.searchParams.get("merge_request[target_branch]")).toBe("main");
  });

  it("reads real local Git status and staged and unstaged diffs without changing the worktree", async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dazuibot-team-real-git-"));
    const stableKey = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
    const target = path.join(dataDir, "team-workspaces", stableKey("team-1"), stableKey("user-1"), stableKey(project.id));
    await fs.mkdir(target, { recursive: true });
    const git = async (...args: string[]) => execFileAsync("git", args, { cwd: target, windowsHide: true });
    await git("init", "--initial-branch=main");
    await git("config", "user.name", "Team Test");
    await git("config", "user.email", "team-test@example.com");
    await fs.writeFile(path.join(target, "tracked.txt"), "original\n");
    await git("add", "tracked.txt");
    await git("commit", "-m", "initial");
    await git("remote", "add", "origin", project.cloneUrl);
    await git("switch", "-c", "team/member-feature");
    await fs.writeFile(path.join(target, "tracked.txt"), "updated\n");
    await git("add", "tracked.txt");
    await fs.writeFile(path.join(target, "new file.txt"), "untracked\n");

    const snapshot = await new TeamWorkspace(dataDir).inspect("team-1", project, "user-1");
    expect(snapshot.branch).toBe("team/member-feature");
    expect(snapshot.files).toEqual(expect.arrayContaining([
      { status: "M", path: "tracked.txt" },
      { status: "??", path: "new file.txt" },
    ]));
    expect(snapshot.diff).toContain("+updated");
    expect(await fs.readFile(path.join(target, "new file.txt"), "utf8")).toBe("untracked\n");
    expect((await git("status", "--porcelain")).stdout).toContain("new file.txt");
  });
});
