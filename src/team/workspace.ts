import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { TeamApiError, type TeamProject } from "./client.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
const MAX_GIT_OUTPUT = 1_000_000;
const MAX_DIFF_PREVIEW_CHARS = 80_000;

export interface WorkspaceResult {
  path: string;
  branch: string;
  reused: boolean;
}

export interface WorkspaceSnapshot {
  available: boolean;
  path?: string;
  branch?: string;
  files: Array<{ status: string; path: string }>;
  filesTruncated: boolean;
  diff: string;
  diffTruncated: boolean;
  reviewUrl?: string;
}

export interface WorkspaceOptions {
  runGit?: (args: string[]) => Promise<string>;
}

export class TeamWorkspace {
  private readonly root: string;

  constructor(dataDir: string, private readonly options: WorkspaceOptions = {}) {
    this.root = path.resolve(dataDir, "team-workspaces");
  }

  async checkout(teamId: string, project: TeamProject, userId: string, email = "member"): Promise<WorkspaceResult> {
    const { cloneUrl, defaultBranch } = validateProject(project);
    const teamKey = stableKey(teamId);
    const projectKey = stableKey(project.id);
    const memberKey = stableKey(userId);
    const projectDir = path.resolve(this.root, teamKey, memberKey, projectKey);
    ensureInside(this.root, projectDir);
    const memberName = email.split("@")[0]!.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "member";
    const branch = `team/${teamKey}/${memberName}-${memberKey.slice(0, 8)}`;
    await mkdir(path.dirname(projectDir), { recursive: true });

    if (await exists(projectDir)) return this.openExisting(projectDir, branch, cloneUrl, defaultBranch);

    const stagingDir = path.join(path.dirname(projectDir), `${projectKey}.clone-${randomBytes(8).toString("hex")}`);
    ensureInside(this.root, stagingDir);
    try {
      await this.git(["clone", "--branch", defaultBranch, "--single-branch", "--no-tags", cloneUrl, stagingDir]);
      await this.git(["-C", stagingDir, "switch", "-c", branch]);
      try { await rename(stagingDir, projectDir); }
      catch (error) {
        if (await exists(projectDir)) {
          await rm(stagingDir, { recursive: true, force: true });
          return this.openExisting(projectDir, branch, cloneUrl, defaultBranch);
        }
        throw error;
      }
      return { path: projectDir, branch, reused: false };
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof TeamApiError) throw error;
      throw new TeamApiError(502, `Could not clone the team project. Check that Git is installed and this account can access the repository. ${(error as Error).message.slice(0, 180)}`);
    }
  }

  async inspect(teamId: string, project: TeamProject, userId: string): Promise<WorkspaceSnapshot> {
    const { cloneUrl, defaultBranch } = validateProject(project);
    const teamKey = stableKey(teamId);
    const projectKey = stableKey(project.id);
    const memberKey = stableKey(userId);
    const projectDir = path.resolve(this.root, teamKey, memberKey, projectKey);
    ensureInside(this.root, projectDir);
    if (!await exists(projectDir)) return { available: false, files: [], filesTruncated: false, diff: "", diffTruncated: false };

    try {
      const remote = await this.git(["-C", projectDir, "remote", "get-url", "origin"]);
      if (normalizeRemote(remote) !== normalizeRemote(cloneUrl)) {
        throw new TeamApiError(409, "A different repository already uses this local workspace path; existing files were left untouched.");
      }
      const [branch, status, workingDiff, stagedDiff] = await Promise.all([
        this.git(["-C", projectDir, "branch", "--show-current"]),
        this.git(["-C", projectDir, "status", "--porcelain=v1", "--untracked-files=all", "-z"]),
        this.git(["-C", projectDir, "--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3"]),
        this.git(["-C", projectDir, "--no-pager", "diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3"]),
      ]);
      const statusEntries = status.split("\0");
      const allFiles: Array<{ status: string; path: string }> = [];
      for (let index = 0; index < statusEntries.length; index += 1) {
        const line = statusEntries[index]!;
        if (line.length < 4) continue;
        const code = line.slice(0, 2).trim() || "??";
        let filePath = line.slice(3);
        if (/[RC]/.test(code) && statusEntries[index + 1]) {
          const sourcePath = statusEntries[++index]!;
          filePath = `${sourcePath} -> ${filePath}`;
        }
        allFiles.push({ status: code, path: filePath });
      }
      const combinedDiff = [workingDiff.trimEnd(), stagedDiff.trimEnd()].filter(Boolean).join("\n\n");
      return {
        available: true,
        path: projectDir,
        branch: branch.trim(),
        files: allFiles.slice(0, 200),
        filesTruncated: allFiles.length > 200,
        diff: combinedDiff.slice(0, MAX_DIFF_PREVIEW_CHARS),
        diffTruncated: combinedDiff.length > MAX_DIFF_PREVIEW_CHARS,
        reviewUrl: reviewUrl(project, defaultBranch, branch.trim()),
      };
    } catch (error) {
      if (error instanceof TeamApiError) throw error;
      throw new TeamApiError(409, `Could not inspect the local team workspace. Existing files were left untouched. ${(error as Error).message.slice(0, 180)}`);
    }
  }

  private async openExisting(projectDir: string, branch: string, cloneUrl: string, defaultBranch: string): Promise<WorkspaceResult> {
    try {
      const remote = await this.git(["-C", projectDir, "remote", "get-url", "origin"]);
      if (normalizeRemote(remote) !== normalizeRemote(cloneUrl)) throw new TeamApiError(409, "A different repository already uses this local workspace path; existing files were left untouched.");
      const status = await this.git(["-C", projectDir, "status", "--porcelain"]);
      const currentBranch = (await this.git(["-C", projectDir, "branch", "--show-current"])).trim();
      if (currentBranch === branch) return { path: projectDir, branch, reused: true };
      if (status.trim()) throw new TeamApiError(409, `This workspace has local changes on branch ${currentBranch || "(detached)"}. Commit or stash them before switching to the team branch.`);
      const localBranch = await this.git(["-C", projectDir, "branch", "--list", branch]);
      if (localBranch.trim()) await this.git(["-C", projectDir, "switch", branch]);
      else {
        await this.git(["-C", projectDir, "fetch", "--no-tags", "origin", defaultBranch]);
        await this.git(["-C", projectDir, "switch", "-c", branch, "FETCH_HEAD"]);
      }
      return { path: projectDir, branch, reused: true };
    } catch (error) {
      if (error instanceof TeamApiError) throw error;
      throw new TeamApiError(409, `Could not prepare the existing team workspace. Existing files were left untouched. ${(error as Error).message.slice(0, 180)}`);
    }
  }

  private async git(args: string[]): Promise<string> {
    if (this.options.runGit) return this.options.runGit(args);
    try {
      const result = await execFileAsync("git", args, {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_OUTPUT,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return String(result.stdout ?? "");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Git command failed";
      throw new Error(detail.slice(0, 220));
    }
  }
}

function validateProject(project: TeamProject): { cloneUrl: string; defaultBranch: string } {
  const raw = project.cloneUrl;
  let url: URL;
  try { url = new URL(raw); } catch { throw new TeamApiError(502, "The team service returned an invalid repository URL"); }
  const host = url.hostname.toLowerCase();
  if ((host !== "github.com" && host !== "gitlab.com") || url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash) {
    throw new TeamApiError(502, "The team service returned a repository URL that is not allowed");
  }
  if (project.provider !== (host === "github.com" ? "github" : "gitlab")) throw new TeamApiError(502, "The repository provider does not match its URL");
  let repositoryUrl: URL;
  try { repositoryUrl = new URL(project.repositoryUrl); } catch { throw new TeamApiError(502, "The team service returned an invalid repository page URL"); }
  if (repositoryUrl.protocol !== "https:" || repositoryUrl.hostname.toLowerCase() !== host || repositoryUrl.port || repositoryUrl.username || repositoryUrl.password ||
      repositoryUrl.search || repositoryUrl.hash || normalizeRemote(repositoryUrl.toString()) !== normalizeRemote(url.toString())) {
    throw new TeamApiError(502, "The team service returned a repository page URL that does not match its clone URL");
  }
  const branch = project.defaultBranch;
  if (typeof branch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(branch) || branch.includes("..") || branch.includes("//") || branch.endsWith("/") || branch.endsWith(".") || branch.endsWith(".lock")) {
    throw new TeamApiError(502, "The team service returned an invalid default branch");
  }
  return { cloneUrl: url.toString(), defaultBranch: branch };
}

function reviewUrl(project: TeamProject, defaultBranch: string, branch: string): string | undefined {
  if (!branch) return undefined;
  const repository = new URL(project.repositoryUrl);
  if (project.provider === "github") {
    const encodePath = (value: string) => value.split("/").map(encodeURIComponent).join("/");
    repository.pathname = `${repository.pathname.replace(/\/$/, "")}/compare/${encodePath(defaultBranch)}...${encodePath(branch)}`;
    return repository.toString();
  }
  repository.pathname = `${repository.pathname.replace(/\/$/, "")}/-/merge_requests/new`;
  repository.searchParams.set("merge_request[source_branch]", branch);
  repository.searchParams.set("merge_request[target_branch]", defaultBranch);
  return repository.toString();
}

function normalizeRemote(value: string): string {
  try {
    const url = new URL(value.trim());
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
    return url.toString().replace(/\/$/, "");
  } catch { return ""; }
}

function stableKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function ensureInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (!relative || relative === "." || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new TeamApiError(400, "Invalid team workspace path");
  }
}

async function exists(target: string): Promise<boolean> {
  try { await access(target); return true; } catch { return false; }
}
