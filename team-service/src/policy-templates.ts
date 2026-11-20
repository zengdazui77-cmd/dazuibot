import type { TeamRole } from "./model.js";

/**
 * 常用策略模板。
 *
 * 与归档副本的差异：归档副本的模板对应的是它自己那套「单表多字段」结构
 * （CreateModelPolicyRequest），字段是 allowedModels / blockedModels 混在一个对象里。
 * 本项目把叠加限制层拆成了「一条规则一行」的结构，所以模板直接产出规则配置，
 * 由调用方落库。
 */

export type PolicyTemplateCategory = "security" | "cost_control" | "performance" | "compliance";

export interface PolicyTemplateConfig {
  allowedModels: string[];
  blockedModels: string[];
  maxRequestsPerUserPerHour: number | null;
  maxRequestsPerTeamPerHour: number | null;
  maxInputTokensPerRequest: number | null;
  maxOutputTokensPerRequest: number | null;
  maxTotalTokensPerUserPerDay: string | null;
  appliesToRoles: TeamRole[];
  priority: number;
}

export interface PolicyTemplate {
  id: string;
  name: string;
  description: string;
  category: PolicyTemplateCategory;
  config: PolicyTemplateConfig;
}

const NONE: PolicyTemplateConfig = {
  allowedModels: [],
  blockedModels: [],
  maxRequestsPerUserPerHour: null,
  maxRequestsPerTeamPerHour: null,
  maxInputTokensPerRequest: null,
  maxOutputTokensPerRequest: null,
  maxTotalTokensPerUserPerDay: null,
  appliesToRoles: [],
  priority: 100,
};

function tpl(
  id: string,
  name: string,
  description: string,
  category: PolicyTemplateCategory,
  config: Partial<PolicyTemplateConfig>,
): PolicyTemplate {
  return { id, name, description, category, config: { ...NONE, ...config } };
}

export const POLICY_TEMPLATES: PolicyTemplate[] = [
  tpl("strict-rate-limit", "严格速率限制", "防止接口被滥用，限制每小时请求数", "security", {
    maxRequestsPerUserPerHour: 10,
    maxRequestsPerTeamPerHour: 100,
    appliesToRoles: ["developer", "viewer"],
    priority: 5,
  }),
  tpl("viewer-restricted", "只读成员限制", "限制只读成员可用的模型和用量", "security", {
    allowedModels: ["gpt-3.5-turbo", "gpt-4o-mini"],
    maxRequestsPerUserPerHour: 5,
    maxInputTokensPerRequest: 2000,
    maxOutputTokensPerRequest: 1000,
    appliesToRoles: ["viewer"],
    priority: 1,
  }),
  tpl("token-quota", "每日 token 配额", "控制每位成员每天的 token 用量", "cost_control", {
    maxTotalTokensPerUserPerDay: "100000",
    appliesToRoles: ["developer", "viewer"],
    priority: 15,
  }),
  tpl("cost-efficient", "成本优化", "限制使用昂贵模型，给出经济型模型作为备选", "cost_control", {
    allowedModels: ["gpt-3.5-turbo", "claude-3-haiku", "gpt-4o-mini"],
    maxRequestsPerUserPerHour: 50,
    maxInputTokensPerRequest: 4000,
    maxOutputTokensPerRequest: 2000,
    appliesToRoles: ["developer", "viewer"],
    priority: 20,
  }),
  tpl("block-legacy", "禁用旧版模型", "阻止使用已废弃的旧版本模型", "compliance", {
    blockedModels: ["gpt-3.5-turbo-0301", "text-davinci-003", "text-curie-001"],
    appliesToRoles: ["developer", "viewer"],
    priority: 1,
  }),
  tpl("production-safe", "生产环境安全", "生产环境专用，严格限制模型和用量", "compliance", {
    allowedModels: ["gpt-4", "claude-3-opus"],
    maxRequestsPerTeamPerHour: 500,
    maxInputTokensPerRequest: 8000,
    maxOutputTokensPerRequest: 4000,
    appliesToRoles: ["developer", "admin", "owner"],
    priority: 1,
  }),
  tpl("high-capacity", "高容量", "为核心成员放开更高的用量上限", "performance", {
    maxRequestsPerUserPerHour: 200,
    maxTotalTokensPerUserPerDay: "500000",
    appliesToRoles: ["admin", "owner"],
    priority: 50,
  }),
];

export function getTemplateById(templateId: string): PolicyTemplate | undefined {
  return POLICY_TEMPLATES.find((t) => t.id === templateId);
}

export function getTemplatesByCategory(category: PolicyTemplateCategory): PolicyTemplate[] {
  return POLICY_TEMPLATES.filter((t) => t.category === category);
}

export function listAllTemplates(): PolicyTemplate[] {
  return [...POLICY_TEMPLATES];
}
