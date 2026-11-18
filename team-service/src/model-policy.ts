import type { TeamModelPolicyMode } from "./model.js";

/** 模型标识符格式：与团队模型凭据保持一致 */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;

export interface ModelPolicyRow {
  mode: TeamModelPolicyMode;
  allowedModels: string[];
}

export interface MemberModelRow {
  model: string;
}

/** 校验并归一化模型标识符；非法返回 undefined */
export function normalizeModelId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!value || !MODEL_ID_PATTERN.test(value)) return undefined;
  return value;
}

export function dedupeModels(models: string[]): string[] {
  return [...new Set(models)];
}

/**
 * 计算某授权模式下成员被允许的模型集合。
 * 返回 undefined 表示不限制（mode = all）。
 */
export function permittedModels(
  mode: TeamModelPolicyMode,
  allowedModels: string[],
  catalogModels: string[],
): string[] | undefined {
  if (mode === "all") return undefined;
  if (mode === "catalog") return dedupeModels(catalogModels);
  return dedupeModels(allowedModels);
}

/** 判断某个模型是否落在授权范围内 */
export function isModelPermitted(
  mode: TeamModelPolicyMode,
  allowedModels: string[],
  catalogModels: string[],
  model: string,
): boolean {
  const permitted = permittedModels(mode, allowedModels, catalogModels);
  if (!permitted) return true;
  return permitted.includes(model);
}

/**
 * 决定成员实际使用的模型：优先成员在授权范围内的自主选择，否则回落到团队默认模型。
 * 返回 undefined 表示当前没有任何可用模型（团队尚未配置凭据）。
 */
export function resolveMemberModel(input: {
  mode: TeamModelPolicyMode;
  allowedModels: string[];
  catalogModels: string[];
  memberModel?: string;
  teamModel?: string;
}): string | undefined {
  const { mode, allowedModels, catalogModels, memberModel, teamModel } = input;
  if (memberModel && isModelPermitted(mode, allowedModels, catalogModels, memberModel)) return memberModel;
  if (teamModel && isModelPermitted(mode, allowedModels, catalogModels, teamModel)) return teamModel;
  const permitted = permittedModels(mode, allowedModels, catalogModels);
  // 团队默认模型不在授权范围内时，回落到授权集合里的第一个模型
  return permitted?.[0];
}
