import { describe, expect, it } from "vitest";
import fs from "node:fs";

// 额外限制层（叠加规则）的接口在四个地方各写了一遍：
//   桌面端 UI（ui/screens/team.js）
//   桌面端 web 服务端代理（src/web/server.ts）
//   桌面端 team 客户端（src/team/client.ts）
//   团队服务自己的路由（team-service/src/http.ts）
// 任一处改了而其他几处没跟上，用户就会看到「保存成功但没生效」或者 404。
// 这条路已经踩过一次坑（单条启停的路径段数写错，返回 404），所以把它钉住。

const read = (path: string) => fs.readFileSync(path, "utf8");
const ui = read("ui/screens/team.js");
const webServer = read("src/web/server.ts");
const client = read("src/team/client.ts");
const svcHttp = read("team-service/src/http.ts");
const svcClient = read("team-service/src/service.ts");
const zh = read("ui/locales/zh-CN/team.js");
const en = read("ui/locales/en/team.js");

describe("额外限制规则的接口路径一致", () => {
  it("桌面端 UI 调的是 web 服务端的代理路径", () => {
    expect(ui).toContain('`/team/teams/${encodeURIComponent(teamId)}/model-policy-rules`');
    expect(ui).toContain('`/team/teams/${encodeURIComponent(teamId)}/model-policy-rules/${encodeURIComponent(rule.id)}/enabled`');
    expect(ui).toContain('`/team/teams/${encodeURIComponent(teamId)}/model-policy-rules/${encodeURIComponent(rule.id)}`');
    // 载入违规记录时用的是刷新函数里的 id（不是 teamId），两个变量名都出现过
    expect(ui).toContain('/model-policy-violations`');
  });

  it("web 服务端确实代理了这四条路径", () => {
    expect(webServer).toContain('sub[2] === "model-policy-rules" && m === "GET"');
    expect(webServer).toContain('sub[2] === "model-policy-rules" && m === "POST"');
    expect(webServer).toContain('sub[2] === "model-policy-rules" && sub[4] === "enabled" && m === "PUT"');
    expect(webServer).toContain('sub[2] === "model-policy-rules" && m === "DELETE"');
    expect(webServer).toContain('sub[2] === "model-policy-violations" && m === "GET"');
  });

  it("单条启停用的是 5 段路径（:ruleId/enabled），不是 4 段", () => {
    // /model-policy-rules/enabled 是批量启停（4 段），/model-policy-rules/:rid/enabled 是单条（5 段）。
    // 写成 4 段时单条启停会落到「读取一条规则」的路由上，看起来像是启用了，实际是把规则改了。
    expect(webServer).toContain("sub.length === 5 && sub[0] === \"teams\" && sub[2] === \"model-policy-rules\" && sub[4] === \"enabled\"");
    expect(client).toContain("model-policy-rules/${encodeURIComponent(ruleId)}/enabled");
  });

  it("team 客户端调的是团队服务自己的路径", () => {
    expect(client).toContain("`/v1/teams/${encodeURIComponent(teamId)}/model-policy-rules`");
    expect(client).toContain("`/v1/teams/${encodeURIComponent(teamId)}/model-policy-rules/${encodeURIComponent(ruleId)}`");
    expect(client).toContain("`/v1/teams/${encodeURIComponent(teamId)}/model-policy-rules/${encodeURIComponent(ruleId)}/enabled`");
    expect(client).toContain("`/v1/teams/${encodeURIComponent(teamId)}/model-policy-violations`");
  });

  it("团队服务的路由与客户端路径对得上", () => {
    expect(svcHttp).toContain('path[3] === "model-policy-rules" && path.length === 4 && method === "GET"');
    expect(svcHttp).toContain('path[3] === "model-policy-rules" && path.length === 4 && method === "POST"');
    expect(svcHttp).toContain('path[3] === "model-policy-rules" && path.length === 6 && path[5] === "enabled" && method === "PUT"');
    expect(svcHttp).toContain('path[3] === "model-policy-rules" && path.length === 5 && method === "DELETE"');
    expect(svcHttp).toContain('path[3] === "model-policy-violations" && path.length === 4 && method === "GET"');
  });

  it("团队服务实现了客户端调用的每个方法", () => {
    for (const method of ["listPolicyRules", "createPolicyRule", "updatePolicyRule", "deletePolicyRule", "setPolicyRulesEnabled", "listPolicyViolations"]) {
      expect(svcClient, `团队服务缺少 ${method}`).toContain(`${method}(`);
    }
  });
});

describe("额外限制的文案中英文一致", () => {
  it("新增的文案键两种语言都有", () => {
    for (const key of [
      "policyRulesTitle", "policyRulesHint", "policyRuleNone", "policyRuleName",
      "policyRuleNamePlaceholder", "policyRuleBlockedLabel", "policyRuleBlockedPlaceholder",
      "policyRuleRateLabel", "policyRuleRatePlaceholder", "policyRuleAdd", "policyRuleAdded",
      "policyRuleActive", "policyRuleInactive", "policyRuleEnable", "policyRuleDisable",
      "policyRuleDelete", "policyRuleEnabled", "policyRuleDisabled", "policyRuleDeleted",
      "policyRuleRoles", "policyRuleAllRoles", "policyRuleUserRate", "policyRuleTeamRate",
      "policyRuleDailyTokens", "policyRuleBlocked", "policyRuleAllowed",
      "policyViolationsTitle", "policyViolationUnknownUser",
    ]) {
      expect(zh, `缺少中文 ${key}`).toContain(`${key}:`);
      expect(en, `缺少英文 ${key}`).toContain(`${key}:`);
    }
  });

  it("UI 用到的每个文案键在语言包里都存在", () => {
    const used = [...ui.matchAll(/t\("team\.(policyRule[A-Za-z]*|policyRules[A-Za-z]*|policyViolations[A-Za-z]*|policyViolation[A-Za-z]*)"/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(0);
    for (const key of used) {
      expect(zh, `语言包缺少 ${key}`).toContain(`${key}:`);
      expect(en, `语言包缺少 ${key}`).toContain(`${key}:`);
    }
  });
});
