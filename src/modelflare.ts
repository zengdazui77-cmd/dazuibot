/**
 * 上游模型服务（白标：站点自己的中转站）：本程序唯一的模型来源。
 * - 两条线路：国际（global）、中国大陆优化（cn）。飞行中的 POST 不跨主机重定向，
 *   所以线路由用户事先选定，不自动切换。
 * - 连接前用 GET {base}/models + Bearer 校验密钥；错误按状态码给出可操作的说明。
 *
 * 白标：所有地址都烧死在下面的字面量里，**本文件不读任何环境变量**。三条理由都是实测的：
 *   1. 桌面版客户从开始菜单启动，环境变量里没有 AMB_* 变量；本程序也不读 .env
 *      （package.json 依赖里没有 dotenv）。任何"靠环境变量配置"的方案对分发都无效。
 *   2. 同用户可以改自己的环境变量（Windows 上 setx 不需要管理员）。如果目标地址读 env、
 *      白名单又从同一批 env 算出来，白名单就成了自指的，等于没有校验——谁能设 env，
 *      谁就同时决定"往哪发"和"这算不算合法"，客户预付的钱会被静默改道。
 *   3. 不是所有出网都过白名单（校验密钥、查余额、价格目录、能力表都是直接 fetch），
 *      所以只能靠"地址本身就是常量"来保证，事后校验兜不住。
 *
 * 测试要指向本地 mock 用 __setRelayTestEndpoints()：进程内显式调用，不经环境变量触发。
 */
import { t } from "./i18n/index.js";

export type ModelflareLine = "auto" | "global" | "cn";

// TODO(site): 站主确认域名续费后再定稿
/** 站点自己的中转站基址（含 /v1）。白标值，改这里即可 */
const RELAY_GLOBAL = "https://go.zdzui.xyz/v1";
/** 只开了一条线路时，cn 与 global 同址：白名单和线路选择都不会因此失效 */
const RELAY_CN = RELAY_GLOBAL;

export const MODELFLARE_LINES: Record<Exclude<ModelflareLine, "auto">, string> = {
  global: RELAY_GLOBAL,
  cn: RELAY_CN,
};

/**
 * 允许出网的地址，唯一真源就是上面两个字面量。
 * 不要从 MODELFLARE_LINES 之外再算一次，更不要从环境变量派生——那会让校验变成自指的。
 */
export const RELAY_ORIGINS: readonly string[] = [...new Set([RELAY_GLOBAL, RELAY_CN])];

/**
 * 仅测试用的注入点：集成测试要把请求指到本地 mock，而白标构建不读环境变量，
 * 于是改成进程内显式调用。生产代码从不调用它；能改 asar 调用它的前提是已经能改这个程序，
 * 那是另一层失守，不是这里的口子。传 undefined 复位。
 */
let relayTestEndpoints: { base?: string; issuer?: string } = {};

export function __setRelayTestEndpoints(o: { base?: string; issuer?: string } | undefined): void {
  relayTestEndpoints = o ?? {};
}

/**
 * 出网白名单。发布包里恒等于 RELAY_ORIGINS；测试注入的 mock 地址只在注入期间追加。
 * 所以白名单只会被"代码里显式调用过一次的那个函数"扩大，不会被环境变量、配置文件或
 * 服务端下发的内容扩大——这是它和"从当前基址现算"的关键区别。
 */
export function allowedRelayUrls(): string[] {
  const extra = relayTestEndpoints.base ? [relayTestEndpoints.base.replace(/\/+$/, "")] : [];
  return [...new Set([...RELAY_ORIGINS, ...extra])];
}

export const MODELFLARE_PROVIDER = "modelflare";

/**
 * 账户登录（OIDC 授权码 + PKCE）是否可用。
 *
 * 白标关闭：登录走标准 OIDC discovery（GET {issuer}/.well-known/openid-configuration，
 * scope 含 openid profile offline_access account api_keys），而站点用的 new-api 不提供
 * OIDC Provider，这条路必然失败。关掉后界面只剩"粘贴 API Key"一种连接方式，
 * 客户不会点到一个必然报错的按钮。改回 true 即可恢复上游行为（前提是站点侧真的提供 OIDC）。
 */
export const ACCOUNT_LOGIN_ENABLED = false;

/** 站点主页：注册、充值、控制台都在这里（大陆线路通常只开放 /v1，不提供网页） */
// TODO(site): 站主确认域名续费后再定稿
export const MODELFLARE_WEB = "https://api2.zdzui.xyz";

/**
 * 账户登录（OIDC 授权码 + PKCE，RFC 8252 原生应用）。client_id 是公开值：本程序是公共客户端，
 * 没有也不需要客户端密钥；回调到本机 127.0.0.1 的临时端口。
 * 白标后登录已关闭（见 ACCOUNT_LOGIN_ENABLED），这里保留上游公开值仅为不制造无意义的差异。
 */
export const MODELFLARE_CLIENT_ID = "anymodel-bot";
export const MODELFLARE_SCOPES = "openid profile offline_access account api_keys";

/**
 * 注册来源（后台按 utm_source 统计从本程序来的注册与充值）。
 * 白标取值，站点后台要按它区分"来自桌面客户端"的注册。
 */
export const UTM: Record<string, string> = { utm_source: "zdzui" };

/** 登录与账户接口的根。测试可经 __setRelayTestEndpoints 指到本地 mock */
export function modelflareIssuer(): string {
  return (relayTestEndpoints.issuer || MODELFLARE_WEB).replace(/\/+$/, "");
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
 * 调用归因：每个经中转站的请求都带 X-Modelflare-Skill（站点只记到用量日志，
 * 用来统计各集成的调用量）。
 *
 * 头的**名字**保留 X-Modelflare-Skill 不动：它是协议层的东西，改了可能被上游中间件拒绝，
 * 属于不该碰的那一批。变的只是**值的前缀**——站主要按这个值统计"从本客户端来的调用"，
 * 值里挂着上游项目名会把归属算错，所以前缀是本产品名 zdzui-assistant。
 * 站点后台的统计规则要按 `zdzui-assistant/` 配。
 *
 * 版本号允许 semver 的预发布后缀（如 1.0.0-zdzui.1）——白标版正是这种格式，
 * 早期只认纯数字会把归因头整个丢掉，站后台就看不到客户端版本分布了。
 * 仍然拒绝空白、引号、控制字符，避免往请求头里塞东西。
 */
export function skillHeader(version: string): Record<string, string> {
  return /^\d{1,4}(\.\d{1,4}){0,2}(-[0-9A-Za-z][0-9A-Za-z.-]{0,19})?$/.test(version)
    ? { "X-Modelflare-Skill": `zdzui-assistant/${version}` }
    : {};
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

/**
 * 线路 → 基址。返回值只可能来自 RELAY_ORIGINS 里的两个字面量（或测试注入的 mock 地址），
 * 不读环境变量——见文件头第 2 条理由。
 */
export function modelflareBaseUrl(line: ModelflareLine): string {
  if (relayTestEndpoints.base) return relayTestEndpoints.base.replace(/\/+$/, "");
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
       * 能对话的模型（zdzui 标为 kind=text 的；旧版网关没有 kind 时为全部）。
       * 连接时把它们全部写进内置网关的 picks：网关对超过 24 个模型、又没有 picks 的服务商
       * 只放出列表前 24 个，而 zdzui 的列表按字母排，后面的模型会被截掉。
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
  /** USD（zdzui 以美元计价）；站点改了显示单位时原样带回 */
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
