/**
 * 来源参数的统一格式：utm_source=zdzui&utm_campaign=amb_<位置>，不带 utm_medium。
 * 站点后台按它统计从本程序（应用、README、官网）来的注册与充值；改格式前先和后台对齐。
 *
 * 这个文件同时是白标的"品牌契约"：域名、utm_source、归因域名判定都钉在这里。
 * 白标改了域名就改这里的期望值——它失败说明客户会点到错的站，比测试变红严重得多。
 */
import { describe, it, expect } from "vitest";
import { UTM, webUrl, SIGNUP_URL, TOPUP_URL, CONSOLE_URL, MODELFLARE_WEB } from "../src/modelflare.js";
// @ts-expect-error 前端模块是无类型的原生 ES 模块
import { mfLink, tagLink, MF_SITE, MF_CONSOLE, MF_DOCS_LINK, MF_KEYS, MF_PRICING, MF_SIGNUP, MF_TOPUP } from "../ui/lib/links.js";

const params = (url: string) => Object.fromEntries(new URL(url).searchParams);
const SITE = "https://api2.zdzui.xyz";

describe("UTM 来源参数", () => {
  it("后端：只有 utm_source 和 amb_ 开头的 utm_campaign", () => {
    expect(UTM).toEqual({ utm_source: "zdzui" });
    expect(params(webUrl("/billing", "amb_low_balance"))).toEqual({ utm_source: "zdzui", utm_campaign: "amb_low_balance" });
    expect(params(SIGNUP_URL)).toEqual({ utm_source: "zdzui", utm_campaign: "amb_signup" });
    expect(params(TOPUP_URL).utm_campaign).toBe("amb_topup");
    expect(params(CONSOLE_URL).utm_campaign).toBe("amb_console");
    // 后端与界面必须指向同一个站点根，否则客户在应用里点链接会分叉到两个域名
    expect(MODELFLARE_WEB).toBe(SITE);
    expect(new URL(SIGNUP_URL).origin).toBe(SITE);
  });

  it("界面：所有固定链接都是 amb_ 开头，没有 utm_medium", () => {
    expect(MF_SITE).toBe(SITE);
    for (const url of [MF_CONSOLE, MF_KEYS, MF_SIGNUP, MF_TOPUP, MF_PRICING, MF_DOCS_LINK]) {
      const p = params(url);
      expect(p.utm_source).toBe("zdzui");
      expect(p.utm_campaign).toMatch(/^amb_[a-z_]+$/);
      expect(p).not.toHaveProperty("utm_medium");
      expect(new URL(url).origin).toBe(SITE);
    }
    expect(MF_SIGNUP).toBe(`${SITE}/sign-up?utm_source=zdzui&utm_campaign=amb_signup`);
    // 没有独立文档站时 MF_DOCS 就是站点根：拼出来的路径仍然落在本站，不会 404
    expect(new URL(MF_DOCS_LINK).origin).toBe(SITE);
    expect(params(mfLink("/pricing", "amb_pricing"))).toEqual({ utm_source: "zdzui", utm_campaign: "amb_pricing" });
  });

  it("服务端下发的链接：本站页面补上参数，已带参数或别的网站不动", () => {
    expect(params(tagLink(`${SITE}/blog/x`, "amb_notice"))).toEqual({ utm_source: "zdzui", utm_campaign: "amb_notice" });
    expect(params(tagLink(`${SITE}/guides`, "amb_notice")).utm_campaign).toBe("amb_notice");
    expect(tagLink(`${SITE}/x?utm_source=mail&utm_campaign=promo`, "amb_notice")).toBe(`${SITE}/x?utm_source=mail&utm_campaign=promo`);
    expect(tagLink("https://example.com/a", "amb_notice")).toBe("https://example.com/a");
    // 关键：上游项目自己的域名不能再被认成本站，否则会把客户送回去
    expect(tagLink("https://modelflare.dev/blog/x", "amb_notice")).toBe("https://modelflare.dev/blog/x");
    expect(tagLink("https://evilmodelflare.dev/a", "amb_notice")).toBe("https://evilmodelflare.dev/a");
    // 子域名算本站（API 站与前端站同域不同前缀时仍然补参数）
    expect(params(tagLink("https://www.zdzui.xyz/a", "amb_notice")).utm_source).toBe("zdzui");
  });
});
