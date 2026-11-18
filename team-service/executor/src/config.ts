import { isIP } from "node:net";

export interface ExecutorConfig {
  host: string;
  port: number;
  teamApiUrl: string;
  apiUrl: string;
  secret: string;
  namespace: string;
  apiNamespace: string;
  runnerImage: string;
  kubeApiUrl: string;
  kubeTokenPath: string;
  kubeCaPath: string;
  maxRuntimeSeconds: number;
  heartbeatMs: number;
  maxOutputBytes: number;
  maxArchiveBytes: number;
}

function numberEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const value = Number(env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}`);
  return value;
}

function safeOrigin(raw: string, key: string, production: boolean): string {
  const url = new URL(raw);
  const privateHttp = !production && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const privateKubernetesService = production && url.protocol === "http:" && (url.hostname.endsWith(".svc") || url.hostname.endsWith(".svc.cluster.local"));
  if ((url.protocol !== "https:" && !(privateHttp && url.protocol === "http:") && !privateKubernetesService) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error(`${key} must be an HTTPS origin without credentials, query, or path in production`);
  }
  if (production && isIP(url.hostname) !== 0) throw new Error(`${key} must use a DNS name in production`);
  return url.toString().replace(/\/$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ExecutorConfig {
  const production = env.NODE_ENV === "production";
  const teamApiUrl = safeOrigin((env.TEAM_API_URL ?? "").trim(), "TEAM_API_URL", production);
  const apiUrl = safeOrigin((env.EXECUTOR_API_URL ?? teamApiUrl).trim(), "EXECUTOR_API_URL", production);
  const secret = env.TEAM_CODE_EXECUTOR_SECRET ?? "";
  if (secret.length < 32) throw new Error("TEAM_CODE_EXECUTOR_SECRET must be at least 32 characters");
  const namespace = env.EXECUTOR_NAMESPACE ?? "dazuibot-team";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace)) throw new Error("EXECUTOR_NAMESPACE must be a Kubernetes namespace name");
  const apiNamespace = env.EXECUTOR_API_NAMESPACE ?? "dazuibot-team";
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(apiNamespace)) throw new Error("EXECUTOR_API_NAMESPACE must be a Kubernetes namespace name");
  const runnerImage = (env.EXECUTOR_RUNNER_IMAGE ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9./:_-]{0,180}@sha256:[a-f0-9]{64}$/.test(runnerImage)) throw new Error("EXECUTOR_RUNNER_IMAGE must use an immutable sha256 digest");
  const kubeApiUrl = safeOrigin(env.KUBERNETES_API_URL ?? "https://kubernetes.default.svc", "KUBERNETES_API_URL", production);
  return {
    host: env.EXECUTOR_HOST ?? "0.0.0.0",
    port: numberEnv(env, "EXECUTOR_PORT", 9888, 1, 65535),
    teamApiUrl,
    apiUrl,
    secret,
    namespace,
    apiNamespace,
    runnerImage,
    kubeApiUrl,
    kubeTokenPath: env.KUBERNETES_TOKEN_PATH ?? "/var/run/secrets/kubernetes.io/serviceaccount/token",
    kubeCaPath: env.KUBERNETES_CA_PATH ?? "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
    maxRuntimeSeconds: numberEnv(env, "EXECUTOR_MAX_RUNTIME_SECONDS", 1_200, 30, 7_200),
    heartbeatMs: numberEnv(env, "EXECUTOR_HEARTBEAT_MS", 15_000, 1_000, 30_000),
    maxOutputBytes: numberEnv(env, "EXECUTOR_MAX_OUTPUT_BYTES", 2 * 1024 * 1024, 16 * 1024, 50 * 1024 * 1024),
    maxArchiveBytes: numberEnv(env, "EXECUTOR_MAX_ARCHIVE_BYTES", 50 * 1024 * 1024, 1 * 1024 * 1024, 200 * 1024 * 1024),
  };
}
