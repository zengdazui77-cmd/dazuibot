/**
 * 启动一个一次性的真实 PostgreSQL，跑完真实 pg 集成测试后自动清理。
 *
 * 用法：npm run test:postgres:local
 *
 * 优先用 Docker（postgres:16-alpine）；Docker 不可用时回退到 embedded-postgres
 * （自带 Windows/Linux/macOS 的原生二进制，不需要装数据库）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { tmpdir } = os;

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const PORT = Number(process.env.TEAM_TEST_PORT ?? 55433);
const DB = "dzteam_test";
const USER = "dz";
const PASSWORD = "dzpass";
const CONTAINER = "dz-team-pg-test";

function log(message) {
  process.stdout.write(`[test:postgres:local] ${message}\n`);
}

function dockerAvailable() {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

/** 用 embedded-postgres 起一个本地真实 pg，返回 { stop() } */
async function startEmbedded() {
  // Postgres 的可执行文件路径里如果含中文，initdb 会报
  // "invalid byte sequence for encoding UTF8"。所以整个包要装在纯 ASCII 目录下。
  const pkgDir = path.join(tmpdir(), "dz-team-pg-pkg");
  const installed = existsSync(path.join(pkgDir, "node_modules", "embedded-postgres"));
  if (!installed) {
    log("embedded-postgres 未安装，正在安装到纯 ASCII 目录…");
    rmSync(pkgDir, { recursive: true, force: true });
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "dz-team-pg-pkg", private: true }));
    // Windows 上 npm 是 .cmd，必须走 shell 才能执行
    const install = spawnSync("npm", ["i", "embedded-postgres"], { cwd: pkgDir, stdio: "inherit", shell: true });
    if (install.status !== 0) throw new Error("无法安装 embedded-postgres");
  }
  const { default: EmbeddedPostgres } = await import(
    pathToFileURL(path.join(pkgDir, "node_modules", "embedded-postgres", "dist", "index.js")).href
  );
  // 数据目录同样必须是纯 ASCII 路径
  const dataDir = path.join(tmpdir(), "dz-team-pg-test-data");
  rmSync(dataDir, { recursive: true, force: true });
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: true,
    // 固定 C locale：中文 Windows 默认 locale 是 GBK，initdb 会因编码不匹配失败
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB);
  return {
    async stop() {
      try {
        await pg.stop();
      } catch {
        // 停不掉也不该让测试结果失真
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** 用 Docker 起一个 pg 容器 */
function startDocker() {
  spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  const run = spawnSync("docker", [
    "run", "-d", "--rm", "--name", CONTAINER,
    "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-e", `POSTGRES_DB=${DB}`,
    "-p", `${PORT}:5432`, "postgres:16-alpine",
  ], { stdio: "inherit" });
  if (run.status !== 0) throw new Error("Docker 启动 Postgres 失败");
  log("等待 Postgres 就绪…");
  for (let i = 0; i < 60; i++) {
    const probe = spawnSync("docker", ["exec", CONTAINER, "pg_isready", "-U", USER, "-d", DB], { stdio: "ignore" });
    if (probe.status === 0) return { stop() { spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" }); } };
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},1000)"], { stdio: "ignore" });
  }
  throw new Error("Postgres 启动超时");
}

let server;
if (dockerAvailable()) {
  log("使用 Docker");
  server = startDocker();
} else {
  log("Docker 不可用，改用 embedded-postgres");
  server = await startEmbedded();
}

const url = `postgres://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DB}`;
log(`数据库就绪：${url}`);
log("运行真实 PostgreSQL 集成测试…");

const vitest = path.join(repo, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(process.execPath, [vitest, "run", "test/events.postgres.integration.test.ts", "test/postgres.integration.test.ts", "test/team-service.test.ts"], {
  stdio: "inherit",
  env: { ...process.env, TEAM_TEST_DATABASE_URL: url },
});

await server.stop();
process.exit(result.status ?? 1);
