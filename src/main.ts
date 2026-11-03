/**
 * 一条命令启动全部：内置 magpie（受管）+ 机器人运行时 + 渠道 + 管理界面。
 *   npm start            （数据目录固定 ./data；不读环境变量，要换目录改 <数据目录>/config.json 或换个工作目录）
 */
import { loadConfig } from "./config.js";
import { App } from "./app.js";
import { logger } from "./log.js";

const log = logger("main");

export async function runCli(): Promise<App> {
  const config = loadConfig();
  const app = new App(config);
  await app.start();
  log.info(`数据目录：${config.dataDir}`);
  if (app.web) log.info(`管理界面：${app.web.url}`);
  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`收到 ${sig}，正在退出…`);
    const t = setTimeout(() => process.exit(1), 10_000);
    await app.stop().catch(() => {});
    clearTimeout(t);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  return app;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!);
if (isMain) {
  runCli().catch((e) => {
    log.error((e as Error).stack || String(e));
    process.exit(1);
  });
}
