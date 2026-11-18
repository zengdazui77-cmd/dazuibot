import { loadConfig } from "./config.js";
import { CodeTaskExecutor } from "./executor.js";
import { KubernetesClient } from "./kubernetes.js";
import { createExecutorHttpServer } from "./server.js";

const config = loadConfig();
const kube = new KubernetesClient(config);
const executor = new CodeTaskExecutor(config, kube, { reportError: (kind) => console.error("executor background error", { kind }) });
await executor.start();
const server = createExecutorHttpServer(executor, config.secret);
server.listen(config.port, config.host, () => console.log("team code executor listening", { host: config.host, port: config.port, namespace: config.namespace }));

const stop = () => {
  executor.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
