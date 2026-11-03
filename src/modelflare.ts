/**
 * 上游模型服务：本程序唯一的模型来源。
 * - 两条线路：国际（global）、中国大陆优化（cn）。飞行中的 POST 不跨主机重定向，
 *   所以线路由用户事先选定，不自动切换。
 * - 连接前用 GET {base}/models + Bearer 校验密钥；错误按状态码给出可操作的说明。
 *
 * 白标（改接自己的中转站）——全部走环境变量，不必改代码：
 *   AMB_RELAY_GLOBAL   国际线路基址，形如 https://api.example.com/v1
 *   AMB_RELAY_CN       大陆线路基址，同上；不设则退回 AMB_RELAY_GLOBAL
 *   AMB_RELAY_WEB      站点主页（注册 / 充值 / 控制台链接的根）
 *   AMB_RELAY_UTM      注册归因用的 utm_source
 *   AMB_RELAY_CLIENT_ID  自带 OIDC 登录时的 client_id
 */
import { t } from "./i18n/index.js";

export type ModelflareLine = "auto" | "global" | "cn";

const envTrim = (v: string | undefined): string => (v ?? "").trim().replace(/\/+$/, "");

const FALLBACK_GLOBAL = "https://modelflare.dev/v1";
const RELAY_GLOBAL = envTrim(process.env.AMB_RELAY_GLOBAL) || FALLBACK_GLOBAL;
const RELAY_CN = envTrim(process.env.AMB_RELAY_CN) || (envTrim(process.env.AMB_RELAY_GLOBAL) ? RELAY_GLOBAL : "https://origin.modelflare.dev/v1");

export const MODELFLARE_LINES: Record<Exclude<ModelflareLine, "auto">, string> = {
  global: RELAY_GLOBAL,
  cn: RELAY_CN,
};

export const MODELFLARE_PROVIDER = "modelflare";

/** 站点主页：登录、注册、充值、控制台都在这里（大陆线路通常只开放 /v1，不提供网页） */
export const MODELFLARE_WEB = envTrim(process.env.AMB_RELAY_WEB) || "https://modelflare.dev";

/**
 * 账户登录（OIDC 授权码 + PKCE，RFC 8252 原生应用）。client_id 是公开值：本程序是公共客户端，
 * 没有也不需要客户端密钥；回调到本机 127.0.0.1 的临时端口。
 */
export const MODELFLARE_CLIENT_ID = (process.env.AMB_RELAY_CLIENT_ID ?? "").trim() || "anymodel-bot";
export const MODELFLARE_SCOPES = "openid profile offline_access account api_keys";

/**
 * 注册来源（后台按 utm_source 统计从本程序来的注册与充值）。
 * 默认沿用上游项目的取值，自建中转站时用 AMB_RELAY_UTM 换成自己的标识。
 */
export const UTM: Record<string, string> = { utm_source: (process.env.AMB_RELAY_UTM ?? "").trim() || "anymodelbot" };

/** 开发/测试：AMB_MODELFLARE_ISSUER 把登录与账户接口指向本地 mock（界面无法设置） */
export function modelflareIssuer(env: NodeJS.ProcessEnv = process.env): string {
  return (env.AMB_MODELFLARE_ISSUER?.trim() || MODELFLARE_WEB).replace(/\/+$/, "");
}

/** 官网页面链接，带上来源参数 */
export function webUrl(pathname: string, campaign?: string): string {
  const u = new URL(pathname, MODELFLARE_WEB);
  for (const [k, v] of Object.entries(UTM)) u.searchParams.set(k, v);
  if (campaign) u.searchParams.set("utm_campaign", campaign);
  return u.toString();
}

export const SIGNUP_URL = webUrl("/sign-up", "amb_signup");
export const TOPUP_URL = webUrl("/billing", "amb_topup");
export const CONSOLE_URL = webUrl("/dashboard/overview", "amb_console");

/**
 * 调用归因：每个经 Modelflare 的请求都带 X-Modelflare-Skill（Modelflare 只记到用量日志，
 * 用来统计各集成的调用量）。版本必须是纯数字的 1–3 段。
 */
export function skillHeader(version: string): Record<string, string> {
  return /^\d{1,4}(\.\d{1,4}){0,2}$/.test(version) ? { "X-Modelflare-Skill": `anymodel-bot/${version}` } : {};
}

/** 每个开启了预算的机器人有自己的内置网关 provider（自己的 API Key） */
export const BOT_PROVIDER_PREFIX = "mfb-";
export const botProviderId = (botId: string) => BOT_PROVIDER_PREFIX + botId;

const QUALIFIED = /^(modelflare|mfb-[A-Za-z0-9_-]+)\//;

/** 去掉内置网关的 provider 前缀：modelflare/openai/x、mfb-abc/openai/x → openai/x */
export function bareModel(model: string): string {
  return model.replace(QUALIFIED, "");
}

/** 某个机器人专属 provider 列出的模型（模型列表里不展示，避免同一模型出现多次） */
export function isBotProviderModel(model: string): boolean {
  return model.startsWith(BOT_PROVIDER_PREFIX) && model.includes("/");
}

/**
 * 把模型 id 限定到某个 provider。每个请求都显式带 provider：多个 provider 提供同名模型时，
 * 不带前缀的 id 会被内置网关当成一组在它们之间路由，预算就管不住了。
 */
