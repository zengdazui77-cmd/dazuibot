/**
 * 生图 / 生视频：代理的 media_models / media_docs / generate_image / generate_video 工具经内部 bridge 调到这里，
 * 由宿主带着该机器人用的 Key 直连 zdzui（代理子进程拿不到任何密钥），结果存进机器人工作区的 media/，
 * 再由代理用 present 交付到聊天。生成前要不要先问用户由 AgentManager 决定（manager.ts mediaAsk）：只在预计花费超过上限
 * 或机器人设成每次都问时问。
 * - 模型取自公开价格目录 /api/pricing 里 supported_endpoint_types 含 image-generation / openai-video 的条目，
 *   「这把 Key 能不能用」由带 Key 的 GET /v1/models 决定（两者分开：站上有、当前 Key 没有的也要列出来并标注）；
 *   参数范围、是否必须带参考素材、参考价、推荐顺序也来自同一个目录。
 *   **不用** GET /v1/models?scope=authorized&kind=image|video：这两个参数是上游私有约定，站上的 new-api 不认。
 * - 每个模型的请求格式都不一样，以媒体文档（媒体文档 = `{站点根}/llms-full.txt`，见下面的 DOCS_URL）里该模型的章节为准：
 *   代理先用 media_docs 读文档，按文档写请求体（body）；宿主只填 model、把 "workspace:路径" 换成文件内容、发请求、保存结果。
 *   不带 body 时发最简单的文字请求。**本站目前不提供 llms-full.txt**，取不到时 media_docs 只回一句可操作提示，不影响生成。
 * - 图片：Gemini 图片模型走 /v1/models/{id}:generateContent，其余走 /v1/images/generations（改图走 /v1/images/edits）。
 * - 视频：POST /v1/videos 建任务 → 轮询 → GET /v1/videos/{id}/content 下载。
 */
import fs from "node:fs";
import path from "node:path";
import { logger } from "../log.js";
import { t } from "../i18n/index.js";
import { modalityOf, type Modality } from "../modality.js";
import { MODELFLARE_WEB } from "../modelflare.js";

const log = logger("agent.media");

export type MediaKind = "image" | "video";

export interface MediaOptions {
  /** zdzui /v1 基址（随线路） */
  baseUrl: () => string;
  /** 该机器人用的 Key：它自己的预算 Key，没有就用共用 Key；未连接时为空 */
  keyFor: (botId: string) => string;
  /** 额外请求头（调用归因） */
  headers: () => Record<string, string>;
  workspace: (botId: string) => string;
  /** 设置里选的默认图片 / 视频模型；空 = 按推荐顺序的第一个 */
  defaults?: () => { image: string; video: string };
  /** 公开价格目录（参数范围、参考价、推荐顺序）；取不到时只是少了这些信息 */
  pricingUrl?: () => string;
  /** 文档全文（每个模型一节） */
  docsUrl?: string;
  fetchImpl?: typeof fetch;
  /** 视频轮询间隔与上限（测试用） */
  pollMs?: number;
  videoTimeoutMs?: number;
}

export interface MediaModel {
  id: string;
  kind: MediaKind;
  /** images = OpenAI Images API；gemini = generateContent；videos = /v1/videos */
  route: "images" | "gemini" | "videos";
  /** 价格目录里的 media_options.image / media_options.video */
  options?: Record<string, unknown>;
  /** 必须带参考素材（图生视频之类），只有文字时不能用 */
  requiresReference: boolean;
  /** 一句参考价，如 "$0.03/张"、"$0.09/秒（720p）" */
  price: string;
  /** 单价（美元，已按分组倍率折算），估算花费用；按 token 计费或目录里没有价格时为空 */
  cost?: UnitPrice;
  priority: number;
  /**
   * 这把 Key 的分组能不能用。false = 站上有、当前 Key 没有（选中会失败，要明说）；
   * undefined = 不知道（模型列表没拿到）——不能当 false 渲染。
   */
  available?: boolean;
}

/** 单价：每张 / 每次 / 每秒（视频按分辨率，default 是目录里的默认分辨率） */
export interface UnitPrice {
  per: "image" | "call" | "second";
  usd: number;
  /** 每秒价格，按分辨率 */
  byResolution?: Record<string, number>;
  resolution?: string;
}

