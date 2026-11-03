/**
 * 模态类型的唯一真源：src/modality.ts。
 * 端点类型来自站点 `/api/pricing` 的 supported_endpoint_types，不是按模型名字猜。
 * 选择器 tab 与媒体工具（media.ts）共用 modalityOf()，这里把分类约定钉死。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { MODALITY_ORDER, modalityOf, type Modality } from "../src/modality.js";
import { setLogLevel } from "../src/log.js";

afterEach(() => {
  vi.restoreAllMocks();
  setLogLevel("info");
});

describe("modalityOf：按 supported_endpoint_types 分类", () => {
  it("站点上实际出现的 8 种端点类型各自落在正确的 tab", () => {
    const cases: Array<[string, Modality]> = [
      ["openai", "text"],
      ["openai-video", "video"],
      ["anthropic", "text"],
      ["image-generation", "image"],
      ["openai-response", "text"],
      ["openai-response-compact", "text"],
      ["gemini", "text"],
      ["openai-alpha-search", "text"],
    ];
    for (const [endpoint, expected] of cases) {
      expect([endpoint, modalityOf([endpoint])]).toEqual([endpoint, [expected]]);
    }
  });

  it("一个模型可以属于多个 tab：gpt-image-2 是 image-generation|openai，文本和图片都要有它", () => {
    const mods = modalityOf(["openai", "image-generation"]);
    expect(mods).toEqual(["text", "image"]);
    expect(new Set(mods).size).toBe(mods.length); // 不重复
    // 顺序与展示顺序一致，跟端点在数组里的先后无关
    expect(modalityOf(["image-generation", "openai"])).toEqual(mods);
    expect(modalityOf(["openai", "openai", "openai-response", "anthropic"])).toEqual(["text"]);
  });

  it("认不出的端点类型归「其他」，并留一条 debug，不静默吞掉", () => {
    setLogLevel("debug");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(modalityOf(["openai", "some-new-endpoint"])).toEqual(["text", "other"]);
    const lines = write.mock.calls.map((c) => String(c[0])).join("");
    expect(lines).toContain("unknown endpoint type");
    expect(lines).toContain("some-new-endpoint");
    // 已知端点不应该刷日志
    expect(modalityOf(["openai"])).toEqual(["text"]);
    expect(write.mock.calls.filter((c) => String(c[0]).includes("unknown endpoint type"))).toHaveLength(1);
  });

  it("语音端点先留好映射：站上现在 0 个，但加上模型不改代码就会长出语音 tab", () => {
    for (const e of ["audio", "openai-audio", "tts", "speech", "transcription", "whisper", "realtime"]) {
      expect([e, modalityOf([e])]).toEqual([e, ["voice"]]);
    }
    expect(MODALITY_ORDER).toContain("voice");
    expect(modalityOf(["audio", "openai"])).toEqual(["text", "voice"]);
  });

  it("没有端点信息 = 「其他」（不知道不能当文本），且前后端的 tab 顺序必须一致", () => {
    expect(modalityOf(undefined)).toEqual(["other"]);
    expect(modalityOf([])).toEqual(["other"]);
    // ui/ 是静态模块，import 不到后端，所以那里手写了一份顺序；改一处忘了改另一处就在这里红
    const picker = fs.readFileSync(new URL("../ui/components/model-picker.js", import.meta.url), "utf8");
    const m = picker.match(/const MODALITY_TABS = (\[[^\]]+\])/);
    expect(m, "model-picker.js 里找不到 MODALITY_TABS").toBeTruthy();
    expect(JSON.parse(m![1])).toEqual([...MODALITY_ORDER]);
  });
});
