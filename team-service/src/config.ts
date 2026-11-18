import { isIP } from "node:net";

export interface Config {
  host: string;
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  credentialSecret: string;
  modelBaseUrl: string;
  /** 部署侧登记的可用模型目录（mode=catalog 时成员的授权范围） */
  modelCatalog: string[];
  publicUrl: string;
  mailFrom: string;
  smtpUrl: string;
  codeExecutorUrl: string;
  codeExecutorBrokerUrl: string;
  codeExecutorSecret: string;
  codeExecutorPollMs: number;
  corsOrigins: Set<string>;
  allowDevCodes: boolean;
  production: boolean;
}

function validDnsHostname(value: string): boolean {
  if (value.length < 1 || value.length > 253) return false;
  return value.split(".").every((label) => label.length >= 1 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

function isKubernetesServiceHost(value: string): boolean {
  return value.endsWith(".svc") || value.endsWith(".svc.cluster.local");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  const sessionSecret = env.TEAM_SESSION_SECRET ?? "";
  const credentialSecret = env.TEAM_CREDENTIAL_SECRET ?? (production ? "" : sessionSecret);
  const smtpUrl = env.TEAM_SMTP_URL ?? "";
  const mailFrom = env.TEAM_MAIL_FROM?.trim() ?? "";
  const codeExecutorUrlRaw = (env.TEAM_CODE_EXECUTOR_URL ?? "").trim();
  const codeExecutorBrokerUrlRaw = (env.TEAM_CODE_EXECUTOR_BROKER_URL ?? "").trim();
  const codeExecutorSecret = env.TEAM_CODE_EXECUTOR_SECRET ?? "";
  if (codeExecutorUrlRaw && codeExecutorSecret.length < 32) throw new Error("TEAM_CODE_EXECUTOR_SECRET must be at least 32 characters when an executor URL is configured");
  const allowDevCodes = env.TEAM_ALLOW_DEV_CODES === "true" && !production;
  if (sessionSecret.length < 32) throw new Error("TEAM_SESSION_SECRET must be at least 32 characters");
  if (credentialSecret.length < 32) throw new Error("TEAM_CREDENTIAL_SECRET must be at least 32 characters");
  if ((production || env.TEAM_CREDENTIAL_SECRET !== undefined) && credentialSecret === sessionSecret) {
    throw new Error("TEAM_CREDENTIAL_SECRET must be different from TEAM_SESSION_SECRET");
  }
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (production && !smtpUrl) throw new Error("TEAM_SMTP_URL is required in production");
  if (production && (!mailFrom || /@localhost(?:\b|>)/i.test(mailFrom))) throw new Error("TEAM_MAIL_FROM must be set to a non-local sender address in production");
  if (codeExecutorUrlRaw && (codeExecutorSecret === sessionSecret || codeExecutorSecret === credentialSecret)) {
    throw new Error("TEAM_CODE_EXECUTOR_SECRET must be different from the session and credential secrets");
  }
  if (production && codeExecutorUrlRaw && !codeExecutorBrokerUrlRaw) throw new Error("TEAM_CODE_EXECUTOR_BROKER_URL is required when the production executor is enabled");
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535");
  const publicUrl = new URL(env.TEAM_PUBLIC_URL ?? "http://127.0.0.1:8787");
  if (production && publicUrl.protocol !== "https:") throw new Error("TEAM_PUBLIC_URL must use HTTPS in production");
  if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || (publicUrl.pathname !== "/" && publicUrl.pathname !== "")) {
    throw new Error("TEAM_PUBLIC_URL must be a site origin without credentials, path, query, or fragment");
  }
  if (production) {
    const teamHost = env.TEAM_HOST ?? "";
    if (!validDnsHostname(teamHost) || isIP(teamHost) !== 0 || teamHost.toLowerCase() === "localhost" || teamHost.toLowerCase().endsWith(".localhost")) {
      throw new Error("TEAM_HOST must be a valid DNS hostname in production");
    }
    if (teamHost.toLowerCase() !== publicUrl.hostname.toLowerCase()) {
      throw new Error("TEAM_HOST must match the hostname in TEAM_PUBLIC_URL");
    }
    const smtp = new URL(smtpUrl);
    if (smtp.searchParams.get("tls.rejectUnauthorized") === "false") {
      throw new Error("Production SMTP must verify the server TLS certificate");
    }
    if (smtp.protocol === "smtp:") {
      if (smtp.searchParams.get("requireTLS") !== "true" || smtp.searchParams.get("ignoreTLS") === "true") {
        throw new Error("Production smtp:// URLs must set requireTLS=true and must not ignore TLS");
      }
    } else if (smtp.protocol === "smtps:") {
      if (smtp.searchParams.get("secure") === "false") throw new Error("Production smtps:// URLs must not disable TLS");
    } else {
      throw new Error("TEAM_SMTP_URL must use smtps:// or smtp:// with requireTLS=true in production");
    }
  }
  const rawModelBaseUrl = (env.TEAM_MODEL_BASE_URL ?? "https://api.zdzui.xyz/v1").trim();
  let modelBaseUrl = "";
  if (rawModelBaseUrl) {
    const endpoint = new URL(rawModelBaseUrl);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
    if ((endpoint.protocol !== "https:" && !(local && !production && endpoint.protocol === "http:")) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error("TEAM_MODEL_BASE_URL must use HTTPS without embedded credentials, query, or fragment");
    }
    modelBaseUrl = endpoint.toString().replace(/\/+$/, "");
  }
  let codeExecutorUrl = "";
  if (codeExecutorUrlRaw) {
    const endpoint = new URL(codeExecutorUrlRaw);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
    const clusterService = endpoint.protocol === "http:" && isKubernetesServiceHost(endpoint.hostname);
    if ((endpoint.protocol !== "https:" && !(local && !production && endpoint.protocol === "http:") && !(production && clusterService)) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.pathname !== "/" && endpoint.pathname !== "")) {
      throw new Error("TEAM_CODE_EXECUTOR_URL must use HTTPS without embedded credentials, query, or fragment");
    }
    codeExecutorUrl = endpoint.toString().replace(/\/$/, "");
  }
  let codeExecutorBrokerUrl = "";
  if (codeExecutorBrokerUrlRaw) {
    const endpoint = new URL(codeExecutorBrokerUrlRaw);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
    const clusterService = endpoint.protocol === "http:" && isKubernetesServiceHost(endpoint.hostname);
    if ((endpoint.protocol !== "https:" && !(local && !production && endpoint.protocol === "http:") && !(production && clusterService)) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.pathname !== "/" && endpoint.pathname !== "")) {
      throw new Error("TEAM_CODE_EXECUTOR_BROKER_URL must be an HTTPS origin or a private Kubernetes .svc origin");
    }
    codeExecutorBrokerUrl = endpoint.toString().replace(/\/$/, "");
  }
  const codeExecutorPollMs = Number(env.TEAM_CODE_EXECUTOR_POLL_MS ?? 1_000);
  if (!Number.isInteger(codeExecutorPollMs) || codeExecutorPollMs < 250 || codeExecutorPollMs > 60_000) throw new Error("TEAM_CODE_EXECUTOR_POLL_MS must be between 250 and 60000");
  const modelCatalog = (env.TEAM_MODEL_CATALOG ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= 120 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(item));
  return {
    host: env.HOST ?? "127.0.0.1",
    port,
    databaseUrl: env.DATABASE_URL,
    sessionSecret,
    credentialSecret,
    modelBaseUrl,
    modelCatalog: [...new Set(modelCatalog)],
    publicUrl: publicUrl.toString().replace(/\/$/, ""),
    mailFrom: mailFrom || "Dazuibot Teams <noreply@localhost>",
    smtpUrl,
    codeExecutorUrl,
    codeExecutorBrokerUrl: codeExecutorBrokerUrl || publicUrl.toString().replace(/\/$/, ""),
    codeExecutorSecret,
    codeExecutorPollMs,
    corsOrigins: new Set((env.CORS_ORIGINS ?? "").split(",").map((x) => x.trim()).filter(Boolean)),
    allowDevCodes,
    production,
  };
}