/** 一次生成要确认的内容 */
export interface MediaPlan {
  kind: MediaKind;
  /** 这次要用的模型（代理指定的，或默认） */
  model: MediaModel;
  /** 默认模型（设置里选的，或推荐的） */
  default: MediaModel;
  /** 确认时一并列出的其他选择 */
  candidates: MediaModel[];
  /** 站上全部同类模型（含当前 Key 不可用的，见 MediaModel.available） */
  all: MediaModel[];
  /** 代理按文档写了自己的请求体：换模型后需要按新模型的文档重写 */
  custom: boolean;
  /** 给用户看的说明：提示词摘要、参数、参考素材（按当前语言） */
  summary: string;
  /** 预计花费（美元）；算不出来（按 token 计费、目录里没有价格、视频不知道多长）时为空 */
  estimate?: number;
}

interface CatalogEntry {
  model_name: string;
  display_priority?: number;
  quota_type?: number;
  model_price?: number;
  billing_unit?: string;
  enable_groups?: string[];
  video_resolution_price?: Record<string, number>;
  media_options?: { image?: Record<string, unknown>; video?: Record<string, unknown> };
  /** 决定一个模型是图片还是视频的**唯一**可信来源（站上的 /api/pricing） */
  supported_endpoint_types?: string[];
}

interface Catalog {
  data?: CatalogEntry[];
  group_ratio?: Record<string, number>;
  usable_group?: Record<string, unknown>;
}

const MAX_BYTES = 200 * 1024 * 1024;
/** 参考素材按 data URL / Base64 嵌进请求，单个文件上限 */
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const CACHE_MS = 3600_000;
/**
 * 模型文档基址（media_docs 工具读它下面的 llms-full.txt）。
 * 指向站点根：自有站点没有独立文档站。**本站目前没有 llms-full.txt**，取不到时走下面的 UNAVAILABLE，
 * 不影响图片/视频生成（生成只依赖 /v1 的模型列表与调用接口）。
 * 站主后续在该路径下发布一份 llms-full.txt 即可自动生效，不用改代码——所以这里不改措辞、也不做兜底文档。
 */
const DOCS_URL = MODELFLARE_WEB;
/**
 * media_docs 取不到文档时的**唯一**回复（404、连不上、章节缺失都走这句）。
 * 这句话是给代理看的操作指令，不是给人看的错误：说清「别重试、别猜字段、只给必填参数」，
 * 否则代理会连着试几次 media_docs、再瞎猜 ratio / duration 之类的参数，客户只看到它在兜圈子。
 */
const UNAVAILABLE =
  "本站目前不提供模型文档（llms-full.txt）。不要重试 media_docs，也不要猜 ratio、duration 这类参数：" +
  "直接调用 generate_* 工具并**只**给 prompt（需要时加 model），其余字段留空，程序会用该模型的默认值。";
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/webm": "webm" };
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};
/** 请求体里的 "workspace:media/a.png"（data URL）或 "workspace-base64:media/a.png"（纯 Base64） */
const FILE_REF = /^workspace(-base64)?:(.+)$/;

export class MediaError extends Error {}

const num = (n: number) => String(+n.toFixed(n < 0.1 ? 4 : 3));

/** 推荐顺序：价格目录的 display_priority 小的在前，必须带参考素材的放后面，其余按名字 */
export function sortModels(list: MediaModel[]): MediaModel[] {
  return [...list].sort((a, b) => a.priority - b.priority || Number(a.requiresReference) - Number(b.requiresReference) || a.id.localeCompare(b.id, "en", { sensitivity: "base" }));
}

/** 设置里的默认模型还能用就用它，否则推荐顺序里第一个不需要参考素材的。当前 Key 不可用的排到最后 */
export function pickDefault(list: MediaModel[], configured: string): MediaModel | undefined {
  const usable = list.filter((m) => m.available !== false);
  const pool = usable.length ? usable : list;
  return pool.find((m) => m.id === configured) ?? pool.find((m) => !m.requiresReference) ?? pool[0];
}

