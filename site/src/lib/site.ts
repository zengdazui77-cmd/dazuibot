// 站点级数据：部署值（环境变量，缺省时保留占位符，生产构建由 check-placeholders 拦下）、下载数据、价格快照。
import { z } from "zod";
import releasesJson from "../data/releases.json";
import snapshotJson from "../data/pricing.snapshot.json";
import githubJson from "../data/github.json";
import type { Snapshot } from "./pricing";

const env = (k: string) => (import.meta.env[k] as string | undefined) || process.env[k] || `{${k}}`;

export const SITE_DOMAIN = env("SITE_DOMAIN");
export const GITHUB_URL = env("GITHUB_URL");
export const SECURITY_EMAIL = env("SECURITY_EMAIL");
// 统计是可选的：没配置时页面不加载统计脚本（不留占位符）
const optional = (k: string) => (import.meta.env[k] as string | undefined) || process.env[k] || "";
export const ANALYTICS_SCRIPT_URL = optional("ANALYTICS_SCRIPT_URL");
export const ANALYTICS_SITE_ID = optional("ANALYTICS_SITE_ID");
export const ORIGIN = `https://${SITE_DOMAIN}`;
/** GitHub 星数的初始值：构建时取（scripts/fetch-github-stars.ts）；页面打开后由 scripts/stars.ts 换成站内 /stars.json 的值 */
export const githubStars = z.object({ stars: z.number().int().nonnegative() }).parse(githubJson).stars;

/** 跳到中转站控制台的链接都带来源参数：全项目统一 utm_source=zdzui&utm_campaign=amb_<位置>，官网是 amb_homepage。
 *  客户端 src/modelflare.ts 的 UTM 是 utm_source=zdzui，ui/lib/links.js 与 test/utm.unit.test.ts
 *  把 amb_ 前缀钉成了品牌契约，官网必须跟它一致，不要改成别的前缀。 */
export const MF_UTM = "utm_source=zdzui&utm_campaign=amb_homepage";
const mf = (url: string) => `${url}${url.includes("?") ? "&" : "?"}${MF_UTM}`;

// 中转站（new-api 二开）就在主域上：站点首页、定价页都挂在 zdzui.xyz。
// 不导出 /docs：本站没有 docs 子站，别造一个不存在的路径。
export const MF = {
  home: mf("https://zdzui.xyz/"),
  pricing: mf("https://zdzui.xyz/pricing"),
};

const Bin = z.object({ url: z.string().min(1), sha256: z.string().min(1), sizeMB: z.number().nonnegative() });
const Releases = z.object({
  version: z.string().min(1),
  publishedAt: z.string().min(1),
  platforms: z.object({
    "win-x64": Bin,
    "mac-arm64": Bin,
    "mac-x64": Bin,
    "linux-x64": Bin,
    docker: z.object({ image: z.string().min(1), command: z.string().min(1) }),
  }),
});
export const releases = Releases.parse(releasesJson);
export type PlatformId = "win-x64" | "mac-arm64" | "mac-x64" | "linux-x64";
export const PLATFORMS: PlatformId[] = ["win-x64", "mac-arm64", "mac-x64", "linux-x64"];

/** 上游历史价格快照（2026-10-30 抓取，不是本站定价）。页面上只用它的非价格事实：
 *  模型清单、厂商、上下文长度、分档阈值；任何具体价格数字都不展示（本站定价以站点后台为准）。 */
export const pricing = snapshotJson as Snapshot;
export const rowOf = (model: string) => pricing.rows.find((r) => r.model === model);
