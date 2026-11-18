import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateTarListing, validateTarVerboseListing } from "../src/archive.js";

/**
 * runner（run-task.mjs）在容器里跑，负责解包仓库快照。
 * 它做的归档安全检查必须和被单测覆盖的那份**是同一份代码**：
 * 两份逻辑一旦分叉，被测过的就不是真正跑着的那份。
 *
 * 这些断言把「runner 用的就是 archive.mjs」钉住：
 *   - runner 必须 import archive.mjs，而不是自己再写一遍检查；
 *   - archive.mjs 必须由 src/archive.ts 生成（build-archive.mjs）；
 *   - 生成的 archive.mjs 与 TS 源对同样的输入给出同样的判断。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const executorDir = path.resolve(here, "..");
const runner = fs.readFileSync(path.join(executorDir, "run-task.mjs"), "utf8");
const generated = path.join(executorDir, "archive.mjs");
const builder = fs.readFileSync(path.join(executorDir, "build-archive.mjs"), "utf8");
const dockerfile = fs.readFileSync(path.join(executorDir, "Dockerfile"), "utf8");

describe("runner 的归档安全检查", () => {
  it("runner 从 archive.mjs 引入检查函数，而不是自己再写一遍", () => {
    expect(runner).toContain("from './archive.mjs'");
    expect(runner).toContain("validateTarListing");
    expect(runner).toContain("validateTarVerboseListing");
    // 旧的内联检查必须已经不在了
    expect(runner).not.toMatch(/may contain only regular files and directories/);
    expect(runner).not.toMatch(/contains an unsafe path/);
  });

  it("archive.mjs 是从 src/archive.ts 生成的", () => {
    expect(fs.existsSync(generated)).toBe(true);
    expect(builder).toContain("src", "archive.ts");
    // 生成脚本必须是真用编译器转译的，不能是手写替换
    expect(builder).toContain("tsc");
  });

  it("生成的 archive.mjs 与 TS 源对同样的输入给出同样的判断", async () => {
    const js = (await import(path.join(executorDir, "archive.mjs").replace(/\\/g, "/"))) as {
      validateTarListing: (listing: string) => void;
      validateTarVerboseListing: (listing: string) => void;
    };
    const listings = [
      "repo/src/index.js\nrepo/package.json\n",
      "repo/ok/file.js\nrepo/../secret\n",
      "repo/a/../../b\n",
      "/etc/passwd\n",
      "C:\\Windows\\system32\n",
      "",
    ];
    for (const listing of listings) {
      const tsResult = capture(() => validateTarListing(listing));
      const jsResult = capture(() => js.validateTarListing(listing));
      expect(jsResult, `归档清单判断不一致：${JSON.stringify(listing)}`).toBe(tsResult);
    }
    const verbose = [
      "-rw-r--r-- 0/0 3 2026-01-01 00:00 repo/a.txt\ndrwxr-xr-x 0/0 0 2026-01-01 00:00 repo/src/",
      "lrwxrwxrwx 0/0 0 2026-01-01 00:00 repo/link -> /etc",
      "crw-rw-rw- 0/0 1 2026-01-01 00:00 repo/dev/null",
    ];
    for (const listing of verbose) {
      const tsResult = capture(() => validateTarVerboseListing(listing));
      const jsResult = capture(() => js.validateTarVerboseListing(listing));
      expect(jsResult, `归档类型判断不一致：${JSON.stringify(listing)}`).toBe(tsResult);
    }
  });

  it("runner 镜像里带上 archive.mjs，并且构建时校验过", () => {
    expect(dockerfile).toContain("archive.mjs");
    // 镜像构建时至少要检查 runner 语法；archive.mjs 也要能被 Node 解析
    expect(dockerfile).toMatch(/node --check \/opt\/dazuibot-executor\/archive\.mjs/);
  });
});

/** 执行一段代码，返回「抛错信息」或空串（没抛错）。 */
function capture(fn: () => void): string {
  try {
    fn();
    return "";
  } catch (error) {
    return (error as Error).message;
  }
}
