import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

export function validateTarListing(listing: string): void {
  for (const raw of listing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
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
