import { describe, expect, it } from "vitest";
import fs from "node:fs";

// UI 调用的团队模型授权接口，必须与 web 服务端代理路由、team-service 客户端路径保持一致。
// 三处任一改动而其他两处没跟上，用户就会看到「保存成功但没生效」或 404。

const read = (path: string) => fs.readFileSync(path, "utf8");
const ui = read("ui/screens/team.js");

describe("团队模型授权接口的三处路径一致", () => {
  const webServer = read("src/web/server.ts");
  const client = read("src/team/client.ts");

  it("UI 读取策略用 GET /team/teams/:id/model-policy", () => {
    expect(ui).toContain('`/team/teams/${encodeURIComponent(teamId)}/model-policy`');
    expect(webServer).toContain('sub[2] === "model-policy" && m === "GET"');
    expect(client).toContain("`/v1/teams/${encodeURIComponent(teamId)}/model-policy`");
  });

  it("UI 保存策略用 PUT /team/teams/:id/model-policy", () => {
    expect(ui).toContain('method: "PUT", body: { mode: policyMode, allowedModels: policyModels }');
    expect(webServer).toContain('sub[2] === "model-policy" && m === "PUT"');
    expect(client).toContain('`/v1/teams/${encodeURIComponent(teamId)}/model-policy`, { method: "PUT"');
  });

  it("UI 保存个人模型用 PUT /team/teams/:id/model-policy/model", () => {
    expect(ui).toContain('`/team/teams/${encodeURIComponent(teamId)}/model-policy/model`');
    expect(webServer).toContain('sub[3] === "model" && m === "PUT"');
    expect(client).toContain("`/v1/teams/${encodeURIComponent(teamId)}/model-policy/model`");
  });

  it("web 服务端把 mode 和 allowedModels 原样传给客户端", () => {
    expect(webServer).toContain("{ mode: b.mode, allowedModels: b.allowedModels }");
    expect(webServer).toContain("team.saveMemberModel(sub[1]!, b.model)");
  });

  it("UI 和服务端都把成员模型的字段名写作 model", () => {
    expect(ui).toContain("body: { model: memberModel }");
    expect(client).toContain("body: { model }");
  });
});

describe("模型授权文案中英文一致", () => {
  const zh = read("ui/locales/zh-CN/team.js");
  const en = read("ui/locales/en/team.js");

  it("新增的授权文案两种语言都有", () => {
    for (const key of [
      "modelPolicyTitle", "modelPolicyHint", "modelPolicyMode", "modelPolicyModeAll",
      "modelPolicyModeCatalog", "modelPolicyModeAllowlist", "modelPolicyModels",
      "modelPolicyModelLabel", "modelPolicyModelDefault", "modelPolicySave",
    ]) {
      expect(zh, `缺少中文 ${key}`).toContain(`${key}:`);
      expect(en, `缺少英文 ${key}`).toContain(`${key}:`);
    }
  });

  it("UI 用到的每个文案键在语言包里都存在", () => {
    const used = [...ui.matchAll(/t\("team\.(modelPolicy[A-Za-z]*)"/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(0);
    for (const key of used) {
      expect(zh, `语言包缺少 ${key}`).toContain(`${key}:`);
      expect(en, `语言包缺少 ${key}`).toContain(`${key}:`);
    }
  });
});