/** 单价（按分组倍率折算）；按 token 计费或没有价格时为空 */
export function unitPrice(e: CatalogEntry | undefined, catalog: Catalog): UnitPrice | undefined {
  if (!e) return undefined;
  const ratios = (e.enable_groups ?? [])
    .filter((g) => !catalog.usable_group || g in catalog.usable_group)
    .map((g) => catalog.group_ratio?.[g])
    .filter((r): r is number => typeof r === "number" && Number.isFinite(r) && r >= 0);
  const factor = ratios.length ? Math.min(...ratios) : 1;
  const perSecond = Object.entries(e.video_resolution_price ?? {}).filter(([, p]) => typeof p === "number" && p > 0);
  if (perSecond.length) {
    const want = String(e.media_options?.video?.default_resolution ?? "");
    const [res, p] = perSecond.find(([r]) => r === want) ?? [...perSecond].sort((a, b) => a[1] - b[1])[0];
    return { per: "second", usd: p * factor, resolution: res, byResolution: Object.fromEntries(perSecond.map(([r, x]) => [r, x * factor])) };
  }
  if (e.quota_type === 1 && typeof e.model_price === "number" && e.model_price > 0) return { per: e.billing_unit === "per_call" ? "call" : "image", usd: e.model_price * factor };
  return undefined;
}

/** 一句参考价（按当前语言）；复杂计费（按 token）只说明计费方式 */
export function priceNote(e: CatalogEntry | undefined, catalog: Catalog): string {
  const p = unitPrice(e, catalog);
  if (p) return t(p.per === "second" ? "media.pricePerSecond" : p.per === "call" ? "media.pricePerCall" : "media.pricePerImage", { price: `$${num(p.usd)}`, res: p.resolution ?? "" });
  if (e?.billing_unit === "token") return t("media.priceToken");
  return "";
}

/** 请求里要的时长、分辨率、张数（body 里的常见写法，或不带 body 时的 seconds 参数） */
export function requested(body: Record<string, unknown> | undefined, args: Record<string, unknown>): { seconds?: number; resolution?: string; count?: number } {
  const out: { seconds?: number; resolution?: string; count?: number } = {};
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 6) return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const n = Number(x);
      if ((k === "seconds" || k === "duration") && n > 0) out.seconds ??= n;
      else if (k === "resolution" && typeof x === "string") out.resolution ??= x;
      else if (["n", "count", "numberOfImages", "number_of_images", "num_images", "sampleCount", "candidateCount"].includes(k) && n > 0) out.count ??= n;
      else walk(x, depth + 1);
    }
  };
  walk(body, 0);
  if (out.seconds === undefined && Number(args.seconds) > 0) out.seconds = Number(args.seconds);
  return out;
}

/**
 * 这次生成的预计花费（美元）：图片按张数（默认 1 张），视频按秒数和分辨率；没写时长时按模型支持的最长时长算（宁可多问）。
 * 算不出来时为空。
 */
export function estimateUsd(model: MediaModel, body: Record<string, unknown> | undefined, args: Record<string, unknown>): number | undefined {
  const p = model.cost;
  if (!p) return undefined;
  const r = requested(body, args);
  if (p.per !== "second") return p.usd * (r.count ?? 1);
  const listed = Array.isArray(model.options?.seconds) ? (model.options!.seconds as unknown[]).map(Number).filter((n) => n > 0) : [];
  const seconds = r.seconds ?? (listed.length ? Math.max(...listed) : undefined);
  if (!seconds) return undefined;
  const perSecond = (r.resolution && p.byResolution?.[r.resolution]) || p.usd;
  return perSecond * seconds;
}

