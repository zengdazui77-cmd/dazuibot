// 模型 ID 的显示与分组（不依赖界面，单元测试直接引入）。

/** 内置网关列出的模型带 "modelflare/" 前缀，zdzui 直接列出的不带；两种写法都能调用，显示与比较时去掉它 */
export const normModel = (m) => (m && m.startsWith("modelflare/") ? m.slice("modelflare/".length) : m || "");
export const sameModel = (a, b) => !!a && !!b && normModel(a) === normModel(b);
export const shortModel = (m) => (m && m.includes("/") ? m.slice(m.lastIndexOf("/") + 1) : m);

// —— 模型族：按名字认（zdzui 的 ID 不带厂商前缀，如 gpt-6-sol、claude-opus-5-5）。数组顺序就是显示顺序，认不出的归 OTHER_FAMILY 放最后 ——
const FAMILIES = [
  ["GPT", /^(gpt|chatgpt|codex|o\d)/],
  ["Claude", /^claude/],
  ["Gemini", /^gemini/],
  ["Grok", /^grok/],
  ["DeepSeek", /^deepseek/],
  ["Qwen", /^(qwen|qwq)/],
  ["Kimi", /^(kimi|moonshot)/],
  ["GLM", /^(glm|chatglm)/],
  ["MiniMax", /^(minimax|abab)/],
  ["Doubao", /^(doubao|seed)/],
  ["Llama", /^llama/],
  ["Mistral", /^(mistral|mixtral|magistral|codestral|devstral|ministral)/],
];
/** 认不出的族：一个不随语言变的记号，显示时由界面翻译（model-picker.js 的 familyName，「其他」/ Other） */
export const OTHER_FAMILY = "other";
const ORDER = [...FAMILIES.map(([f]) => f), OTHER_FAMILY];

export function modelFamily(id) {
  const n = (shortModel(normModel(id)) || "").toLowerCase();
  return FAMILIES.find(([, re]) => re.test(n))?.[0] ?? OTHER_FAMILY;
}

/** 名字里第一个版本号（5-5、6.1、v4.1、qwen3.8）读成数字数组；4 位以上的数字是日期之类，到此为止 */
function version(id) {
  const m = id.match(/\d+(?:[.-]\d+)*/);
  const out = [];
  for (const p of m ? m[0].split(/[.-]/) : []) {
    if (p.length > 3) break;
    out.push(Number(p));
  }
  return out;
}

/** 族内排序：版本新的在前（6.1 > 6 > 5.6），同版本按名字 */
function newerFirst(a, b) {
  const x = version(a);
  const y = version(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (y[i] ?? -1) - (x[i] ?? -1);
    if (d) return d;
  }
  return a.localeCompare(b);
}

/** 按模型族分组并按 q 筛选；返回 [族名, [[原始 id, 显示名]]]，族按固定顺序 */
export function groupModels(models, q = "") {
  const needle = q.trim().toLowerCase();
  const groups = new Map();
  for (const m of models) {
    const n = normModel(m);
    if (needle && !n.toLowerCase().includes(needle)) continue;
    const f = modelFamily(m);
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push([m, n.includes("/") ? n.slice(n.indexOf("/") + 1) : n]);
  }
  for (const ms of groups.values()) ms.sort((a, b) => newerFirst(a[1], b[1]));
  return [...groups.entries()].sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]));
}

// —— 明显不能对话的模型：按 ID 关键词认，默认从列表里隐藏 ——
//
// 为什么用黑名单 + 软隐藏，而不是白名单或硬删：
//   1. 黑名单一定会误伤（有的生图模型名字里带 chat，有的对话模型名字里带 image），
//      所以必须有「显示全部模型」这个自救开关；硬删就没救了。
//   2. 反过来，认不出的模型一律当可对话。误杀的症状是"模型莫名消失"，客户和我们都很难查；
//      多显示几个不能用的模型，客户点一次就知道。
//   3. 关键词只认"整词"，不做子串匹配——`gpt-4o-audio-preview` 是能对话的，
//      不能因为带 audio 就被藏掉；`tts-1`、`whisper-1` 才是真的不能对话。
const NON_CHAT_WORD =
  /(^|[-_/])(dall-?e|gpt-image|imagen|flux|sdxl|sd3|stable-diffusion|midjourney|ideogram|recraft|kling|veo|sora|runway|pika|suno|udio|embed|embedding|rerank|moderation|whisper|transcribe|tts|image|img|video)([-_/]|$)/i;
/** 前缀式的向量模型（bge-m3、gte-large、text-embedding-3-large 这类没有词边界） */
const NON_CHAT_PREFIX = /^(bge|gte|e5-|jina-embed|text-embedding|nomic-embed)/i;

/** 这个模型看起来是不是不能对话 */
export function looksNonChat(id) {
  const n = shortModel(normModel(id)) || "";
  return NON_CHAT_WORD.test(n) || NON_CHAT_PREFIX.test(n);
}

/**
 * 列表实际显示哪些模型。keep 是当前选中的那个：即使它被判定为不能对话也要留着，
 * 否则客户会以为"我刚才选的模型不见了"。
 */
export function visibleModels(models, showAll, keep = "") {
  if (showAll) return models;
  return models.filter((m) => !looksNonChat(m) || sameModel(m, keep));
}
