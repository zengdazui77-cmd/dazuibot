import { describe, expect, it } from "vitest";
import { MediaService } from "../src/agent/media.js";
import { skillHeader } from "../src/modelflare.js";
import { listen, readJson } from "./helpers.js";

/**
 * 无限画布的 AI 生图：与 agent 工具那条路径共用 MediaService，
 * 但不落工作区、直接返回字节——界面拿到就能贴到节点上。
 */

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

/** 起一个假的图片服务：价格目录 + Images API */
async function fakeImageServer(opts: { gemini?: boolean; noImage?: boolean } = {}) {
  const seen: Array<{ path: string; body?: unknown; auth?: string }> = [];
  const srv = await listen(async (req, res) => {
    const u = new URL(req.url!, "http://x");
    const json = (o: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(o));
    seen.push({ path: u.pathname, auth: req.headers.authorization });
    if (u.pathname === "/api/pricing") {
      return json({
        data: opts.noImage
          ? [{ model_name: "text-only", supported_endpoint_types: ["openai"] }]
          : [{ model_name: opts.gemini ? "gemini-img" : "gpt-image", supported_endpoint_types: ["image-generation", "openai"] }],
      });
    }
    if (u.pathname === "/v1/models") {
      return json({ data: [{ id: opts.gemini ? "gemini-img" : "gpt-image" }] });
    }
    if (u.pathname === "/v1/images/generations") {
      seen[seen.length - 1]!.body = await readJson(req);
      return json({ data: [{ b64_json: PNG.toString("base64") }] });
    }
    if (u.pathname.startsWith("/v1/models/") && u.pathname.endsWith(":generateContent")) {
      return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG.toString("base64") } }] } }] });
    }
    res.writeHead(404).end();
  });
  return { srv, seen };
}

describe("画布生图：直接拿图片字节", () => {
  it("走 Images API，拿到字节但不落工作区", async () => {
    const { srv, seen } = await fakeImageServer();
    try {
      const media = new MediaService({
        baseUrl: () => srv.url + "/v1",
        keyFor: () => "sk-bot",
        headers: () => skillHeader("0.1.3"),
        workspace: () => "/tmp/never-used",
        pricingUrl: () => srv.url + "/api/pricing",
      });
      const out = await media.generateImageBytes("b1", { prompt: "一只猫", model: "gpt-image" });
      expect(out.data).toEqual(PNG);
      expect(out.mime).toBe("image/png");
      expect(out.model).toBe("gpt-image");
      expect(seen.find((x) => x.path === "/v1/images/generations")?.body).toMatchObject({ model: "gpt-image", prompt: "一只猫" });
    } finally {
      await srv.close();
    }
  });

  it("走 Gemini 的 generateContent 也能拿到字节", async () => {
    const { srv } = await fakeImageServer({ gemini: true });
    try {
      const media = new MediaService({
        baseUrl: () => srv.url + "/v1",
        keyFor: () => "sk-bot",
        headers: () => skillHeader("0.1.3"),
        workspace: () => "/tmp/never-used",
        pricingUrl: () => srv.url + "/api/pricing",
      });
      const out = await media.generateImageBytes("b1", { prompt: "一只猫", model: "gemini-img" });
      expect(out.data).toEqual(PNG);
      expect(out.mime).toBe("image/png");
    } finally {
      await srv.close();
    }
  });

  it("没给模型就用推荐的那个", async () => {
    const { srv, seen } = await fakeImageServer();
    try {
      const media = new MediaService({
        baseUrl: () => srv.url + "/v1",
        keyFor: () => "sk-bot",
        headers: () => skillHeader("0.1.3"),
        workspace: () => "/tmp/never-used",
        pricingUrl: () => srv.url + "/api/pricing",
      });
      const out = await media.generateImageBytes("b1", { prompt: "一只猫" });
      expect(out.model).toBe("gpt-image");
      expect(seen.find((x) => x.path === "/v1/images/generations")?.body).toMatchObject({ model: "gpt-image" });
    } finally {
      await srv.close();
    }
  });

  it("提示词为空直接拒绝，不发请求", async () => {
    const { srv, seen } = await fakeImageServer();
    try {
      const media = new MediaService({
        baseUrl: () => srv.url + "/v1",
        keyFor: () => "sk-bot",
        headers: () => skillHeader("0.1.3"),
        workspace: () => "/tmp/never-used",
        pricingUrl: () => srv.url + "/api/pricing",
      });
      await expect(media.generateImageBytes("b1", { prompt: "  " })).rejects.toThrow(/缺少 prompt/);
      expect(seen.filter((x) => x.path === "/v1/images/generations")).toHaveLength(0);
    } finally {
      await srv.close();
    }
  });

  it("没有连接时说清楚原因", async () => {
    const { srv } = await fakeImageServer();
    try {
      const media = new MediaService({
        baseUrl: () => srv.url + "/v1",
        keyFor: () => "",
        headers: () => skillHeader("0.1.3"),
        workspace: () => "/tmp/never-used",
        pricingUrl: () => srv.url + "/api/pricing",
      });
      await expect(media.generateImageBytes("b1", { prompt: "一只猫" })).rejects.toThrow(/还没有连接/);
    } finally {
      await srv.close();
    }
  });

  it("站点没有图片模型时说清楚，而不是让用户对着空列表猜", async () => {
    const { srv } = await fakeImageServer({ noImage: true });
    try {
      const media = new MediaService({
        baseUrl: () => srv.url + "/v1",
        keyFor: () => "sk-bot",
        headers: () => skillHeader("0.1.3"),
        workspace: () => "/tmp/never-used",
        pricingUrl: () => srv.url + "/api/pricing",
      });
      await expect(media.generateImageBytes("b1", { prompt: "一只猫" })).rejects.toThrow(/没有图片模型/);
    } finally {
      await srv.close();
    }
  });

  it("模型名不存在时把可用的列出来", async () => {
    const { srv } = await fakeImageServer();
    try {
      const media = new MediaService({
        baseUrl: () => srv.url + "/v1",
        keyFor: () => "sk-bot",
        headers: () => skillHeader("0.1.3"),
        workspace: () => "/tmp/never-used",
        pricingUrl: () => srv.url + "/api/pricing",
      });
      await expect(media.generateImageBytes("b1", { prompt: "一只猫", model: "nope" })).rejects.toThrow(/没有这个模型/);
    } finally {
      await srv.close();
    }
  });
});