/** 一行参数范围：尺寸、比例、分辨率、时长、参考素材 */
export function optionsNote(m: MediaModel): string {
  const o = m.options ?? {};
  const list = (k: string) => (Array.isArray(o[k]) ? (o[k] as unknown[]).map(String) : []);
  const parts: string[] = [];
  if (list("sizes").length) parts.push(`尺寸 ${list("sizes").join("/")}`);
  if (list("resolutions").length) parts.push(`分辨率 ${list("resolutions").join("/")}`);
  if (list("ratios").length) parts.push(`比例 ${list("ratios").join("/")}`);
  const secs = list("seconds").map(Number).filter((n) => n > 0);
  if (secs.length) parts.push(`时长 ${Math.min(...secs)}–${Math.max(...secs)} 秒`);
  const refs = list("reference_media");
  if (refs.length) parts.push(`参考素材 ${refs.join("/")}`);
  else if (o.reference_images === true || Number(o.max_references) > 0) parts.push(`参考图${Number(o.max_references) > 0 ? ` 最多 ${o.max_references} 张` : ""}`);
  if (m.requiresReference) parts.push("必须带参考素材");
  return parts.join(" · ");
}

/** 从请求体里挑出给用户看的参数（分辨率、比例、时长……），并数一数参考素材 */
export function describeBody(body: Record<string, unknown> | undefined): string {
  if (!body) return "";
  // true = 时长（数字时带单位"秒"）
  const keys: Record<string, boolean> = { resolution: false, aspect_ratio: false, ratio: false, size: false, imageSize: false, aspectRatio: false, seconds: true, duration: true, quality: false };
  const seen = new Map<string, string>();
  let refs = 0;
  const walk = (v: unknown, depth: number) => {
    if (typeof v === "string") {
      if (FILE_REF.test(v) || /^https?:\/\//i.test(v) || v.startsWith("data:")) refs++;
      return;
    }
    if (!v || typeof v !== "object" || depth > 6) return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k in keys && (typeof x === "string" || typeof x === "number")) {
        // 时长两种写法只显示一个
        const label = k === "duration" ? "seconds" : k === "aspectRatio" || k === "aspect_ratio" ? "ratio" : k === "imageSize" ? "size" : k;
        if (!seen.has(label)) seen.set(label, keys[k] && Number(x) > 0 ? t("media.seconds", { n: x }) : String(x));
      } else walk(x, depth + 1);
    }
  };
  walk(body, 0);
  const parts = [...seen.values()];
  if (refs) parts.push(t("media.references", { count: refs }));
  return parts.join(" · ");
}

/** 从文档全文里取出某个模型的那一节（每节以 "# 标题" 开头、下一行是 "Source: <页面地址>"） */
export function docSection(full: string, docsUrl: string, kind: MediaKind, model: string): string {
  const slug = model.toLowerCase().replace(/\./g, "-");
  const marker = `\nSource: ${docsUrl}/models/${kind}/${slug}/\n`;
  const at = full.indexOf(marker);
  if (at < 0) return "";
  const start = full.lastIndexOf("\n# ", at);
  const next = full.indexOf("\n---\n\n# ", at + marker.length);
  return full.slice(start < 0 ? at : start + 1, next < 0 ? undefined : next).trim();
}

export class MediaService {
  private catalogCache: { at: number; data: Catalog } | undefined;
  private docsCache: { at: number; text: string } | undefined;

  constructor(private o: MediaOptions) {}

  private get fetch(): typeof fetch {
    return this.o.fetchImpl ?? fetch;
  }
  private get docsUrl(): string {
    return (this.o.docsUrl ?? DOCS_URL).replace(/\/+$/, "");
  }

  /** 直接生成（不经确认，测试与内部用）：解析模型后执行 */
  async run(botId: string, op: string, args: Record<string, unknown>): Promise<string> {
    const plan = await this.prepare(botId, op, args);
    return this.execute(botId, plan.model, args);
  }

  private key(botId: string): string {
    const key = this.o.keyFor(botId);
    if (!key) throw new MediaError("还没有连接 zdzui，无法生成图片或视频");
    return key;
  }

