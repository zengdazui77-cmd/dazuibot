import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const setupScript = fileURLToPath(new URL("../scripts/setup-pilot-env.sh", import.meta.url));
const testDirectories: string[] = [];

afterEach(() => {
  for (const directory of testDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("first-pilot environment setup", () => {
  it("writes a private environment file, safely encodes SMTP credentials, and refuses to overwrite it", () => {
    const directory = mkdtempSync(join(tmpdir(), "dazuibot-team-env-"));
    testDirectories.push(directory);
    for (const name of [".env.example", "compose.yaml", "Dockerfile"]) writeFileSync(join(directory, name), "test fixture\n");

    const smtpPassword = "p@ss:/?&%";
    const answers = [
      " team.acme.co ",
      " smtp.acme.co ",
      " 587 ",
      "owner+test@example.org",
      smtpPassword,
      " o'connor@acme.co ",
      " https://api.acme.co/v1/$model ",
    ].join("\n") + "\n";
    const first = spawnSync("bash", [setupScript], { cwd: directory, encoding: "utf8", input: answers, timeout: 10_000 });
    expect(first.error).toBeUndefined();
    expect(first.status, first.stderr).toBe(0);

    const envPath = join(directory, ".env");
    const env = readFileSync(envPath, "utf8");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect(env).toContain("owner%2Btest%40example.org:p%40ss%3A%2F%3F%26%25@smtp.acme.co:587/?requireTLS=true");
    expect(env).toContain("TEAM_ALLOW_DEV_CODES=false");
    expect(env).toContain("TEAM_CODE_EXECUTOR_URL=\n");
    expect(env).toContain("TEAM_HOST=team.acme.co\n");
    expect(env).toContain("TEAM_PUBLIC_URL=https://team.acme.co\n");
    expect(env).toContain("TEAM_MAIL_FROM='Dazuibot Teams <o\\'connor@acme.co>'");
    expect(env).toContain("TEAM_MODEL_BASE_URL='https://api.acme.co/v1/$model'");
    expect(`${first.stdout}\n${first.stderr}`).not.toContain(smtpPassword);
    expect(`${first.stdout}\n${first.stderr}`).not.toContain("owner+test@example.org");
    expect(`${first.stdout}\n${first.stderr}`).not.toContain("o'connor@acme.co");

    const before = readFileSync(envPath);
    const second = spawnSync("bash", [setupScript], { cwd: directory, encoding: "utf8", input: "", timeout: 10_000 });
    expect(second.error).toBeUndefined();
    expect(second.status).not.toBe(0);
    expect(readFileSync(envPath)).toEqual(before);
    expect(`${second.stdout}\n${second.stderr}`).not.toContain(smtpPassword);
  });
});
