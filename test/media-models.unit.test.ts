/**
 * 图片 / 视频模型列表的来源。
 *
 * 站上的 new-api **不认** `GET /v1/models?scope=authorized&kind=image|video`（那是上游私有参数），
 * 只会原样返回这把 Key 的全部模型——实测 6 个全是文本模型。用它当来源，图片/视频列表恒为空，
 * 而工具只会说"这把 Key 没有可用的图片模型"，客户看不出是站点那侧的问题。
 *
 * 现在的口径：类型看公开价格目录的 supported_endpoint_types（image-generation / openai-video），
 * 「这把 Key 能不能用」看带 Key 的 GET /v1/models。两者分开，不可用的也必须列出来。
 */
import { describe, it, expect } from "vitest";
import { MediaService, pickDefault, type MediaModel } from "../src/agent/media.js";

const catalog = {
  group_ratio: { "gpt-image-2": 1, 视频模型: 1 },
  usable_group: { "gpt-image-2": "", 视频模型: "" },
  data: [
    { model_name: "gpt-image-2", quota_type: 1, model_price: 0.02, billing_unit: "per_call", enable_groups: ["gpt-image-2"], supported_endpoint_types: ["image-generation", "openai"] },
    { model_name: "seedance-2.0-720p", quota_type: 1, model_price: 0.09, billing_unit: "per_second", enable_groups: ["视频模型"], supported_endpoint_types: ["openai-video"], video_resolution_price: { "720p": 0.09 } },
    { model_name: "seedance-2.0-480p", quota_type: 1, model_price: 0.05, billing_unit: "per_second", enable_groups: ["视频模型"], supported_endpoint_types: ["openai-video"], video_resolution_price: { "480p": 0.05 } },
    // 文本模型：不该出现在图片或视频列表里
    { model_name: "gpt-6-sol", quota_type: 0, model_ratio: 37.5, completion_ratio: 2, enable_groups: ["视频模型"], supported_endpoint_types: ["openai"] },
  ],
};

/** 只给这张 Key 开 gpt-image-2；视频模型站上有、这把 Key 没有 */
function service(models: unknown, opts: { modelsStatus?: number } = {}) {
  const fetchImpl = (async (url: string) => {
    if (url.endsWith("/api/pricing")) return new Response(JSON.stringify(catalog));
    if (url.endsWith("/models")) return new Response(JSON.stringify(models), { status: opts.modelsStatus ?? 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return new MediaService({
    baseUrl: () => "https://api.example/v1",
    keyFor: () => "sk-test",
    headers: () => ({}),
    workspace: () => "/tmp/ws",
    pricingUrl: () => "https://api.example/api/pricing",
    fetchImpl,
  });
}

describe("图片 / 视频模型的来源", () => {
  it("类型来自价格目录的 supported_endpoint_types；能不能用来自 /v1/models，两者分开", async () => {
    const svc = service({ data: [{ id: "gpt-image-2" }, { id: "gpt-6-sol" }] });
    const images = await svc.available("sk-test", "image");
    const videos = await svc.available("sk-test", "video");
    // 文本模型不进任何一个列表
    expect(images.map((m) => m.id)).toEqual(["gpt-image-2"]);
    expect(videos.map((m) => m.id).sort()).toEqual(["seedance-2.0-480p", "seedance-2.0-720p"]);
    expect(images[0]).toMatchObject({ route: "images", available: true });
    // 站上有、这把 Key 的分组没有：不许隐藏，标成 false 让上层去说
    expect(videos.find((m) => m.id === "seedance-2.0-720p")).toMatchObject({ route: "videos", available: false });
  });

  it("拿不到模型列表时 available 是 undefined（不知道 ≠ 不可用）", async () => {
    const svc = service({ data: [] }, { modelsStatus: 500 });
    const list = await svc.available("sk-test", "image");
    expect(list.map((m) => m.id)).toEqual(["gpt-image-2"]);
    expect(list[0]).not.toHaveProperty("available");
  });

  it("默认模型只在能用的里面挑：不可用的排到最后，也不被当成默认", () => {
    const mk = (id: string, available?: boolean): MediaModel => ({ id, kind: "video", route: "videos", requiresReference: false, price: "", priority: 0, ...(available === undefined ? {} : { available }) });
    expect(pickDefault([mk("blocked", false), mk("ok", true)], "blocked")!.id).toBe("ok");
    // 全都不可用时退回原顺序（上层会给出"换分组"的说明，而不是空列表）
    expect(pickDefault([mk("a", false), mk("b", false)], "")!.id).toBe("a");
  });

  it("一个都不能用时，media_models 说清楚是「分组」的问题，并给出站上有哪些", async () => {
    const svc = service({ data: [{ id: "gpt-6-sol" }] });
    const text = await svc.listText("b", "video");
    expect(text).toContain("站上有 2 个视频模型");
    expect(text).toContain("seedance-2.0-720p");
    expect(text).toContain("换到对应的分组");
  });

  it("只说目录里没有，不说「这把 Key 没有」——两者的下一步完全不同", async () => {
    const svc = new MediaService({
      baseUrl: () => "https://api.example/v1",
      keyFor: () => "sk-test",
      headers: () => ({}),
      workspace: () => "/tmp/ws",
      pricingUrl: () => "https://api.example/api/pricing",
      fetchImpl: (async () => new Response(JSON.stringify({ data: [] }))) as unknown as typeof fetch,
    });
    expect(await svc.listText("b", "image")).toContain("公开价格目录里没有图片模型");
  });

  it("prepare 选到不可用的模型时直接拒绝，并列出可用的", async () => {
    // 这把 Key 只有 480p（720p 在站上但不在它的分组里）
    const svc = service({ data: [{ id: "gpt-6-sol" }, { id: "seedance-2.0-480p" }] });
    await expect(svc.prepare("b", "video", { prompt: "a cat", model: "seedance-2.0-720p" })).rejects.toThrow(/不在这把 Key 的分组里/);
    // 一个都没有时说的是另一件事：换分组，不是换模型
    const none = service({ data: [{ id: "gpt-6-sol" }] });
    await expect(none.prepare("b", "video", { prompt: "a cat" })).rejects.toThrow(/分组一个都没有/);
  });
});