export function routeModel(model: string, providerId: string): string {
  const bare = bareModel(model.trim());
  return bare ? `${providerId}/${bare}` : bare;
}

export function normalizeLine(v: unknown): ModelflareLine {
  return v === "global" || v === "cn" ? v : "auto";
}

/** 线路 → 基址。AMB_MODELFLARE_BASE_URL 仅供开发/测试（指向本地 mock），不经界面设置。 */
export function modelflareBaseUrl(line: ModelflareLine, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AMB_MODELFLARE_BASE_URL?.trim();
  if (override) return override.replace(/\/+$/, "");
  return line === "cn" ? MODELFLARE_LINES.cn : MODELFLARE_LINES.global;
}

/**
 * 交给内置网关的三种对话接口地址：Chat Completions、Responses 都在 {base}（…/v1）下，Anthropic Messages
 * 的地址是根（网关自己拼 /v1/messages）。网关按模型挑：Claude 走 Messages（提示缓存和思考过程只有它保留），
 * 其余走 Chat；上游说某个模型不在这个接口上时，网关换另一个接口再试并记住。
 */
export function modelflareApiBases(baseUrl: string): { chat: string; responses: string; anthropic: string } {
  return { chat: baseUrl, responses: baseUrl, anthropic: baseUrl.replace(/\/v1\/?$/, "") };
}

export type VerifyFailure = "invalid_key" | "forbidden" | "rate_limited" | "upstream" | "network" | "bad_response";

export type VerifyResult =
  | {
      ok: true;
      models: string[];
      /**
       * 能对话的模型（Modelflare 标为 kind=text 的；旧版网关没有 kind 时为全部）。
       * 连接时把它们全部写进内置网关的 picks：网关对超过 24 个模型、又没有 picks 的服务商
       * 只放出列表前 24 个，而 Modelflare 的列表按字母排，后面的模型会被截掉。
       */
      chatModels: string[];
    }
  | { ok: false; code: VerifyFailure; status?: number; message: string; suggestLine?: ModelflareLine };

/** 校验密钥：只发一次 GET /models，不重试、不换线路。 */
export async function verifyModelflareKey(
  baseUrl: string,
  apiKey: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; line?: ModelflareLine } = {},
): Promise<VerifyResult> {
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (e) {
    const host = safeHost(baseUrl);
    return {
      ok: false,
      code: "network",
      message: t("modelflare.unreachable", { host, reason: (e as Error).name === "TimeoutError" ? t("modelflare.timeout") : (e as Error).message }),
      ...(opts.line !== "cn" ? { suggestLine: "cn" as const } : {}),
    };
  }
  if (res.status === 401) return { ok: false, code: "invalid_key", status: 401, message: t("modelflare.invalid_key") };
  if (res.status === 403) return { ok: false, code: "forbidden", status: 403, message: t("modelflare.forbidden") };
  if (res.status === 429) return { ok: false, code: "rate_limited", status: 429, message: t("modelflare.unavailable", { status: 429, retry: retryAfter(res) }) };
  if (!res.ok) return { ok: false, code: "upstream", status: res.status, message: t("modelflare.unavailable", { status: res.status, retry: "" }) };
  try {
    const body = (await res.json()) as { data?: Array<{ id?: unknown; kind?: unknown }> };
    if (!Array.isArray(body.data)) throw new Error("no data[]");
    const rows = body.data.map((m) => ({ id: String(m.id ?? ""), kind: typeof m.kind === "string" ? m.kind : "" })).filter((m) => m.id);
    const classified = rows.some((m) => m.kind);
    return {
      ok: true,
      models: rows.map((m) => m.id).sort(),
      chatModels: rows.filter((m) => !classified || m.kind === "text").map((m) => m.id).sort(),
    };
  } catch {
    return { ok: false, code: "bad_response", status: res.status, message: t("modelflare.bad_models") };
  }
}

function retryAfter(res: Response): string {
  const s = res.headers.get("retry-after");
  return s ? t("modelflare.retry_after", { s }) : "";
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 只用于展示的密钥尾号 */
export function keyTail(key: string): string {
  return key.length > 4 ? key.slice(-4) : "";
}

export interface KeyBalance {
  available: number;
  used: number;
  /** USD（Modelflare 以美元计价）；站点改了显示单位时原样带回 */
  unit: string;
}

/**
 * 只有 API Key（没有登录账户）时的余额：GET {base}/dashboard/billing/credit_grants。
 * 返回的是整个账户钱包，不是这一把 Key 的额度；国内线路也开放这个 /v1 路径。
 */
export async function fetchKeyBalance(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<KeyBalance> {
  const res = await fetchImpl(`${baseUrl}/dashboard/billing/credit_grants`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(t("modelflare.balance_failed", { status: res.status }));
  const body = (await res.json()) as { total_available?: unknown; total_used?: unknown; unit?: unknown };
  const available = Number(body.total_available);
  const used = Number(body.total_used);
  if (!Number.isFinite(available)) throw new Error(t("modelflare.bad_balance"));
  return { available, used: Number.isFinite(used) ? used : 0, unit: typeof body.unit === "string" && body.unit ? body.unit : "USD" };
}
