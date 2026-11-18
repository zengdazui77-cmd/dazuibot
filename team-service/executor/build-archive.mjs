#!/usr/bin/env node
// 从 src/archive.ts 生成 runner 用的 archive.mjs。
//
// 为什么需要这一步：runner 镜像是纯 Node（不装 TypeScript、不编译控制器），
// 但归档安全检查必须和被单测覆盖的那份**是同一份代码**——
// 两份逻辑一旦分叉，被测过的就不是真正跑着的那份。
//
// 所以这里不是「再写一份 JS」，而是用 TypeScript 自己的编译器把 TS 源转成 JS。
// 生成后由 test/runner.test.ts 校验：archive.mjs 存在、能导入、
// 且对同样的输入给出同样的判断。
//
// 用 tsc CLI 而不是 require("typescript")：本仓库用的是 TypeScript 7（Go 版），
// 它的 JS API 只剩 version/versionMajorMinor，没有 transpileModule。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "src", "archive.ts");
const target = path.join(here, "archive.mjs");

/** 找一个能用的 tsc：先看 executor 自己的，再看 team-service 的，最后看仓库根的。 */
function findTsc() {
  const name = process.platform === "win32" ? "tsc.cmd" : "tsc";
  const candidates = [
    path.join(here, "node_modules", ".bin", name),
    path.join(here, "..", "node_modules", ".bin", name),
    path.join(here, "..", "..", "node_modules", ".bin", name),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("找不到 tsc：先在 team-service 或仓库根目录跑 npm ci");
}

const args = [
  source, "--ignoreConfig", "--target", "ES2023", "--module", "ESNext",
  "--moduleResolution", "bundler", "--outDir", "<OUT>",
];

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "dz-archive-"));
try {
  const tsc = findTsc();
  // --ignoreConfig：不要读 executor/tsconfig.json（它会按 src/**/*.ts 全量编译）
  // 不加 --types node：这个脚本只求转译产物，类型检查由 executor 的 tsc -p 负责。
  const finalArgs = args.map((part) => (part === "<OUT>" ? outDir : part));
  // Windows 上 .cmd 必须经由 shell 启动（直接 spawnSync 会 EINVAL）。
  const command = process.platform === "win32"
    ? `"${tsc}" ${finalArgs.map((part) => `"${part}"`).join(" ")}`
    : [tsc, ...finalArgs].map((part) => `'${part.replace(/'/g, "'\\''")}'`).join(" ");
  const result = spawnSync(command, { cwd: here, encoding: "utf8", shell: true });

  const produced = path.join(outDir, "archive.js");
  if (!fs.existsSync(produced)) {
    console.error(result.stdout || "");
    console.error(result.stderr || "");
    throw new Error("tsc 没有产出 archive.js");
  }
  const js = fs.readFileSync(produced, "utf8");
  if (/\binterface\b/.test(js) || /:\s*string\b/.test(js)) {
    throw new Error("转译结果里还有类型标注，跑不起来");
  }
  fs.writeFileSync(target, js);
  console.log(`已生成 ${path.relative(process.cwd(), target)}`);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
