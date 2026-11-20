/**
 * 本地起一个团队服务，用来在浏览器里手工验收 Web 端团队界面。
 *
 * 用法：
 *   npm run dev:web            # 默认 8790 端口
 *   PORT=9000 npm run dev:web  # 换端口
 *
 * 走的是内嵌模式（数据落在系统临时目录），和桌面端内嵌跑的是同一条代码路径。
 */
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { startEmbeddedTeamService } from "../src/embedded.js";

const port = Number(process.env.PORT ?? 8790);
// 数据目录放在仓库外面，免得打包时被带进去（打包脚本也会再挡一次）。
// 注意：baseDir 一定要经过 path.join，哪怕设了环境变量也一样——
// 之前写成 `process.env.X ?? path.join(...)` 时，设了环境变量就把 path.join 跳过了，
// 漏掉的 import 也就没被发现。
//
// 默认目录里再带一段进程号：下面每次启动都会把数据目录整个删掉重来，
// 目录要是共享的，两个实例同时跑就会把对方的库删了（表现是 PGlite 报
// "could not seek to end of file"）。用进程号隔开就撞不上了。
const baseDir = process.env.DEV_WEB_DATA_DIR ?? path.join(os.tmpdir(), "dazuibot-team-web-dev");
const dataDir = path.join(baseDir, `team-web-dev-${process.pid}`);

// 每次启动都从干净状态开始，方便反复验收。
await rm(dataDir, { recursive: true, force: true });

const embedded = await startEmbeddedTeamService({
  dataDir,
  host: "127.0.0.1",
  port,
  modelCatalog: ["gpt-4o", "gpt-4o-mini", "claude-sonnet-4"],
  allowDevCodes: true,
});

console.log("团队服务已启动：", embedded.url);
console.log("Web 界面：", embedded.url + "/");
console.log("按 Ctrl+C 退出。");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void embedded.close().then(() => process.exit(0));
  });
}
