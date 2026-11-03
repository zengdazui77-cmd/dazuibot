/**
 * 模型选择器的两个滑块：沿帕累托前沿挑模型（ui/lib/frontier.js）、性价比下的价格倍率（model-info.ts）、
 * 应用实际用的那一档（model-quality.ts）、Artificial Analysis 排行榜的解析与对应（scripts/update-model-quality.mjs），
 * 以及界面上的面板（只看 vnode 结构，不渲染）。
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
// @ts-expect-error 界面代码是不经构建的 JS
import { candidates, paretoFrontier, pickStops, levelOf, defaultStop, anchorOf, tiers } from "../ui/lib/frontier.js";
// @ts-expect-error 脚本是不经构建的 JS
import * as upd from "../scripts/update-model-quality.mjs";
import { loadModelInfo, loadModelInfoWithStatus, strategyFactors, type PricingCatalog, type PricingEntry } from "../src/account/model-info.js";
import { appEffort, qualityFor, type QualitySnapshot } from "../src/account/model-quality.js";

const pt = (id: string, intelligence: number, cost: number) => ({ id, intelligence, cost });

describe("帕累托前沿", () => {
  it("只留没被支配的：更贵又不更聪明的、同价更笨的都去掉；完全相同的留 ID 靠前的", () => {
    const front = paretoFrontier([
      pt("a", 20, 0.1),
      pt("b", 30, 0.5),
      pt("c", 25, 0.6), // 比 b 贵还更笨
      pt("d", 30, 0.8), // 和 b 一样聪明但更贵
      pt("e", 50, 2),
      pt("f", 45, 2), // 和 e 同价更笨
      pt("h", 20, 0.1), // 和 a 完全一样
      pt("g", 55, 9),
    ]);
    expect(front.map((p: { id: string }) => p.id)).toEqual(["a", "b", "e", "g"]);
  });

  it("最多 5 档：两头总在，中间按智能均分挑；不到 5 个时全要", () => {
    const front = [pt("a", 10, 0.1), pt("b", 12, 0.2), pt("c", 14, 0.3), pt("d", 30, 0.5), pt("e", 31, 0.6), pt("f", 45, 1), pt("g", 60, 5), pt("h", 61, 6)];
    // 均分点 22.75 / 35.5 / 48.25：离得最近的是 d(30)、e(31)、f(45)
    expect(pickStops(front).map((p: { id: string }) => p.id)).toEqual(["a", "d", "e", "f", "h"]);
    expect(pickStops(front.slice(0, 3)).map((p: { id: string }) => p.id)).toEqual(["a", "b", "c"]);
    expect(pickStops(front, 2).map((p: { id: string }) => p.id)).toEqual(["a", "h"]);
  });

  it("档名：两头总是最低、最高；恢复默认停在居中偏省的那一档", () => {
    expect([0, 1, 2, 3, 4].map((i) => levelOf(i, 5))).toEqual([0, 1, 2, 3, 4]);
    expect([0, 1, 2].map((i) => levelOf(i, 3))).toEqual([0, 2, 4]);
    expect([0, 1, 2, 3].map((i) => levelOf(i, 4))).toEqual([0, 1, 3, 4]);
    expect([0, 1].map((i) => levelOf(i, 2))).toEqual([0, 4]);
    expect([2, 3, 4, 5].map(defaultStop)).toEqual([0, 1, 1, 2]);
  });

  it("候选：列表里有智能和倍率的模型；花费 = 每次任务的花费 × 当前性价比的倍率，带不带 modelflare/ 前缀算一个", () => {
    const info = {
      x: { quality: { intelligence: 40, costPerTask: 2 }, factors: { low_cost: 0.1, balanced: 0.2, stable: 0.5 } },
      y: { quality: { intelligence: 30, costPerTask: 1 } }, // 没有倍率：不在 Modelflare 目录里
      z: { factors: { low_cost: 1, balanced: 1, stable: 1 } }, // 没有 AA 数据
    };
    expect(candidates(["modelflare/x", "x", "y", "z", "w"], info, "low_cost")).toEqual([pt("modelflare/x", 40, 0.2)]);
    expect(candidates(["x"], info, "stable")).toEqual([pt("x", 40, 1)]);
  });

  it("性价比变了前沿跟着变：省钱时便宜分组多的模型更占便宜", () => {
    const info = {
      gpt: { quality: { intelligence: 50, costPerTask: 3 }, factors: { low_cost: 0.03, balanced: 0.13, stable: 0.13 } },
      claude: { quality: { intelligence: 48, costPerTask: 2.5 }, factors: { low_cost: 0.06, balanced: 0.315, stable: 0.5 } },
      small: { quality: { intelligence: 20, costPerTask: 0.1 }, factors: { low_cost: 0.5, balanced: 0.5, stable: 0.5 } },
    };
    const ids = (s: string) => tiers(["gpt", "claude", "small"], info, s, "").stops.map((p: { id: string }) => p.id);
    // 省钱：gpt 0.09，claude 0.15 → claude 被 gpt 支配
    expect(ids("low_cost")).toEqual(["small", "gpt"]);
    // 质量：gpt 0.39，claude 1.25 → 还是 gpt；均衡：gpt 0.39，claude 0.79
    expect(ids("stable")).toEqual(["small", "gpt"]);
    const cheapClaude = { ...info, claude: { ...info.claude, factors: { low_cost: 0.03, balanced: 0.1, stable: 0.5 } } };
    // claude 在省钱时只要 0.075：比 gpt 便宜，于是两个都在前沿上
    expect(tiers(["gpt", "claude", "small"], cheapClaude, "low_cost", "").stops.map((p: { id: string }) => p.id)).toEqual(["small", "claude", "gpt"]);
  });

  it("当前模型在第几档；不在档上时是 -1，并给出它落在哪两档之间", () => {
    const info = Object.fromEntries(
      [["a", 10, 0.1], ["b", 30, 0.5], ["c", 50, 2], ["mid", 40, 3]].map(([id, i, c]) => [id, { quality: { intelligence: i, costPerTask: c }, factors: { low_cost: 1, balanced: 1, stable: 1 } }]),
    );
    expect(tiers(["a", "b", "c", "mid"], info, "balanced", "modelflare/b")).toMatchObject({ cur: 1, anchor: undefined });
    const off = tiers(["a", "b", "c", "mid"], info, "balanced", "mid");
    expect(off.cur).toBe(-1);
    expect(off.anchor).toBeGreaterThan(1);
    expect(off.anchor).toBeLessThan(2);
    // 没有资料的模型：不知道在哪
    expect(tiers(["a", "b", "c"], info, "balanced", "unknown").anchor).toBeUndefined();
    expect(anchorOf([pt("a", 10, 0), pt("b", 20, 1)], pt("x", 5, 0))).toBe(-0.5);
    expect(anchorOf([pt("a", 10, 0), pt("b", 20, 1)], pt("x", 25, 0))).toBe(1.5);
  });
});

describe("性价比下的价格倍率", () => {
  const catalog: PricingCatalog = {
    group_ratio: { "openai-award": 0.03, "openai-stable": 0.08, "openai-premium": 0.13, "openai-enterprise": 0.5, "openai-first-topup": 0.015, "claude-award": 0.25, "claude-stable": 0.315, "claude-premium": 0.5, "claude-tmp-cheap": 0.06 },
    usable_group: { "openai-award": "", "openai-stable": "", "openai-premium": "", "openai-enterprise": "", "claude-award": "", "claude-stable": "", "claude-premium": "", "claude-tmp-cheap": "" },
  };
  const entry = (groups: string[], sale?: number): PricingEntry => ({ model_name: "m", quota_type: 0, enable_groups: groups, sale_price_multiplier: sale });

  it("省钱取最低的公开分组，质量取最高的，均衡取居中（偶数个时取贵的那个）；不公开的、企业专用的不算", () => {
    expect(strategyFactors(entry(["openai-award", "openai-first-topup", "openai-stable", "openai-premium", "openai-enterprise"]), catalog)).toEqual({ low_cost: 0.03, balanced: 0.08, stable: 0.13 });
    expect(strategyFactors(entry(["claude-stable", "claude-tmp-cheap", "claude-award", "claude-premium"]), catalog)).toEqual({ low_cost: 0.06, balanced: 0.315, stable: 0.5 });
  });

  it("乘上模型售价倍率；没有可用分组时没有", () => {
    expect(strategyFactors(entry(["claude-award"], 2), catalog)).toEqual({ low_cost: 0.5, balanced: 0.5, stable: 0.5 });
    expect(strategyFactors(entry(["openai-first-topup"]), catalog)).toBeUndefined();
  });
});

describe("应用实际用的那一档", () => {
  const entry = { aa: "x", default: { variant: "max", intelligence: 57, costPerTask: 6.24 }, medium: { intelligence: 51, costPerTask: 2.73 } };

  it("走 Responses 接口的推理模型发 medium，取 medium 那一行；不推理、走 Chat / Anthropic 的取默认那一行", () => {
    expect(appEffort({ endpoints: ["openai", "openai-response"], reasoning: true })).toBe("medium");
    expect(appEffort({ endpoints: ["openai", "openai-response"] })).toBe("medium");
    expect(appEffort({ endpoints: ["openai", "openai-response"], reasoning: false })).toBeUndefined();
    expect(appEffort({ endpoints: ["anthropic", "openai"] })).toBeUndefined();
    expect(qualityFor(entry, { endpoints: ["openai-response"] })).toEqual({ intelligence: 51, costPerTask: 2.73 });
    expect(qualityFor(entry, { endpoints: ["anthropic", "openai"] })).toEqual({ intelligence: 57, costPerTask: 6.24 });
    // 发 medium 但 AA 没有 medium 那一行：用默认那一行
    expect(qualityFor({ aa: "y", default: { intelligence: 34, costPerTask: 7.51 } }, { endpoints: ["openai-response"] })).toEqual({ intelligence: 34, costPerTask: 7.51 });
  });

  it("/models/info 带上 factors 和 quality（要有 Modelflare 价格目录才有）", async () => {
    const catalog = {
      group_ratio: { "openai-award": 0.03, "openai-stable": 0.08 },
      usable_group: { "openai-award": "", "openai-stable": "" },
      data: [
        { model_name: "gpt-6-astra", quota_type: 0, input_price: 10, completion_ratio: 5, enable_groups: ["openai-award", "openai-stable"], supported_endpoint_types: ["openai", "openai-response"] },
        { model_name: "claude-opus-5-5", quota_type: 0, input_price: 5, completion_ratio: 5, enable_groups: ["openai-stable"], supported_endpoint_types: ["anthropic", "openai"] },
      ],
    };
    const quality: QualitySnapshot = {
      updatedAt: "2026-11-02",
      source: "test",
      models: {
        "gpt-6-astra": entry,
        "claude-opus-5-5": { aa: "claude-opus-5-5", default: { variant: "max", intelligence: 58, costPerTask: 10.04 }, medium: { intelligence: 48, costPerTask: 2.45 } },
        "not-on-modelflare": { aa: "z", default: { intelligence: 1, costPerTask: 1 } },
      },
    };
    const fetchImpl = (async () => new Response(JSON.stringify(catalog))) as typeof fetch;
    const info = await loadModelInfo({ baseUrl: "http://x", apiKey: "", headers: {}, pricingUrl: "http://x/api/pricing", quality, fetchImpl });
    expect(info["gpt-6-astra"]).toMatchObject({ factors: { low_cost: 0.03, balanced: 0.08, stable: 0.08 }, quality: { intelligence: 51, costPerTask: 2.73 } });
    expect(info["claude-opus-5-5"]).toMatchObject({ quality: { intelligence: 58, costPerTask: 10.04 } });
    expect(info["not-on-modelflare"]).toBeUndefined();
  });

  it("可用性：目录是全站的，/v1/models 决定这把 Key 能不能用；列表拿不到时一个 available 都不打", async () => {
    // 真实形状：价格目录 68 条（全站），/v1/models 只有 6 条（按 Key 所属分组），model-profiles 404
    const catalog = {
      group_ratio: { 国模: 0.38, Claude: 0.32 },
      usable_group: { 国模: "国产模型", Claude: "默认分组" },
      data: [
        { model_name: "glm-5.3", quota_type: 0, input_price: 1, completion_ratio: 1, enable_groups: ["国模"] },
        { model_name: "claude-opus-5", quota_type: 0, input_price: 5, completion_ratio: 5, enable_groups: ["Claude"] },
        { model_name: "gpt-6-sol", quota_type: 0, input_price: 75, completion_ratio: 2, enable_groups: ["国模", "Claude"] },
      ],
    };
    const routes: Record<string, unknown> = {
      "/api/pricing": catalog,
      "/v1/models": { data: [{ id: "glm-5.3" }, { id: "gpt-6-sol" }] },
    };
    const fetchImpl = (async (url: string) => {
      const body = routes[new URL(url).pathname];
      // 站上没有 /v1/model-profiles：404
      return body === undefined ? new Response("Invalid URL", { status: 404 }) : new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;
    const st = await loadModelInfoWithStatus({ baseUrl: "http://x/v1", apiKey: "k", headers: {}, pricingUrl: "http://x/api/pricing", fetchImpl });
    // 404 = 能力位「未知」，界面要明说，不能把徽章的缺席当成「不支持」
    expect(st.profiles).toBe(false);
    expect(st.pricing).toBe(true);
    expect(st.models["glm-5.3"]).toMatchObject({ available: true, groups: ["国模"] });
    // 站上有、这把 Key 的分组没有：不许静默隐藏，界面要显示并标注
    expect(st.models["claude-opus-5"]).toMatchObject({ available: false, groups: ["Claude"] });
    // 多分组的模型：groups 原样保留（价格口径是 factors，不是 groups）
    expect(st.models["gpt-6-sol"]).toMatchObject({ available: true, groups: ["国模", "Claude"] });

    // 没有 Key 或模型列表拿不到：available 全 undefined（不知道≠不可用）
    const noList = (async (url: string) => {
      const body = routes[new URL(url).pathname];
      return body === undefined || new URL(url).pathname.endsWith("/models") ? new Response("no", { status: 404 }) : new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;
    const st2 = await loadModelInfoWithStatus({ baseUrl: "http://x/v1", apiKey: "k", headers: {}, pricingUrl: "http://x/api/pricing", fetchImpl: noList });
    expect(st2.models["claude-opus-5"]).toMatchObject({ groups: ["Claude"] });
    expect(st2.models["claude-opus-5"]).not.toHaveProperty("available");
  });
});

describe("Artificial Analysis 排行榜", () => {
  // 和真实页面一样：两行表头（第一行是 colSpan 的分组），模型名带档位，链接 /models/<slug>
  const row = (name: string, intel: string, cost: string, slug: string) =>
    `<tr><td><a href="/models/${slug}">${name}</a></td><td>1M</td><td>X</td><td>${intel}</td><td>${cost}</td><td>95</td><td>1.2</td><td>3.4</td><td><a href="/models/${slug}">Model</a> <a href="/models/${slug}/providers">Providers</a></td></tr>`;
  const page = (rows: string[]) =>
    `<html><body><table><thead><tr><th colSpan="1"></th><th colSpan="2">Features</th><th>Intelligence</th><th>Price</th><th>Speed</th><th>Latency</th><th>End-to-End</th><th></th></tr>` +
    `<tr><th>Model</th><th>Context Window</th><th>Creator</th><th><span>Artificial Analysis</span> Intelligence Index</th><th>Cost per Task <span>USD</span></th><th>Median Tokens/s</th><th>Latency First Chunk (s)</th><th>Total Response (s)</th><th>Further Analysis</th></tr></thead><tbody>` +
    rows.join("") +
    `</tbody></table></body></html>`;
  const sample = [
    row("GPT-6 Astra (max)", "57", "$6.24", "gpt-6-astra"),
    row("GPT-6 Astra (medium)", "51", "$2.73", "gpt-6-astra-medium"),
    row("GPT-6 Astra (high)", "55", "$3.24", "gpt-6-astra-high"),
    row("Claude Opus 5.5 (max with fallback)", "58", "$10.04", "claude-opus-5-5"),
    row("Claude Opus 5.5 (medium with fallback)", "48", "$2.45", "claude-opus-5-5-medium"),
    row("Gemini 3.8 Flash (high)", "31", "$7.77", "gemini-3-8-flash"),
    row("Gemini 3.8 Flash (medium)", "30", "$6.26", "gemini-3-8-flash-medium"),
    row("DeepSeek V4.1 Flash 1017 (max)", "32", "$0.60", "deepseek-v4-1-flash-1017"),
    row("Qwen3.8 Max (0902)", "34", "$10.02", "qwen3-8-max"),
    row("Muse Wonder Full (max)", "50", "--", "muse-wonder-full"),
    row("Granite 4.2 3B", "--", "--", "granite-4-2-3b"),
  ];

  it("按表头文字找列；名字拆出档位（「max with fallback」算 max，「(0902)」不算档位），-- 是没有数据", () => {
    const rows = upd.parseLeaderboard(page(sample));
    expect(rows).toHaveLength(sample.length);
    expect(rows[0]).toEqual({ name: "GPT-6 Astra (max)", slug: "gpt-6-astra", base: "GPT-6 Astra", variant: "max", intelligence: 57, costPerTask: 6.24 });
    expect(rows[3]).toMatchObject({ base: "Claude Opus 5.5", variant: "max" });
    expect(rows[8]).toMatchObject({ base: "Qwen3.8 Max (0902)", variant: "" });
    expect(rows[9]).toMatchObject({ intelligence: 50, costPerTask: null });
    expect(upd.splitVariant("GPT-6 Sol (Daybreak Blue, max)")).toEqual({ base: "GPT-6 Sol", variant: "max" });
    expect(upd.numberOf("$1,234.5")).toBe(1234.5);
    expect(upd.numberOf("n/a")).toBeNaN();
  });

  it("页面结构变了就报清楚哪里不对：少了列、行的形状不对、没有链接", () => {
    expect(() => upd.parseLeaderboard("<html>no table</html>")).toThrow(/no <table>/);
    expect(() => upd.parseLeaderboard(page(sample).replace("Cost per Task", "Price per Task"))).toThrow(/missing column "Cost per Task"/);
    expect(() => upd.parseLeaderboard(page(sample).replace("Intelligence Index", "Index"))).toThrow(/missing column "Artificial Analysis Intelligence Index"/);
    const short = sample.map((r) => r.replace("<td>1M</td>", ""));
    expect(() => upd.parseLeaderboard(page(short))).toThrow(/don't have the 9 header columns/);
    const unlinked = sample.map((r) => r.replace(/href="\/models\/[^"]+"/g, 'href="#"'));
    expect(() => upd.parseLeaderboard(page(unlinked))).toThrow(/no \/models\/<slug> link/);
  });

  it("健康检查：行数太少、数字解析不出来的太多都不行", () => {
    const rows = upd.parseLeaderboard(page(sample));
    expect(() => upd.checkRows(rows)).toThrow(/only 11 rows/);
    const many = Array.from({ length: 60 }, (_, i) => ({ name: `m${i}`, slug: `m${i}`, base: `m${i}`, variant: "", intelligence: i, costPerTask: i / 10 }));
    expect(() => upd.checkRows(many)).not.toThrow();
    const garbled = many.map((r, i) => (i % 3 ? r : { ...r, costPerTask: NaN }));
    expect(() => upd.checkRows(garbled)).toThrow(/"Cost per Task" didn't parse as a number in 20 of 60/);
    const empty = many.map((r) => ({ ...r, intelligence: null }));
    expect(() => upd.checkRows(empty)).toThrow(/only 0 rows have a number in "Intelligence Index"/);
  });

  it("对应 Modelflare 的 ID：点换横线、末尾的档位、名字对不上的查表；只留有数字的", () => {
    const snap = upd.buildSnapshot(upd.parseLeaderboard(page(sample)), ["gpt-6-astra", "claude-opus-5-5", "gemini-3.8-flash", "gemini-3.8-flash-high", "deepseek-v4.1-flash", "qwen3.8-max", "muse-wonder-full", "kimi-k3", "gpt-image-2"], { updatedAt: "2026-11-02", source: "test" });
    expect(Object.keys(snap.models)).toEqual(["claude-opus-5-5", "deepseek-v4.1-flash", "gemini-3.8-flash", "gemini-3.8-flash-high", "gpt-6-astra", "qwen3.8-max"]);
    expect(snap.models["gpt-6-astra"]).toEqual({ aa: "gpt-6-astra", name: "GPT-6 Astra", default: { variant: "max", intelligence: 57, costPerTask: 6.24 }, medium: { intelligence: 51, costPerTask: 2.73 } });
    // ID 里带了档位：固定那一档，没有 medium
    expect(snap.models["gemini-3.8-flash-high"]).toEqual({ aa: "gemini-3-8-flash", name: "Gemini 3.8 Flash", default: { variant: "high", intelligence: 31, costPerTask: 7.77 } });
    expect(snap.models["deepseek-v4.1-flash"].aa).toBe("deepseek-v4-1-flash-1017");
    expect(snap.attribution).toMatch(/Artificial Analysis/);
    expect(upd.normalizeId("modelflare/GPT-6.1_Sol")).toBe("gpt-6-1-sol");
  });

  it("官方 API：没有每次任务的花费时直接报错，不拿别的数凑", () => {
    expect(() => upd.fromApi({ data: [{ name: "A (high)", slug: "a", evaluations: { artificial_analysis_intelligence_index: 50 } }] })).toThrow(/no cost per task/);
    expect(upd.fromApi({ data: [{ name: "A (high)", slug: "a-high", evaluations: { artificial_analysis_intelligence_index: 50 }, cost_per_task: 1.5 }] })).toEqual([
      { name: "A (high)", slug: "a-high", base: "A", variant: "high", intelligence: 50, costPerTask: 1.5 },
    ]);
  });

  it("仓库里的快照：每个模型都有一档带数字，ID 都在 Modelflare 的写法里（小写、点号）", () => {
    const snap = JSON.parse(fs.readFileSync(new URL("../assets/model-quality.json", import.meta.url), "utf8"));
    expect(snap.source).toMatch(/^https:\/\/artificialanalysis\.ai\//);
    expect(Object.keys(snap.models).length).toBeGreaterThanOrEqual(5);
    for (const [id, e] of Object.entries<any>(snap.models)) {
      expect(id).toBe(id.toLowerCase());
      const r = e.default ?? e.medium;
      expect(Number.isFinite(r.intelligence) && Number.isFinite(r.costPerTask)).toBe(true);
    }
  });
});

/** vnode 里所有的字（只看结构，不渲染） */
const textOf = (v: any): string => (v == null || typeof v === "boolean" ? "" : typeof v !== "object" ? String(v) : Array.isArray(v) ? v.map(textOf).join("") : textOf(v.props?.children));
/** vnode 里第一个满足条件的节点 */
const find = (v: any, ok: (n: any) => boolean): any => {
  if (v == null || typeof v !== "object") return undefined;
  if (Array.isArray(v)) {
    for (const c of v) {
      const hit = find(c, ok);
      if (hit) return hit;
    }
    return undefined;
  }
  return ok(v) ? v : find(v.props?.children, ok);
};
const all = (v: any, ok: (n: any) => boolean, out: any[] = []): any[] => {
  if (v == null || typeof v !== "object") return out;
  if (Array.isArray(v)) v.forEach((c) => all(c, ok, out));
  else {
    if (ok(v)) out.push(v);
    all(v.props?.children, ok, out);
  }
  return out;
};

