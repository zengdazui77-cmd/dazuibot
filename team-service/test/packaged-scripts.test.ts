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

  it("scripts/load-embedded.mjs 语法正确", () => {
    expect(() => execFileSync(process.execPath, ["--check", path.join(repo, "scripts", "load-embedded.mjs")])).not.toThrow();
  });

  // 打包脚本按白名单收文件。漏掉一个被引用的模块，
  // 部署机上就是「import 不到」——本地有整棵源码树时看不出来。
  it("被打包脚本收进去的文件列表包含所有脚本引用到的模块", () => {
    const packer = fs.readFileSync(path.join(repo, "scripts", "package-pilot.mjs"), "utf8");
    const scripts = fs.readdirSync(path.join(repo, "scripts")).filter((f) => f.endsWith(".mjs"));
    for (const script of scripts) {
      const source = fs.readFileSync(path.join(repo, "scripts", script), "utf8");
      // 只看相对导入（./ 或 ../），忽略 node: 内置模块和第三方包。
      for (const m of source.matchAll(/from\s+"(\.\.?\/[^"]+)"/g)) {
        const target = path.resolve(path.join(repo, "scripts"), m[1]);
        const relative = path.relative(repo, target).split(path.sep).join("/");
        expect(
          packer.includes(`"${relative}"`),
          `scripts/${script} 引用的 ${relative} 没有被打包脚本收进包里`
        ).toBe(true);
      }
    }
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

  // 上面的测试都用 `--import tsx` 起脚本。tsx 会把 import 里的 .js 映射回 .ts，
  // 所以「源码在 src/、编译产物在 dist/」这件事被掩盖了：
  // 直接 `node scripts/web-e2e.mjs` 时 src/embedded.js 并不存在（只有 .ts），
  // 脚本会以 ERR_MODULE_NOT_FOUND 崩掉 —— 而脚本自己的注释里写的用法就是 node。
  // 打包进部署包的正是这些脚本，部署机上只会用 node 跑，所以必须单独测这一条。
  it("scripts/web-e2e.mjs 用 node 直接跑不会因找不到模块而崩", async () => {
    const child = spawn(process.execPath, [path.join(repo, "scripts", "web-e2e.mjs")], {
      cwd: repo,
      env: { ...process.env, E2E_OUT: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dz-e2e-out-")), "out.txt") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += String(c); });
    child.stderr.on("data", (c) => { stderr += String(c); });
    try {
      const result = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), 90_000);
        child.on("exit", (code) => { clearTimeout(timer); resolve(String(code)); });
      });
      // 找不到浏览器时脚本会「跳过并返回 0」，那也是可接受的；
      // 不可接受的是因为模块找不到而失败。
      expect(stderr).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(stderr).not.toContain("Cannot find module");
      if (result !== "timeout" && result !== "0") {
        throw new Error(`scripts/web-e2e.mjs 以 node 直接跑失败（退出码 ${result}）。stdout:
${stdout}
stderr:
${stderr}`);
      }
    } finally {
      child.kill();
    }
  }, 120_000);

  it("scripts/dev-web.mjs 用 node 直接跑不会因找不到模块而崩", async () => {
    const child = spawn(process.execPath, [path.join(repo, "scripts", "dev-web.mjs")], {
      cwd: repo,
      env: { ...process.env, PORT: "0", DEV_WEB_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "dz-devweb-node-")) },
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
      expect(stderr).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(stderr).not.toContain("Cannot find module");
      if (!started) {
        throw new Error(`scripts/dev-web.mjs 用 node 直接跑起不来。stdout:
${stdout}
stderr:
${stderr}`);
      }
    } finally {
      child.kill();
    }
  }, 90_000);
});
