import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!process.env.TEAM_TEST_DATABASE_URL) {
  console.error("TEAM_TEST_DATABASE_URL must point to a disposable PostgreSQL database");
  process.exit(2);
}

const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));

// 跑全部涉及数据库的测试：
// - events.postgres.integration.test.ts：LISTEN/NOTIFY 在真实 pg 上的行为
// - postgres.integration.test.ts：完整 HTTP 流程、事务、约束、advisory lock
// - team-service.test.ts：主业务套件（设了 TEAM_TEST_DATABASE_URL 后会自动改连真实 pg）
const targets = [
  "test/events.postgres.integration.test.ts",
  "test/postgres.integration.test.ts",
  "test/team-service.test.ts",
];

const result = spawnSync(process.execPath, [vitest, "run", ...targets], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
