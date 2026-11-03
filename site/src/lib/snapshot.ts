// 原始价格数据 → 快照（构建脚本与单测共用）
import { estimate } from "./calc";
import { fmtMoney } from "./calc";
import { deriveRows, fmtPrice, Pricing, type PricingConfig, type Snapshot } from "./pricing";

/** 快照来源标签（维护者看的，不是 URL，更不是本站接口）：
 *  这批数据是上游 AnyModelBot / Modelflare 在 2026-10-30 的历史抓取，不是本站定价。
 *  本站定价以 zdzui.xyz 站点后台的实时定价为准，页面上不展示任何具体数字，
 *  所以这里不写成 URL 形态——曾经写成 https://zdzui.xyz/api/pricing 是把上游数据洗成了本站数据。 */
export const SOURCE = "upstream-modelflare-2026-10-30";
export const NOTE = "上游历史快照，非本站定价。本站定价以 zdzui.xyz/pricing 为准，页面不展示具体数字。";

/** 2026-10-30T21:24:41+08:00：时间一律按 UTC+8 写 */
export function isoUtc8(d: Date): string {
  const t = new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 19);
  return `${t}+08:00`;
}

export function buildSnapshot(input: unknown, cfg: PricingConfig, now: Date): Snapshot {
  const raw = Pricing.parse(input);
  const rows = deriveRows(raw);
  for (const id of [...cfg.featuredModels, cfg.sampleModel]) {
    if (!rows.some((r) => r.model === id)) throw new Error(`精选模型 ${id} 不在价格数据里`);
  }
  const sm = rows.find((r) => r.model === cfg.sampleModel) ?? rows.find((r) => r.model === cfg.featuredModels[0])!;
  const u = cfg.sampleUsage;
  const est = estimate(sm, { group: sm.defaultGroup, msgs: u.msgs, inTok: u.inTok, outTok: u.outTok }, u.days);
  const text = rows.length;
  const usedVendors = new Set(raw.data.map((m) => m.vendor_id));
  return {
    fetchedAt: isoUtc8(now),
    pricingVersion: raw.pricing_version,
    source: SOURCE,
    // 生成出来的快照永远是"上游历史数据"，不存在"新鲜"这回事，所以固定标 stale
    stale: true,
    note: NOTE,
    counts: { models: raw.data.length, text, media: raw.data.length - text, vendors: raw.vendors.filter((v) => usedVendors.has(v.id)).length },
    vendors: raw.vendors.filter((v) => usedVendors.has(v.id)).map((v) => v.name),
    config: { featuredModels: cfg.featuredModels, sampleModel: sm.model, sampleUsage: cfg.sampleUsage },
    rows,
    sample: {
      model: sm.model,
      input: fmtPrice(sm.input),
      output: fmtPrice(sm.output),
      officialIn: fmtPrice(sm.officialInput),
      officialOut: fmtPrice(sm.officialOutput),
      monthly: fmtMoney(est.monthly),
    },
  };
}
