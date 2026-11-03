// 站点链接：都带来源参数，后台用它统计从本程序来的注册与充值。
// 全项目统一 utm_source=zdzui&utm_campaign=amb_<位置>（和 src/modelflare.ts 的 UTM 一致）。
//
// 白标：这里必须是字面量，不能改成读环境变量或由服务端下发。
// 本文件由 web 服务原样吐给渲染进程（server.ts 的 /amb/static/），渲染进程没有 process.env；
// 而这些常量是模块级 export const，在任何请求之前就求值了，改成动态要动所有 import 方。
// TODO(site): 站主确认域名续费后再定稿
export const MF_SITE = "https://api2.zdzui.xyz";
/** 没有独立文档站时指向站点根：拼路径仍然合法，链接不会 404 */
export const MF_DOCS = MF_SITE;

export function mfLink(path, campaign) {
  const u = new URL(path, MF_SITE);
  u.searchParams.set("utm_source", "zdzui");
  if (campaign) u.searchParams.set("utm_campaign", campaign);
  return u.toString();
}

export const MF_CONSOLE = mfLink("/dashboard/overview", "amb_console");
export const MF_KEYS = mfLink("/keys", "amb_keys");
export const MF_SIGNUP = mfLink("/sign-up", "amb_signup");
export const MF_TOPUP = mfLink("/billing", "amb_topup");
export const MF_PRICING = mfLink("/pricing", "amb_pricing");
/** 文档站首页（给人点的链接；MF_DOCS 是基址，拼路径用） */
export const MF_DOCS_LINK = mfLink(MF_DOCS + "/", "amb_docs");

/** 服务端下发的链接（通知等）：是本站的页面、且还没带来源参数时补上；别的网站原样返回 */
export function tagLink(url, campaign) {
  try {
    const u = new URL(url, MF_SITE);
    if (!/(^|\.)zdzui\.xyz$/.test(u.hostname) || u.searchParams.has("utm_source")) return u.toString();
    return mfLink(u.toString(), campaign);
  } catch {
    return url;
  }
}

/** 美元金额：两位小数；很小的数保留四位，避免显示成 $0.00 */
export function usd(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  return `$${Math.abs(v) > 0 && Math.abs(v) < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
}

/**
 * 余额的展示文本。三种"没有数"的状态必须分开说，不要退回「—」——客户会以为余额坏了：
 *   有值        → 金额
 *   有 error    → 拉取失败。像超时/网络错就说「网络未响应」，否则「余额暂不可用」+ 重试
 *   都没有      → 读取中（还没拉过）
 * 服务端的 error 是原样透传的错误消息（fetchKeyBalance 抛出的文案或 fetch 的原生错误），
 * 没有错误码可用，所以这里只能按关键词分类。
 */
export function balanceText(acct, t) {
  const v = acct?.balanceUsd;
  if (v !== null && v !== undefined && Number.isFinite(Number(v))) return usd(v);
  const err = String(acct?.error || "");
  if (!err) return t("common.balance.pending");
  return /timeout|timed out|abort|fetch failed|network|ECONN|ENOTFOUND|ETIMEDOUT/i.test(err)
    ? t("common.balance.network")
    : t("common.balance.unavailable");
}