  private async call(key: string, method: string, p: string, body?: unknown, timeoutMs = 300_000): Promise<Response> {
    const res = await this.fetch(`${this.o.baseUrl()}${p}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...this.o.headers(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } };
      const msg = detail.error?.message || `HTTP ${res.status}`;
      throw new MediaError(detail.error?.code === "model_not_found" ? `这把 Key 不能用这个模型：${msg}` : `zdzui 返回错误：${msg}`);
    }
    return res;
  }

  private async catalog(): Promise<Catalog> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < CACHE_MS) return this.catalogCache.data;
    let data: Catalog = {};
    const url = this.o.pricingUrl?.();
    if (url) {
      try {
        const res = await this.fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
        if (res.ok) data = (await res.json()) as Catalog;
      } catch (e) {
        log.warn("pricing catalog unavailable", { message: (e as Error).message.slice(0, 200) });
      }
    }
    this.catalogCache = { at: Date.now(), data };
    return data;
  }

  /**
   * 站上的图片 / 视频模型，按推荐顺序。
   *
   * **不再用 `GET /v1/models?scope=authorized&kind=image|video`**：这两个查询参数是上游私有约定，
   * 站上的 new-api 不认，只会原样返回这把 Key 的全部模型（实测 6 个全都是文本模型）——
   * 于是图片/视频列表恒为空，工具却说"这把 Key 没有可用的图片模型"，客户看不出是站点不支持。
   *
   * 现在改成：型号类型看公开价格目录的 `supported_endpoint_types`，判定用 `modalityOf()`——
   * 和模型选择器的类型 tab 是**同一个函数**，两处分开写的那天就会开始不一致。
   * 「这把 Key 能不能用」看带 Key 的 `GET /v1/models`。两者分开：站上有 26 个媒体模型，当前 Key
   * 一个都够不到，这个事实必须让客户看见，而不是把列表清空。
   */
  async available(key: string, kind: MediaKind): Promise<MediaModel[]> {
    const [catalog, usable] = await Promise.all([this.catalog(), this.keyModels(key)]);
    const want: Modality = kind === "video" ? "video" : "image";
    const out: MediaModel[] = [];
    for (const e of catalog.data ?? []) {
      if (!modalityOf(e.supported_endpoint_types).includes(want)) continue;
      const options = e.media_options?.[kind];
      // 图片默认走 OpenAI Images（站上 4 个图片模型都是 image-generation/openai）；
      // 只有名字就是 gemini 的才走 generateContent——目录里没有字段能说明这一点，按名字判是最保守的。
      const route: MediaModel["route"] = kind === "video" ? "videos" : /^gemini/i.test(e.model_name) ? "gemini" : "images";
      out.push({
        id: e.model_name,
        kind,
        route,
        options,
        requiresReference: options?.requires_reference === true,
        price: priceNote(e, catalog),
        cost: unitPrice(e, catalog),
        priority: typeof e.display_priority === "number" ? e.display_priority : 1e9,
        ...(usable ? { available: usable.has(e.model_name) } : {}),
      });
    }
    return sortModels(out);
  }

  /** 这把 Key 能调哪些模型；拿不到时 undefined（= 不知道，不是「全都不行」） */
  private async keyModels(key: string): Promise<Set<string> | undefined> {
    try {
      const res = await this.fetch(`${this.o.baseUrl()}/models`, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...this.o.headers() },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
      return new Set((body.data ?? []).map((m) => String(m?.id ?? "")).filter(Boolean));
    } catch {
      return undefined;
    }
  }

  async models(botId: string, kind: MediaKind): Promise<MediaModel[]> {
    return this.available(this.key(botId), kind);
  }

  defaultId(kind: MediaKind): string {
    return this.o.defaults?.()[kind] ?? "";
  }

  /** media_models 工具：列出可用模型、默认模型、参数范围与参考价 */
  async listText(botId: string, kind: unknown): Promise<string> {
    const kinds: MediaKind[] = kind === "image" || kind === "video" ? [kind] : ["image", "video"];
    const blocks: string[] = [];
    for (const k of kinds) {
      const list = await this.models(botId, k);
      const name = k === "image" ? "图片" : "视频";
      if (!list.length) {
        // 目录里就没有这类模型（而不是"这把 Key 没有"）——两者要分开说，否则客户会去换 Key 而不是找站主
        blocks.push(`站点的公开价格目录里没有${name}模型。`);
        continue;
      }
      const def = pickDefault(list, this.defaultId(k));
      // 站上有、这把 Key 没有的也列出来（在后面，带一句标注）：客户才知道自己缺什么、该找站主开什么
      const usable = list.filter((m) => m.available !== false);
      const blocked = list.filter((m) => m.available === false);
      const line = (m: MediaModel) =>
        `- ${m.id}${m === def ? "（默认）" : ""}${[m.price, optionsNote(m)].filter(Boolean).map((s) => ` — ${s}`).join("")}`;
      if (!usable.length) {
        blocks.push(
          `站上有 ${blocked.length} 个${name}模型，但这把 Key 所在的分组一个都没有：${blocked.map((m) => m.id).join("、")}。\n` +
            `需要生成${name}的话，请到站点给这把 Key 换到对应的分组（或找站主开权限）；换完可以用 media_models 重新查。`,
        );
        continue;
      }
      blocks.push(`可用的${name}模型（按推荐顺序）：\n${usable.map(line).join("\n")}`);
      if (blocked.length) blocks.push(`站上还有但这些分组不含（当前 Key 调不了，未计入上面）：\n${blocked.map(line).join("\n")}`);
    }
    blocks.push("调用后直接生成；只在预计花费较高或机器人设成每次都问时，程序会先问用户。要用参考图、比例、分辨率、时长等参数时，先用 media_docs 读该模型的文档，按文档写 body。");
    return blocks.join("\n\n");
  }

  /** media_docs 工具：从 {站点根}/llms-full.txt 取该模型的章节（Markdown）。本站目前没有这个文件，失败是预期路径。 */
  async docs(model: unknown): Promise<string> {
    const id = String(model ?? "").trim();
    if (!id) throw new MediaError("缺少 model");
    if (!this.docsCache || Date.now() - this.docsCache.at > CACHE_MS) {
      const res = await this.fetch(`${this.docsUrl}/llms-full.txt`, { signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
      if (!res || !res.ok) throw new MediaError(UNAVAILABLE);
      this.docsCache = { at: Date.now(), text: await res.text() };
    }
    const text = docSection(this.docsCache.text, this.docsUrl, "image", id) || docSection(this.docsCache.text, this.docsUrl, "video", id);
    if (!text) throw new MediaError(UNAVAILABLE);
    const cap = 24_000;
    return `${text.length > cap ? `${text.slice(0, cap)}\n…（已截断）` : text}\n\n---\n按上面的请求格式写 generate_* 工具的 body（不用写 model，也不要自己用 curl 调接口：你没有 Key，程序会代发）。本地文件写成 "workspace:相对路径"（换成 data URL）或 "workspace-base64:相对路径"（换成纯 Base64，例如 Gemini 的 inline_data.data）。`;
  }

  /** 解析这次要用的模型与确认时列出的其他选择 */
  async prepare(botId: string, op: string, args: Record<string, unknown>): Promise<MediaPlan> {
    if (op !== "image" && op !== "video") throw new MediaError(`未知操作 ${op}`);
    const kind: MediaKind = op;
    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) throw new MediaError("缺少 prompt");
    const body = parseBody(args.body);
    const all = await this.models(botId, kind);
    const word = kind === "image" ? "图片" : "视频";
    if (!all.length) throw new MediaError(`站点的公开价格目录里没有${word}模型`);
    // 站上有、这把 Key 的分组没有的，一律不当成「可选」——选中了只会 503，不如现在说清楚
    const usable = all.filter((m) => m.available !== false);
    if (!usable.length) throw new MediaError(`站上有 ${all.length} 个${word}模型（${all.map((m) => m.id).join("、")}），但这把 Key 所在的分组一个都没有。请到站点给这把 Key 换分组，或找站主开权限。`);
    const name = String(args.model ?? "").trim();
    const def = pickDefault(all, this.defaultId(kind))!;
    const model = name ? all.find((m) => m.id === name) : def;
    if (!model) throw new MediaError(`没有这个模型：${name}。可用：${usable.map((m) => m.id).join("、")}`);
    if (model.available === false) throw new MediaError(`这个模型不在这把 Key 的分组里：${model.id}。可用：${usable.map((m) => m.id).join("、")}`);
    const hasRefs = /"workspace(-base64)?:|"https?:\/\/|"data:/.test(JSON.stringify(body ?? {}));
    const candidates = [def, ...usable].filter((m, i, a) => m !== model && a.indexOf(m) === i && (hasRefs || !m.requiresReference)).slice(0, 3);
    const params = describeBody(body) || [typeof args.size === "string" ? args.size : "", Number(args.seconds) > 0 ? t("media.seconds", { n: String(args.seconds) }) : ""].filter(Boolean).join(" · ");
    const summary = [
      t("media.summaryPrompt", { prompt: prompt.length > 120 ? `${prompt.slice(0, 120)}…` : prompt }),
      params && t("media.summaryParams", { params }),
      model.price && t("media.summaryPrice", { price: model.price }),
    ]
      .filter(Boolean)
      .join("\n");
    return { kind, model, default: def, candidates, all, custom: !!body, summary, estimate: estimateUsd(model, body, args) };
  }

  /** 用确定下来的模型生成，返回给模型的一段文字 */
  async execute(botId: string, model: MediaModel, args: Record<string, unknown>): Promise<string> {
    const prompt = String(args.prompt ?? "").trim();
    const body = parseBody(args.body);
    const resolved = body ? (this.inline(botId, body) as Record<string, unknown>) : undefined;
    return model.kind === "image" ? this.image(botId, model, prompt, resolved, args) : this.video(botId, model, prompt, resolved, args);
  }

  /** 把请求体里的 "workspace:路径" 换成 data URL、"workspace-base64:路径" 换成纯 Base64；只认工作区里的文件 */
  private inline(botId: string, v: unknown): unknown {
    if (typeof v === "string") {
      const m = FILE_REF.exec(v);
      if (!m) return v;
      const file = this.workspaceFile(botId, m[2].trim());
      const data = fs.readFileSync(file);
      const mime = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
      return m[1] ? data.toString("base64") : `data:${mime};base64,${data.toString("base64")}`;
    }
    if (Array.isArray(v)) return v.map((x) => this.inline(botId, x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.inline(botId, x)]));
    return v;
  }

  private workspaceFile(botId: string, rel: string): string {
    const root = fs.realpathSync(this.o.workspace(botId));
    let real: string;
    try {
      real = fs.realpathSync(path.resolve(root, rel));
    } catch {
      throw new MediaError(`工作区里没有这个文件：${rel}`);
    }
    if (real !== root && !real.startsWith(root + path.sep)) throw new MediaError(`只能引用工作区里的文件：${rel}`);
    const st = fs.statSync(real);
    if (!st.isFile()) throw new MediaError(`不是文件：${rel}`);
    if (st.size > MAX_REFERENCE_BYTES) throw new MediaError(`参考素材太大（${rel}，上限 20 MB）`);
    return real;
  }

  private save(botId: string, kind: MediaKind, data: Buffer, mime: string): string {
    const dir = path.join(this.o.workspace(botId), "media");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
    const ext = EXT[mime.split(";")[0].trim()] ?? (kind === "image" ? "png" : "mp4");
    let name = `${kind}-${stamp}.${ext}`;
    for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${kind}-${stamp}-${i}.${ext}`;
    fs.writeFileSync(path.join(dir, name), data);
    return `media/${name}`;
  }

  /** 结果地址不带我们的 Key 去取（通常是对象存储的签名地址） */
  private async download(url: string): Promise<{ data: Buffer; mime: string }> {
    if (!/^https:\/\//i.test(url)) throw new MediaError("结果地址无效");
    const res = await this.fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new MediaError(`下载结果失败（HTTP ${res.status}）`);
    return this.readBody(res);
  }

  private async readBody(res: Response): Promise<{ data: Buffer; mime: string }> {
    const len = Number(res.headers.get("content-length"));
    if (Number.isFinite(len) && len > MAX_BYTES) throw new MediaError("结果文件过大");
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_BYTES) throw new MediaError("结果文件过大");
    return { data, mime: res.headers.get("content-type") || "" };
  }

  private async image(botId: string, model: MediaModel, prompt: string, body: Record<string, unknown> | undefined, args: Record<string, unknown>): Promise<string> {
    const key = this.key(botId);
    const files: string[] = [];
    if (model.route === "gemini") {
      const req = body ? withoutModel(body) : { contents: [{ role: "user", parts: [{ text: prompt }] }] };
      const res = await this.call(key, "POST", `/models/${encodeURIComponent(model.id)}:generateContent`, req);
      const out = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string }; inline_data?: { mime_type?: string; data?: string } }> } }> };
      for (const c of out.candidates ?? [])
        for (const p of c.content?.parts ?? []) {
          const data = p.inlineData?.data ?? p.inline_data?.data;
          if (data) files.push(this.save(botId, "image", Buffer.from(data, "base64"), p.inlineData?.mimeType ?? p.inline_data?.mime_type ?? "image/png"));
        }
    } else {
      const size = typeof args.size === "string" && /^\d{2,5}x\d{2,5}$/.test(args.size) ? args.size : undefined;
      const req = body ? { ...body, model: model.id } : { model: model.id, prompt, ...(size ? { size } : {}) };
      const res = await this.call(key, "POST", args.endpoint === "edits" ? "/images/edits" : "/images/generations", req);
      const out = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
      for (const item of out.data ?? []) {
        if (item.b64_json) files.push(this.save(botId, "image", Buffer.from(item.b64_json, "base64"), "image/png"));
        else if (item.url) {
          const d = await this.download(item.url);
          files.push(this.save(botId, "image", d.data, d.mime || "image/png"));
        }
      }
    }
    if (!files.length) throw new MediaError(`${model.id} 没有返回图片`);
    log.info("image generated", { bot: botId, model: model.id, files: files.length });
    return `已用 ${model.id} 生成 ${files.length} 张图片，保存在工作区：${files.join("、")}。要发给用户，请用 present 工具交付这些文件。`;
  }

  private async video(botId: string, model: MediaModel, prompt: string, body: Record<string, unknown> | undefined, args: Record<string, unknown>): Promise<string> {
    const key = this.key(botId);
    const seconds = Number(args.seconds);
    const size = typeof args.size === "string" && /^\d{2,5}x\d{2,5}$/.test(args.size) ? args.size : undefined;
    const req = body
      ? { ...body, model: model.id }
      : { model: model.id, prompt, ...(Number.isFinite(seconds) && seconds > 0 ? { seconds: String(Math.round(seconds)) } : {}), ...(size ? { size } : {}) };
    const created = (await (await this.call(key, "POST", "/videos", req)).json()) as { id?: string; task_id?: string };
    const id = created.id || created.task_id;
    if (!id) throw new MediaError("zdzui 没有返回视频任务编号");
    const deadline = Date.now() + (this.o.videoTimeoutMs ?? 20 * 60_000);
    for (;;) {
      const t = (await (await this.call(key, "GET", `/videos/${encodeURIComponent(id)}`, undefined, 30_000)).json()) as {
        status?: string;
        error?: { message?: string } | null;
        error_message?: string;
      };
      if (t.status === "completed") break;
      if (t.status === "failed") throw new MediaError(`视频生成失败：${t.error?.message || t.error_message || "未知原因"}`);
      if (Date.now() > deadline) throw new MediaError(`视频任务 ${id} 超时还没完成，可以稍后再试`);
      await new Promise((r) => setTimeout(r, this.o.pollMs ?? 5000));
    }
    const content = await this.call(key, "GET", `/videos/${encodeURIComponent(id)}/content`, undefined, 600_000);
    const d = await this.readBody(content);
    const file = this.save(botId, "video", d.data, d.mime || "video/mp4");
    log.info("video generated", { bot: botId, model: model.id });
    return `已用 ${model.id} 生成视频，保存在工作区：${file}。要发给用户，请用 present 工具交付这个文件。`;
  }
}

/** body 可以是对象，也可以是 JSON 文本（有的模型会把它写成字符串） */
function parseBody(v: unknown): Record<string, unknown> | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  let o = v;
  if (typeof v === "string") {
    try {
      o = JSON.parse(v);
    } catch {
      throw new MediaError("body 不是合法的 JSON");
    }
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new MediaError("body 必须是 JSON 对象");
  return o as Record<string, unknown>;
}

function withoutModel(body: Record<string, unknown>): Record<string, unknown> {
  const { model: _model, ...rest } = body;
  return rest;
}
