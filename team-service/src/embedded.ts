import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import type { Config } from "./config.js";
import { createTeamHttpServer } from "./http.js";
import { SmtpMailer } from "./mailer.js";
import { TeamEventHub } from "./events.js";
import { TeamService } from "./service.js";
import { Store } from "./store.js";
import { TeamWorker } from "./worker.js";
import { CodeTaskDispatcher } from "./code-executor.js";

/**
 * 内嵌模式：把团队服务跑在桌面应用自己进程里，数据库用进程内的 PGlite，
 * 不需要另外装 Postgres，也不需要另外起一个服务进程。
 *
 * 对外仍然是一个本机 HTTP 服务（团队版界面和桌面端都用 HTTP 访问它），
 * 但监听地址只绑定回环地址。
 */

export interface EmbeddedOptions {
  /** 数据目录：PGlite 数据、密钥都放这里 */
  dataDir: string;
  host?: string;
  port?: number;
  /** 团队模型网关；不填就用默认 */
  modelBaseUrl?: string;
  /** 已知的模型目录 */
  modelCatalog?: string[];
  /** 外部 SMTP；不填就用开发验证码登录 */
  smtpUrl?: string;
  mailFrom?: string;
  /** 允许任意来源（桌面端从本地 UI 访问） */
  corsOrigins?: string[];
  /** 开发模式：登录验证码直接在响应里返回，方便本地使用 */
  allowDevCodes?: boolean;
}

export interface EmbeddedService {
  /** 实际监听的地址，例如 http://127.0.0.1:53123 */
  url: string;
  port: number;
  config: Config;
  store: Store;
  service: TeamService;
  close(): Promise<void>;
}

interface EmbeddedSecrets {
  sessionSecret: string;
  credentialSecret: string;
}

/** 会话密钥和凭据密钥要长期有效，所以落到数据目录里，重启后还能继续用同一个会话。 */
async function loadSecrets(dataDir: string): Promise<EmbeddedSecrets> {
  const file = path.join(dataDir, "team-embedded-secrets.json");
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<EmbeddedSecrets>;
    if (typeof parsed.sessionSecret === "string" && parsed.sessionSecret.length >= 32 && typeof parsed.credentialSecret === "string" && parsed.credentialSecret.length >= 32) {
      return { sessionSecret: parsed.sessionSecret, credentialSecret: parsed.credentialSecret };
    }
  } catch {
    // 还没有密钥文件，或者读坏了：重新生成一份。
  }
  const secrets: EmbeddedSecrets = {
    sessionSecret: randomBytes(32).toString("hex"),
    credentialSecret: randomBytes(32).toString("hex"),
  };
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, JSON.stringify(secrets), { mode: 0o600 });
  return secrets;
}

/** 启动内嵌的团队服务。 */
export async function startEmbeddedTeamService(options: EmbeddedOptions): Promise<EmbeddedService> {
  const dataDir = path.join(options.dataDir, "team-embedded");
  await mkdir(dataDir, { recursive: true });
  const secrets = await loadSecrets(dataDir);
  const host = options.host ?? "127.0.0.1";
  const allowDevCodes = options.allowDevCodes ?? !options.smtpUrl;

  const config: Config = {
    host,
    port: options.port ?? 0,
    databaseUrl: `pglite://${dataDir}`,
    sessionSecret: secrets.sessionSecret,
    credentialSecret: secrets.credentialSecret,
    modelBaseUrl: options.modelBaseUrl ?? "https://api.zdzui.xyz/v1",
    modelCatalog: options.modelCatalog ?? [],
    publicUrl: `http://${host}:${options.port ?? 0}`,
    mailFrom: options.mailFrom ?? "Dazuibot Teams <noreply@localhost>",
    smtpUrl: options.smtpUrl ?? "",
    codeExecutorUrl: "",
    codeExecutorBrokerUrl: `http://${host}:${options.port ?? 0}`,
    codeExecutorSecret: "",
    codeExecutorPollMs: 1_000,
    corsOrigins: new Set(options.corsOrigins ?? []),
    allowDevCodes,
    production: false,
  };

  const store = Store.embedded(config, path.join(dataDir, "pgdata"));
  await store.migrate();

  const mailer = config.smtpUrl ? new SmtpMailer(config) : undefined;
  const service = new TeamService(config, store, mailer);
  const events = new TeamEventHub(store.pool);
  events.start();

  const server: Server = createTeamHttpServer(config, store, service, events);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;

  const worker = new TeamWorker(config, store, { events, onError: (kind) => console.error("team worker item failed", { kind }) });
  worker.start();
  const codeExecutor = new CodeTaskDispatcher(config, service);
  codeExecutor.start();

  let closed = false;
  return {
    url: `http://${host}:${port}`,
    port,
    config,
    store,
    service,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await worker.stop();
      await codeExecutor.stop();
      await events.stop();
      await store.close();
    },
  };
}
