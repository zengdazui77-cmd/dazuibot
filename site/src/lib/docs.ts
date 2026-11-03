// 导航、页脚和 FAQ 里的"文档"：指向 dazuibot 自己的 README（中英文各一份），不是 zdzui 的 API 文档。
// README 讲下载、功能、隐私和参与贡献；更细的开发说明在仓库的 docs/ 里，从 README 能点过去。
import type { Lang } from "../i18n";
import { GITHUB_URL } from "./site";

/** 文档入口：开发文档在仓库里（README / docs/development.md）。还没建仓库时返回 null，调用方不要渲染这个入口 */
export const docsUrl = (lang: Lang): string | null =>
  GITHUB_URL ? (lang === "zh" ? `${GITHUB_URL}#readme` : `${GITHUB_URL}/blob/master/README_en.md`) : null;
