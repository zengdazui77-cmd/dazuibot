/**
 * 模型的智能与每次任务的花费（模型选择器的「模型智能」滑块用）。数据是仓库里的 Artificial Analysis 快照
 * assets/model-quality.json（scripts/update-model-quality.mjs 生成，已经按 zdzui 的模型 ID 对应好）。
 *
 * 每个模型取哪一档：应用实际用的推理强度。代理走 Responses 接口、模型推理时默认发 medium（agent/host.ts 的
 * providerProfiles），就取 AA 的 medium 那一行；走 Chat / Anthropic 接口不发推理强度，模型用自己的默认，
 * 就取 AA 的默认那一行（链接里没有档位后缀的那一行）。没有 medium 那一行时也用默认那一行。
 */
import fs from "node:fs";
import path from "node:path";
import { findAppRoot } from "../magpie/supervisor.js";
import { agentApi } from "../agent/host.js";

export interface QualityRow {
  /** Artificial Analysis Intelligence Index */
  intelligence: number;
  /** 跑一次 AA 评测任务的花费（美元，按官方定价） */
  costPerTask: number;
}

export interface QualityEntry {
  /** AA 的模型 slug（不带档位） */
  aa: string;
  /** AA 的显示名（不带档位） */
  name?: string;
  /** 默认那一行；variant 是它的档位（max、high…，没有档位时为空） */
  default?: QualityRow & { variant?: string };
  medium?: QualityRow;
}

export interface QualitySnapshot {
  updatedAt: string;
  source: string;
  models: Record<string, QualityEntry>;
}

/** 应用对这个模型发的推理强度：和 providerProfiles 一致，只有 Responses 接口上的推理模型发 medium */
export function appEffort(info: { endpoints?: string[]; reasoning?: boolean } | undefined): "medium" | undefined {
  return info && agentApi(info.endpoints) === "openai-responses" && info.reasoning !== false ? "medium" : undefined;
}

/** 这个模型在应用里的智能与花费：发 medium 且有 medium 那一行时取它，否则取默认那一行 */
export function qualityFor(entry: QualityEntry | undefined, info: { endpoints?: string[]; reasoning?: boolean } | undefined): QualityRow | undefined {
  if (!entry) return undefined;
  const row = (appEffort(info) === "medium" && entry.medium) || entry.default;
  if (!row || !Number.isFinite(row.intelligence) || !Number.isFinite(row.costPerTask) || row.costPerTask < 0) return undefined;
  return { intelligence: row.intelligence, costPerTask: row.costPerTask };
}

let cached: QualitySnapshot | null | undefined;

/** 读仓库里的快照（读一次）；文件不在或坏了时 undefined，选择器退回只有列表 */
export function loadQualitySnapshot(file = path.join(findAppRoot(), "assets", "model-quality.json")): QualitySnapshot | undefined {
  if (cached !== undefined) return cached ?? undefined;
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as QualitySnapshot;
    cached = s && typeof s.models === "object" ? s : null;
  } catch {
    cached = null;
  }
  return cached ?? undefined;
}
