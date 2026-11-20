#!/usr/bin/env node
/**
 * 生成团队服务试点部署包（含 SHA-256 校验文件）。
 *
 * 用法：node scripts/package-pilot.mjs [--out <目录>]
 *
 * 包里只放部署和排查需要的文件：服务源码、迁移、部署配置、示例环境变量、测试。
 * 不放实际 .env、凭据、node_modules、dist 或备份数据。
 *
 * 打包自己写 zip（不依赖系统 tar / zip / Python）：部署机上不一定有这些工具，
 * 而且不同平台的 tar 行为不一致（Windows 的 tar 会把 "C:\..." 当远程主机名）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const root = path.resolve(repo, "..");

const outIndex = process.argv.indexOf("--out");
const outDir = outIndex >= 0 && process.argv[outIndex + 1] ? path.resolve(process.argv[outIndex + 1]) : root;

/** 放进包里的文件；相对 team-service 目录。 */
const INCLUDE = [
  ".dockerignore",
  ".env.example",
  "Dockerfile",
  "README.md",
  "compose.yaml",
  "deploy/code-executor-contract.md",
  "deploy/first-pilot-zh.md",
  "deploy/nginx-team-bootstrap.conf",
  "deploy/nginx-team.conf",
  "deploy/team-proxy-headers.conf",
  "executor/.env.example",
  "executor/Dockerfile",
  "executor/Dockerfile.control",
  "executor/README.md",
  "executor/deploy/kubernetes.yaml",
  "executor/package.json",
  "executor/run-task.mjs",
  // archive.mjs 是 src/archive.ts 的转译产物：runner 用的归档安全检查必须
  // 和被单测覆盖的是同一份代码，所以它和生成脚本都要进包。
  "executor/archive.mjs",
  "executor/build-archive.mjs",
  "executor/src/archive.ts",
  "executor/src/config.ts",
  "executor/src/executor.ts",
  "executor/src/kubernetes.ts",
  "executor/src/main.ts",
  "executor/src/protocol.ts",
  "executor/src/server.ts",
  "executor/test/executor.test.ts",
  "executor/test/runner.test.ts",
  "executor/tsconfig.json",
  "package-lock.json",
  "package.json",
  "scripts/backup.sh",
  "scripts/check-nginx-config.sh",
  "scripts/dev-web.mjs",
  "scripts/load-embedded.mjs",
  "scripts/package-pilot.mjs",
  "scripts/restore-to-new-db.sh",
  "scripts/setup-pilot-env.sh",
  "scripts/test-postgres-local.mjs",
  "scripts/test-postgres.mjs",
  "scripts/web-e2e.mjs",
  "src/code-executor.ts",
  "src/config.ts",
  "src/credentials.ts",
  "src/crypto.ts",
  "src/embedded.ts",
  "src/events.ts",
  "src/http.ts",
  "src/mailer.ts",
  "src/main.ts",
  "src/model-policy.ts",
  "src/model.ts",
  "src/pglite-pool.ts",
  "src/policy-monitoring.ts",
  "src/policy-rules.ts",
  "src/policy-templates.ts",
  "src/service.ts",
  "src/store.ts",
  "src/web-page.ts",
  "src/worker.ts",
  "tsconfig.json",
];

/** 测试与迁移按目录整体带上（文件名会变，逐个列举容易漏）。 */
const INCLUDE_DIRS = ["migrations", "test"];

/** 绝不能进包的东西：真实凭据、依赖、构建产物、缓存。 */
const FORBIDDEN = [
  /(^|\/)\.env$/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /\.log$/,
  /(^|\/)backups?(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  // 本地验收用的临时数据目录：绝对不能进部署包。
  /(^|\/)\.tmp-web-data(\/|$)/,
];

function isForbidden(relative) {
  return FORBIDDEN.some((pattern) => pattern.test(relative));
}

function collect() {
  const files = [];
  for (const relative of INCLUDE) {
    const absolute = path.join(repo, relative);
    if (!fs.existsSync(absolute)) throw new Error(`缺少文件：${relative}`);
    if (isForbidden(relative)) throw new Error(`文件不应进包：${relative}`);
    files.push(relative);
  }
  for (const directory of INCLUDE_DIRS) {
    const absolute = path.join(repo, directory);
    if (!fs.existsSync(absolute)) throw new Error(`缺少目录：${directory}`);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const relative = path.posix.join(directory, entry.name);
      if (isForbidden(relative)) continue;
      files.push(relative);
    }
  }
  return files.sort();
}

// ── 最小 zip 写入器（只存文件，deflate，无目录项）────────────────────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** DOS 时间戳（zip 用的是本地时间，精度 2 秒） */
function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2));
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * 打包时间戳用「源文件的修改时间」，不用打包时刻。
 *
 * 用打包时刻的话，同样的源码每次打出来的 SHA 都不同 —— 那这个 SHA 就没法用来核对
 * 「收到的包和我这份源码是不是一回事」，只能证明文件没被改动过。改成源文件时间后，
 * 源码不变则包逐字节不变，SHA 才能当校验用。
 */
function writeZip(target, entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  // 兜底时间戳：固定值，保证没有源文件时间可用时也还是确定的

  for (const entry of entries) {
    const name = entry.name;
    const nameBytes = Buffer.from(name, "utf8");
    const raw = fs.readFileSync(path.join(repo, entry.source));
    const stamp = dosDateTime(fs.statSync(path.join(repo, entry.source)).mtime);
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // 压缩后反而更大时退回 store
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // flags: UTF-8 名称
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);         // version made by
    header.writeUInt16LE(20, 6);         // version needed
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(stamp.time, 12);
    header.writeUInt16LE(stamp.day, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30);         // extra
    header.writeUInt16LE(0, 32);         // comment
    header.writeUInt16LE(0, 34);         // disk
    header.writeUInt16LE(0, 36);         // internal attrs
    header.writeUInt32LE(0, 38);         // external attrs
    header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, nameBytes]));

    offset += local.length + nameBytes.length + data.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  fs.writeFileSync(target, Buffer.concat([...chunks, centralBuffer, end]));
}

function main() {
  const relatives = collect();
  const entries = relatives.map((relative) => ({ name: `team-service/${relative.split(path.sep).join("/")}`, source: relative }));
  const version = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version ?? "dev";
  // 构建号形如 r5；不要重复 "r" 前缀
  const build = (process.env.PILOT_BUILD ?? new Date().toISOString().slice(0, 10).replace(/-/g, "")).replace(/^r+/, "r");
  const name = `dazuibot-team-service-pilot-ready-${build}.zip`;
  const target = path.join(outDir, name);
  fs.mkdirSync(outDir, { recursive: true });

  writeZip(target, entries);

  const bytes = fs.readFileSync(target);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  const checksumPath = `${target}.sha256`;
  fs.writeFileSync(checksumPath, `${digest}  ${name}\n`);

  console.log(`包：${target}`);
  console.log(`文件数：${entries.length}`);
  console.log(`大小：${bytes.length} 字节`);
  console.log(`SHA-256：${digest}`);
  console.log(`校验文件：${checksumPath}`);
  console.log(`版本：${version}`);
}

main();