describe("界面：选择器的两个滑块", () => {
  let mp: any;
  let ui: any;
  let lib: any;
  beforeAll(async () => {
    // 界面模块在浏览器里跑：只补上它们加载时要的那一点
    (globalThis as any).window ??= { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {} };
    // @ts-expect-error 界面代码是不经构建的 JS
    mp = await import("../ui/components/model-picker.js");
    // @ts-expect-error 同上
    ui = await import("../ui/components/ui.js");
    // @ts-expect-error 同上
    lib = await import("../ui/lib/i18n.js");
  });
  const stops = [pt("gpt-6-luna", 18, 0.002), pt("gpt-6.1-terra", 38, 0.02), pt("gpt-6.1-sol", 46, 0.04), pt("gpt-6-astra", 51, 0.3), pt("claude-opus-5-5", 58, 3)];
  const panel = (o: Record<string, unknown> = {}) =>
    mp.TierPanel({ strategy: "balanced", showStrategy: true, stops, cur: 3, model: "gpt-6-astra", canReset: true, onStrategy() {}, onStop() {}, onList() {}, onReset() {}, ...o });
  const sliders = (v: any) => all(v, (n) => n.type === ui.Stops);

  it("登录且 Modelflare 支持时：性价比（省钱 / 均衡 / 质量）+ 模型智能（档名、模型名、更省 / 更强）+ 出处", () => {
    lib.setLangPref("zh-CN");
    const v = panel();
    expect(textOf(v)).toBe("性价比均衡省钱均衡质量模型智能高gpt-6-astra更省更强沿帕累托前沿选择模型，数据来自 Artificial Analysis");
    const [s1, s2] = sliders(v);
    expect(s1.props).toMatchObject({ count: 3, value: 1, valueText: "均衡" });
    expect(s2.props).toMatchObject({ count: 5, value: 3, valueText: "高：gpt-6-astra", autoFocus: true });
    expect(find(v, (n) => n.type === "a").props).toMatchObject({ href: "https://artificialanalysis.ai/", target: "_blank" });
    lib.setLangPref("en");
    expect(textOf(panel())).toBe("ValueBalancedCheapBalancedQualityIntelligenceHighgpt-6-astraCheaperSmarterPareto-optimal models, data from Artificial Analysis");
    lib.setLangPref("zh-CN");
  });

  it("没登录或不支持时没有性价比；当前模型不在档上是「自定义」，模型名照样显示", () => {
    const v = panel({ showStrategy: false, cur: -1, model: "kimi-k3", anchor: 2.5 });
    expect(textOf(v)).toBe("模型智能自定义kimi-k3更省更强沿帕累托前沿选择模型，数据来自 Artificial Analysis");
    const [s2, more] = sliders(v);
    expect(more).toBeUndefined();
    expect(s2.props).toMatchObject({ value: -1, anchor: 2.5, valueText: "自定义", fallback: 2 });
    expect(find(v, (n) => n.props?.class === "tier-val custom")).toBeTruthy();
  });

  it("彩蛋：看得见的滑块都拉到最右才有（质量 + 最强）；差一档都没有", () => {
    const maxed = (v: any) => v.props.class === "tiers maxed";
    const sparks = (v: any) => all(v, (n) => typeof n.type === "function" && n.type.name === "Sparks");
    expect(maxed(panel({ strategy: "stable", cur: 4, model: "claude-opus-5-5" }))).toBe(true);
    expect(sparks(panel({ strategy: "stable", cur: 4, model: "claude-opus-5-5" }))).toHaveLength(1);
    expect(maxed(panel({ strategy: "balanced", cur: 4, model: "claude-opus-5-5" }))).toBe(false);
    expect(maxed(panel({ strategy: "stable", cur: 3 }))).toBe(false);
    expect(maxed(panel({ strategy: "stable", cur: -1, model: "kimi-k3" }))).toBe(false);
    expect(sparks(panel({ strategy: "stable", cur: 3 }))).toHaveLength(0);
    // 没有性价比滑块时，只看模型智能
    expect(maxed(panel({ showStrategy: false, cur: 4, model: "claude-opus-5-5" }))).toBe(true);
    expect(maxed(panel({ showStrategy: false, stops: stops.slice(0, 1), cur: 0 }))).toBe(false);
  });

  it("滑块和模型名：拖到第几档就选那个模型；点模型名去完整列表；恢复默认只在不是默认时出现", () => {
    const got: string[] = [];
    const v = panel({ onStop: (m: string) => got.push(`stop:${m}`), onStrategy: (s: string) => got.push(`strategy:${s}`), onList: () => got.push("list") });
    const [s1, s2] = sliders(v);
    s1.props.onChange(0);
    s2.props.onChange(4);
    find(v, (n) => n.props?.class === "tier-model").props.onClick();
    expect(got).toEqual(["strategy:low_cost", "stop:claude-opus-5-5", "list"]);
    expect(find(v, (n) => String(n.props?.class).includes("tiers-reset"))).toBeTruthy();
    expect(find(panel({ canReset: false }), (n) => String(n.props?.class).includes("tiers-reset"))).toBeUndefined();
  });

  it("前沿不到两档：没有第二个滑块，只剩模型名", () => {
    const v = panel({ showStrategy: false, stops: stops.slice(0, 1), cur: 0 });
    expect(sliders(v)).toEqual([]);
    expect(textOf(v)).toBe("模型智能gpt-6-astra沿帕累托前沿选择模型，数据来自 Artificial Analysis");
  });

  it("第一个滑块只在登录了、Modelflare 认这个设置时显示；否则按均衡估花费", () => {
    const acct = (state: string, supported: boolean, strategy = "low_cost") => ({ state, keyQuality: { strategy, supported } });
    expect(mp.showsStrategy(acct("signed_in", true))).toBe(true);
    expect(mp.showsStrategy(acct("signed_in", false))).toBe(false);
    expect(mp.showsStrategy(acct("signed_out", true))).toBe(false);
    expect(mp.showsStrategy(null)).toBe(false);
    expect(mp.strategyOf(acct("signed_in", true))).toBe("low_cost");
    expect(mp.strategyOf(acct("signed_in", false))).toBe("balanced");
    expect(mp.strategyOptions()).toEqual([["low_cost", "省钱"], ["balanced", "均衡"], ["stable", "质量"]]);
  });

  it("方向键：一档一档走，两头停住；不在档上时从它的位置往上或往下，不知道位置时去默认那一档", () => {
    expect(ui.stepKey("ArrowRight", 1, 5)).toBe(2);
    expect(ui.stepKey("ArrowUp", 4, 5)).toBe(4);
    expect(ui.stepKey("ArrowLeft", 0, 5)).toBe(0);
    expect(ui.stepKey("ArrowDown", 3, 5)).toBe(2);
    expect(ui.stepKey("Home", 3, 5)).toBe(0);
    expect(ui.stepKey("End", 1, 5)).toBe(4);
    expect(ui.stepKey("Enter", 1, 5)).toBeUndefined();
    expect(ui.stepKey("ArrowRight", -1, 5, 1.4)).toBe(2);
    expect(ui.stepKey("ArrowLeft", -1, 5, 1.4)).toBe(1);
    expect(ui.stepKey("ArrowLeft", -1, 5, -0.5)).toBe(0);
    expect(ui.stepKey("ArrowRight", -1, 5, 4.5)).toBe(4);
    expect(ui.stepKey("ArrowRight", -1, 5, undefined, 2)).toBe(2);
  });
});
