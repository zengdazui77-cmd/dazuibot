/**
 * 模型的模态类型（文本 / 图片 / 视频 / 语音 / 其他）。
 *
 * **唯一真源是价格目录的 `supported_endpoint_types`，不靠模型名字猜。**
 * 名字猜会两头错：`gpt-image-2.5-sunburst` 其实是 `image-generation|openai` 双模态，
 * 而 `nd-seedance-2.0-720p` 只从名字看不出它到底是不是视频。
 *
 * 两处共用这一份判定：模型选择器的类型 tab（`ui/` 拿后端算好的 `ModelInfo.modality`）
 * 与图片/视频的媒体工具（`src/agent/media.ts`）。分成两份的那天，两处就会开始不一致。
 *
 * 三条约定：
 *   1. 一个模型可以属于多个模态。`gpt-image-2` 系列既 `image-generation` 又 `openai`，
 *      所以它同时是「图片」和「文本」，**不许二选一**。
 *   2. 认不出的端点类型**不丢**：归进「其他」并留一条 debug 日志。站主哪天加 `openai-audio`，
 *      这里响一下就知道该补映射了，而不是那批模型静默消失。
 *   3. 没有任何端点信息的模型也进「其他」——「不知道」不能等于「文本」。
 */
import { logger } from "./log.js";

const log = logger("modality");

export type Modality = "text" | "image" | "video" | "voice" | "other";

/** 展示顺序：文本在最前（绝大多数人要的就是它），其他垫底 */
export const MODALITY_ORDER: readonly Modality[] = ["text", "image", "video", "voice", "other"];

/**
 * 端点类型 → 模态。语音那几个现在站上 0 个模型，映射先留着：
 * 站主加上了语音模型，不改代码就会自己长出一个 tab。
 */
const ENDPOINT_MODALITY: Record<string, Modality> = {
  openai: "text",
  anthropic: "text",
  "openai-response": "text",
  "openai-response-compact": "text",
  gemini: "text",
  "openai-alpha-search": "text",
  "image-generation": "image",
  "openai-video": "video",
  audio: "voice",
  "openai-audio": "voice",
  tts: "voice",
  speech: "voice",
  transcription: "voice",
  whisper: "voice",
  realtime: "voice",
};

/** 一个模型的模态（可能多个）；认不出的端点进「其他」 */
export function modalityOf(endpoints: readonly string[] | undefined): Modality[] {
  const out = new Set<Modality>();
  for (const e of endpoints ?? []) {
    const m = ENDPOINT_MODALITY[e];
    if (m) {
      out.add(m);
      continue;
    }
    out.add("other");
    // 只记名字不记整条：这条会随每次刷新模型列表出现，写多了是噪音
    log.debug("unknown endpoint type", { endpoint: e });
  }
  if (!out.size) out.add("other");
  return MODALITY_ORDER.filter((m) => out.has(m));
}
