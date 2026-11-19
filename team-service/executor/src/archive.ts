import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

export function validateTarListing(listing: string): void {
  // 解包时用 --strip-components=1 去掉仓库快照的最外层目录，所以清单里每一项
  // 都必须挂在同一个顶层目录下面（GitHub 的 tarball 形如 "Hello-World-master/README"）。
  //
  // 顶层目录自身在清单里表现为 "Hello-World-master/"，去掉首段后是空串 ——
  // 它不是文件，必须放行。之前的实现把空串当成不安全路径，于是所有来自
  // GitHub 的真实快照都在解包前就被拒绝（"repository archive contains an
  // unsafe path"），代码任务永远跑不起来。
  let root: string | undefined;
  for (const raw of listing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const prefix = raw.split("/")[0];
    if (!prefix || prefix.includes("\0")) throw new Error("repository archive contains an unsafe path");
    if (root === undefined) root = prefix;
    else if (root !== prefix) throw new Error("repository archive contains entries from multiple root directories");
    // 顶层目录条目自身：去首段后为空，放行。
    if (raw.endsWith("/")) continue;
    const name = raw.replace(/^[^/]+\//, "");
    if (!name || name.includes("\0") || path.posix.isAbsolute(name) || path.win32.isAbsolute(name) || name.split(/[\\/]/).includes("..")) {
      throw new Error("repository archive contains an unsafe path");
    }
  }
}

export function validateTarVerboseListing(listing: string): void {
  for (const line of listing.split(/\r?\n/).filter(Boolean)) {
    const type = line[0];
    if (type !== "-" && type !== "d") throw new Error("repository archives may contain only regular files and directories");
  }
}

async function tar(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn("tar", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const [code] = await once(child, "close") as [number | null];
  return { code: code ?? 1, stdout, stderr };
}

export async function extractRepositoryArchive(archive: string, destination: string): Promise<void> {
  const listing = await tar(["--list", "--gzip", "--file", archive]);
  if (listing.code !== 0) throw new Error("repository archive is not a valid gzip tar archive");
  validateTarListing(listing.stdout);
  const extracted = await tar(["--extract", "--gzip", "--file", archive, "--strip-components=1", "--no-same-owner", "--no-same-permissions", "--directory", destination]);
  if (extracted.code !== 0) throw new Error(`repository archive extraction failed: ${extracted.stderr.slice(0, 400)}`);
}
