import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

/**
 * 打包脚本和本地验收脚本都在部署包里，但它们不在 vitest 的覆盖范围内——
 * 脚本里一个拼错的 import 或漏掉的依赖，只有真跑起来才会发现。
 * 这里把脚本真的拉起来跑一遍，确保「打包进去的东西真能跑」。
 */
describe("打包进包的脚本", () => {
  it("scripts/package-pilot.mjs 语法正确", () => {
    expect(() => execFileSync(process.execPath, ["--check", path.join(repo, "scripts", "package-pilot.mjs")])).not.toThrow();
  });

  it("scripts/dev-web.mjs 语法正确", () => {
    expect(() => execFileSync(process.execPath, ["--check", path.join(repo, "scripts", "dev-web.mjs")])).not.toThrow();
  });

  it("scripts/web-e2e.mjs 语法正确", () => {
    expect(() => execFileSync(process.execPath, ["--check", path.join(repo, "scripts", "web-e2e.mjs")])).not.toThrow();
  });

  it("scripts/dev-web.mjs 用到的 node 内置模块都 import 了", () => {
    const source = fs.readFileSync(path.join(repo, "scripts", "dev-web.mjs"), "utf8");
    const imported = new Set([...source.matchAll(/from\s+"node:(\w+)"/g)].map((m) => m[1]));
    // 数据目录要用 path 拼，端口要用 os.tmpdir 之外的东西时要 os。
    expect(imported.has("path")).toBe(true);
    expect(imported.has("os")).toBe(true);
    // 用到 path.join 就必须真的 import 了 path，不能只 import 别的。
    if (source.includes("path.join")) expect(source).toMatch(/import\s+path\s+from\s+"node:path"/);
  });

  it("scripts/dev-web.mjs 能真的把服务拉起来", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(repo, "scripts", "dev-web.mjs")], {
      cwd: repo,
      env: { ...process.env, PORT: "0", DEV_WEB_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "dz-devweb-")) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += String(c); });
    child.stderr.on("data", (c) => { stderr += String(c); });
    try {
      const started = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 60_000);
        child.stdout.on("data", () => {
          if (stdout.includes("团队服务已启动")) { clearTimeout(timer); resolve(true); }
        });
        child.on("exit", () => { clearTimeout(timer); resolve(false); });
      });
      // 注意：不能写成 expect({stdout,stderr,started}).toEqual({stdout,stderr,started:true})，
      // 那是拿同一个对象跟自己比，永远成立，等于没测。
      if (!started) {
        throw new Error(`scripts/dev-web.mjs 起不来。stdout:
${stdout}
stderr:
${stderr}`);
      }
      expect(stdout).toContain("团队服务已启动");
    } finally {
      child.kill();
    }
  }, 90_000);
});
