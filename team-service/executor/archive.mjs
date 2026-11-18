import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
export function validateTarListing(listing) {
    for (const raw of listing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
        const name = raw.replace(/^[^/]+\//, "");
        if (!name || name.includes("\0") || path.posix.isAbsolute(name) || path.win32.isAbsolute(name) || name.split(/[\\/]/).includes("..")) {
            throw new Error("repository archive contains an unsafe path");
        }
    }
}
export function validateTarVerboseListing(listing) {
    for (const line of listing.split(/\r?\n/).filter(Boolean)) {
        const type = line[0];
        if (type !== "-" && type !== "d")
            throw new Error("repository archives may contain only regular files and directories");
    }
}
async function tar(args, cwd) {
    const child = spawn("tar", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const [code] = await once(child, "close");
    return { code: code ?? 1, stdout, stderr };
}
export async function extractRepositoryArchive(archive, destination) {
    const listing = await tar(["--list", "--gzip", "--file", archive]);
    if (listing.code !== 0)
        throw new Error("repository archive is not a valid gzip tar archive");
    validateTarListing(listing.stdout);
    const extracted = await tar(["--extract", "--gzip", "--file", archive, "--strip-components=1", "--no-same-owner", "--no-same-permissions", "--directory", destination]);
    if (extracted.code !== 0)
        throw new Error(`repository archive extraction failed: ${extracted.stderr.slice(0, 400)}`);
}
