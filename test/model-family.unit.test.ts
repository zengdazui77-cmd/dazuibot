/** 模型选择器的模型族分组：Modelflare 的 ID 不带厂商前缀，按名字归族，族内版本新的在前。 */
import { describe, it, expect } from "vitest";
// @ts-expect-error 界面代码是不经构建的 JS
import { groupModels, modelFamily, OTHER_FAMILY, looksNonChat, visibleModels } from "../ui/lib/models.js";

// Modelflare 2026-10-30 公开的对话模型（节选）
const LIST = [
  "claude-fable-5", "claude-fable-5-1", "claude-haiku-4-5", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-5-5",
  "codex-auto-review", "deepseek-v4-flash", "deepseek-v4.1-flash", "gemini-3.1-pro-preview", "gemini-3.8-flash",
  "glm-5.3", "gpt-5.4", "gpt-5.6-sol", "gpt-6-sol", "gpt-6.1-sol", "grok-4.5", "grok-4.7", "kimi-k3", "muse-spark-1.3", "qwen3.8-max",
];

describe("模型族", () => {
  it("按名字认族；认不出的归「其他」，带 modelflare/ 前缀也一样", () => {
    expect(modelFamily("gpt-6-sol")).toBe("GPT");
    expect(modelFamily("o3-mini")).toBe("GPT");
    expect(modelFamily("codex-auto-review")).toBe("GPT");
    expect(modelFamily("modelflare/claude-opus-5-5")).toBe("Claude");
    expect(modelFamily("qwen3.8-max")).toBe("Qwen");
    expect(modelFamily("kimi-k3")).toBe("Kimi");
    expect(modelFamily("muse-spark-1.3")).toBe(OTHER_FAMILY);
    expect(OTHER_FAMILY).toBe("other");
  });

  it("族按固定顺序，「其他」最后；族内版本新的在前，同版本按名字", () => {
    const g = groupModels(LIST);
    expect(g.map(([f]: [string]) => f)).toEqual(["GPT", "Claude", "Gemini", "Grok", "DeepSeek", "Qwen", "Kimi", "GLM", OTHER_FAMILY]);
    const of = (f: string) => g.find(([x]: [string]) => x === f)[1].map(([, label]: [string, string]) => label);
    expect(of("GPT")).toEqual(["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.4", "codex-auto-review"]);
    expect(of("Claude")).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-fable-5", "claude-opus-5", "claude-haiku-4-5"]);
    expect(of("DeepSeek")).toEqual(["deepseek-v4.1-flash", "deepseek-v4-flash"]);
  });

  it("日期后缀不当版本号；筛选只留匹配的族", () => {
    const g = groupModels(["claude-sonnet-4-20250514", "claude-3-5-sonnet-20241022", "claude-opus-4-1"]);
    expect(g[0][1].map(([m]: [string]) => m)).toEqual(["claude-opus-4-1", "claude-sonnet-4-20250514", "claude-3-5-sonnet-20241022"]);
    expect(groupModels(LIST, "flash").map(([f]: [string]) => f)).toEqual(["Gemini", "DeepSeek"]);
  });
});

describe("明显不能对话的模型：默认隐藏，可开关看全部", () => {
  it("生图 / 向量 / 转写 / 审核按整词认出来", () => {
    for (const id of [
      "dall-e-3", "gpt-image-1", "imagen-3", "flux-pro", "sdxl-turbo", "stable-diffusion-xl",
      "kling-v2", "veo-3", "sora-2", "suno-v4", "text-embedding-3-large", "bge-m3", "gte-large",
      "rerank-v1", "omni-moderation-latest", "whisper-1", "tts-1", "gpt-4o-transcribe",
      "openai/gpt-image-1", "gemini-2.5-flash-image",
    ]) {
      expect([id, looksNonChat(id)] as const).toEqual([id, true]);
    }
  });

  it("能对话的模型不能误杀（尤其带 audio / vision / chat 的）", () => {
    for (const id of [
      ...LIST,
      "gpt-4o-audio-preview", "qwen2.5-vl-72b", "llava-1.5", "gpt-4-vision-preview",
      "chatgpt-4o-latest", "qwen3.8-max", "deepseek-vl2", "doubao-seed-1.6",
      "moonshot-v1-128k", "llama-4-scout", "mistral-large-latest",
    ]) {
      expect([id, looksNonChat(id)] as const).toEqual([id, false]);
    }
  });

  it("关着就藏、开着全给；当前选中的那个即使被判不能对话也留着", () => {
    const all = ["gpt-6-sol", "dall-e-3", "claude-opus-5", "bge-m3"];
    expect(visibleModels(all, false)).toEqual(["gpt-6-sol", "claude-opus-5"]);
    expect(visibleModels(all, true)).toEqual(all);
    // 客户可能通过"自定义模型 ID"或旧配置选中了一个被藏起来的模型，不能让它凭空消失
    expect(visibleModels(all, false, "dall-e-3")).toEqual(["gpt-6-sol", "dall-e-3", "claude-opus-5"]);
    expect(visibleModels(all, false, "modelflare/dall-e-3")).toEqual(["gpt-6-sol", "dall-e-3", "claude-opus-5"]);
  });
});
