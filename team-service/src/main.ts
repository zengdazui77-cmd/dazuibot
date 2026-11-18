import { loadConfig } from "./config.js";
import { createTeamHttpServer } from "./http.js";
import { SmtpMailer } from "./mailer.js";
import { TeamService } from "./service.js";
import { Store } from "./store.js";
import { TeamWorker } from "./worker.js";
import { TeamEventHub } from "./events.js";
import { CodeTaskDispatcher } from "./code-executor.js";

const config = loadConfig();
const store = new Store(config);
await store.migrate();
const mailer = config.smtpUrl ? new SmtpMailer(config) : undefined;
const service = new TeamService(config, store, mailer);
const events = new TeamEventHub(store.pool);
events.start();
const server = createTeamHttpServer(config, store, service, events);
server.listen(config.port, config.host, () => console.log(`dazuibot team service listening on ${config.host}:${config.port}`));
const worker = new TeamWorker(config, store, { events, onError: (kind) => console.error("team worker item failed", { kind }) });
worker.start();
const codeExecutor = new CodeTaskDispatcher(config, service);
codeExecutor.start();

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  server.close(async () => {
    await worker.stop();
    await codeExecutor.stop();
    await events.stop();
    await store.close();
    process.exitCode = 0;
  });
  setTimeout(() => { process.exitCode = 1; process.exit(); }, 10_000).unref();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
