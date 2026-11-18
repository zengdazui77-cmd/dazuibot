import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import type { TeamRole } from "./model.js";

/**
 * 叠加限制层的判定逻辑。
 *
 * 与基线（team_model_policies）的分工：
 *   基线决定「成员可以选哪些模型」——单一模式（全部 / 部署目录 / 指定名单），
 *   成员在范围内自主选择。
 *   本层决定「在这些模型之外还要遵守什么」——黑名单、速率、token 配额、角色范围。
 *
 * 两层是「与」关系：基线先筛出候选模型，本层再对实际要调用的模型做拦截。
 * 本层不产生任何「允许」结论，只产生「拒绝」结论；没有规则命中就放行。
 */

/** 本层的一条规则，与数据库行一一对应。 */
export interface PolicyRule {
  id: string;
  teamId: string;
  ruleName: string;
  enabled: boolean;
  /** 非空时，模型必须在这个名单里；空数组表示本条不限制模型。 */
  allowedModels: string[];
  blockedModels: string[];
  maxRequestsPerUserPerHour: number | null;
  maxRequestsPerTeamPerHour: number | null;
  maxInputTokensPerRequest: number | null;
  maxOutputTokensPerRequest: number | null;
  maxTotalTokensPerUserPerDay: bigint | null;
  /** 空数组表示对所有角色生效。 */
  appliesToRoles: TeamRole[];
  priority: number;
}

export type PolicyViolationType = "model_not_allowed" | "model_blocked" | "rate_limit_exceeded" | "token_limit_exceeded";

export interface PolicyViolation {
  type: PolicyViolationType;
  message: string;
  ruleId?: string;
  ruleName?: string;
  details?: Record<string, unknown>;
}

export interface PolicyRequest {
  teamId: string;
  userId: string;
  userRole: TeamRole;
  model: string;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
}

/** 速率与配额判定需要的计数快照。 */
export interface PolicyUsage {
  requestsThisHour: number;
  teamRequestsThisHour: number;
  tokensToday: bigint;
}

const ALL_ROLES: TeamRole[] = ["owner", "admin", "developer", "viewer"];

/** 规则是否适用于该角色：空角色数组视为对所有角色生效。 */
export function ruleAppliesToRole(rule: PolicyRule, role: TeamRole): boolean {
  if (!rule.appliesToRoles.length) return true;
  return rule.appliesToRoles.includes(role);
}

/**
 * 判断一条规则是否应当命中。
 *
 * 注意速率与配额的语义：计数达到上限即拒绝（`>=`），
 * 与「上限 N 次/小时」的字面含义一致——第 N+1 次请求才会失败。
 */
export function checkAgainstRule(rule: PolicyRule, request: PolicyRequest, usage: PolicyUsage): PolicyViolation | null {
  if (rule.allowedModels.length > 0 && !rule.allowedModels.includes(request.model)) {
    return {
      type: "model_not_allowed",
      message: `Model '${request.model}' is not in the allowed list of policy '${rule.ruleName}'`,
      ruleId: rule.id,
      ruleName: rule.ruleName,
      details: { allowedModels: rule.allowedModels },
    };
  }

  if (rule.blockedModels.includes(request.model)) {
    return {
      type: "model_blocked",
      message: `Model '${request.model}' is blocked by policy '${rule.ruleName}'`,
      ruleId: rule.id,
      ruleName: rule.ruleName,
    };
  }

  if (rule.maxRequestsPerUserPerHour !== null && usage.requestsThisHour >= rule.maxRequestsPerUserPerHour) {
    return {
      type: "rate_limit_exceeded",
      message: `Hourly request limit reached: ${usage.requestsThisHour}/${rule.maxRequestsPerUserPerHour}`,
      ruleId: rule.id,
      ruleName: rule.ruleName,
      details: { limit: rule.maxRequestsPerUserPerHour, current: usage.requestsThisHour, scope: "user" },
    };
  }

  if (rule.maxRequestsPerTeamPerHour !== null && usage.teamRequestsThisHour >= rule.maxRequestsPerTeamPerHour) {
    return {
      type: "rate_limit_exceeded",
      message: `Hourly team request limit reached: ${usage.teamRequestsThisHour}/${rule.maxRequestsPerTeamPerHour}`,
      ruleId: rule.id,
      ruleName: rule.ruleName,
      details: { limit: rule.maxRequestsPerTeamPerHour, current: usage.teamRequestsThisHour, scope: "team" },
    };
  }

  if (rule.maxInputTokensPerRequest !== null && request.estimatedInputTokens !== undefined
    && request.estimatedInputTokens > rule.maxInputTokensPerRequest) {
    return {
      type: "token_limit_exceeded",
      message: `Input tokens exceed limit: ${request.estimatedInputTokens}/${rule.maxInputTokensPerRequest}`,
      ruleId: rule.id,
      ruleName: rule.ruleName,
      details: { limit: rule.maxInputTokensPerRequest, requested: request.estimatedInputTokens, kind: "input" },
    };
  }

  if (rule.maxOutputTokensPerRequest !== null && request.estimatedOutputTokens !== undefined
    && request.estimatedOutputTokens > rule.maxOutputTokensPerRequest) {
    return {
      type: "token_limit_exceeded",
      message: `Output tokens exceed limit: ${request.estimatedOutputTokens}/${rule.maxOutputTokensPerRequest}`,
      ruleId: rule.id,
      ruleName: rule.ruleName,
      details: { limit: rule.maxOutputTokensPerRequest, requested: request.estimatedOutputTokens, kind: "output" },
    };
  }

  if (rule.maxTotalTokensPerUserPerDay !== null) {
    const estimated = BigInt((request.estimatedInputTokens ?? 0) + (request.estimatedOutputTokens ?? 0));
    if (usage.tokensToday + estimated > rule.maxTotalTokensPerUserPerDay) {
      return {
        type: "token_limit_exceeded",
        message: `Daily token quota exceeded: ${usage.tokensToday}/${rule.maxTotalTokensPerUserPerDay}`,
        ruleId: rule.id,
        ruleName: rule.ruleName,
        details: {
          limit: rule.maxTotalTokensPerUserPerDay.toString(),
          current: usage.tokensToday.toString(),
          estimated: estimated.toString(),
        },
      };
    }
  }

  return null;
}

/**
 * 对全部适用规则依次判定，命中第一条就返回。
 * 规则按 priority 降序（高优先级先判），同优先级按创建顺序。
 */
export function checkRules(rules: PolicyRule[], request: PolicyRequest, usage: PolicyUsage): PolicyViolation | null {
  const applicable = rules
    .filter((rule) => rule.enabled && ruleAppliesToRole(rule, request.userRole))
    .sort((a, b) => b.priority - a.priority);
  for (const rule of applicable) {
    const violation = checkAgainstRule(rule, request, usage);
    if (violation) return violation;
  }
  return null;
}

/** 取小时桶与日桶。用应用时钟，但与数据库写入端保持同一来源。 */
export function usageBuckets(now: number): { hourBucket: Date; dayBucket: string } {
  const date = new Date(now);
  const hourBucket = new Date(date);
  hourBucket.setMinutes(0, 0, 0);
  return { hourBucket, dayBucket: date.toISOString().slice(0, 10) };
}

/**
 * 从数据库读取团队当前生效的规则。
 * 只取 enabled 的，按优先级排序；角色过滤留给调用方（checkRules 会做）。
 */
export async function loadPolicyRules(client: PoolClient, teamId: string): Promise<PolicyRule[]> {
  const result = await client.query<{
    id: string;
    team_id: string;
    rule_name: string;
    enabled: boolean;
    allowed_models: string[];
    blocked_models: string[];
    max_requests_per_user_per_hour: number | null;
    max_requests_per_team_per_hour: number | null;
    max_input_tokens_per_request: number | null;
    max_output_tokens_per_request: number | null;
    max_total_tokens_per_user_per_day: string | null;
    applies_to_roles: string[];
    priority: number;
  }>(
    `SELECT id, team_id, rule_name, enabled, allowed_models, blocked_models,
            max_requests_per_user_per_hour, max_requests_per_team_per_hour,
            max_input_tokens_per_request, max_output_tokens_per_request,
            max_total_tokens_per_user_per_day, applies_to_roles, priority
       FROM team_model_policy_rules
      WHERE team_id = $1 AND enabled = true
      ORDER BY priority DESC, created_at`,
    [teamId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    teamId: row.team_id,
    ruleName: row.rule_name,
    enabled: row.enabled,
    allowedModels: row.allowed_models ?? [],
    blockedModels: row.blocked_models ?? [],
    maxRequestsPerUserPerHour: row.max_requests_per_user_per_hour,
    maxRequestsPerTeamPerHour: row.max_requests_per_team_per_hour,
    maxInputTokensPerRequest: row.max_input_tokens_per_request,
    maxOutputTokensPerRequest: row.max_output_tokens_per_request,
    maxTotalTokensPerUserPerDay: row.max_total_tokens_per_user_per_day === null
      ? null
      : BigInt(row.max_total_tokens_per_user_per_day),
    appliesToRoles: (row.applies_to_roles ?? ALL_ROLES) as TeamRole[],
    priority: row.priority,
  }));
}

/** 读取速率与配额判定所需的计数快照。 */
export async function loadPolicyUsage(
  client: PoolClient,
  teamId: string,
  userId: string,
  model: string,
  now: number,
): Promise<PolicyUsage> {
  const { hourBucket, dayBucket } = usageBuckets(now);
  const [userHourly, teamHourly, userDaily] = await Promise.all([
    client.query<{ count: string }>(
      `SELECT COALESCE(SUM(request_count), 0) AS count
         FROM team_model_policy_usage
        WHERE team_id = $1 AND user_id = $2 AND model = $3 AND hour_bucket = $4`,
      [teamId, userId, model, hourBucket],
    ),
    client.query<{ count: string }>(
      `SELECT COALESCE(SUM(request_count), 0) AS count
         FROM team_model_policy_usage
        WHERE team_id = $1 AND hour_bucket = $2`,
      [teamId, hourBucket],
    ),
    client.query<{ total: string }>(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total
         FROM team_model_policy_usage
        WHERE team_id = $1 AND user_id = $2 AND day_bucket = $3`,
      [teamId, userId, dayBucket],
    ),
  ]);
  return {
    requestsThisHour: Number(userHourly.rows[0]?.count ?? 0),
    teamRequestsThisHour: Number(teamHourly.rows[0]?.count ?? 0),
    tokensToday: BigInt(userDaily.rows[0]?.total ?? 0),
  };
}

/** 记录一条违规，供审计与告警使用。 */
export async function recordPolicyViolation(
  client: PoolClient,
  violation: PolicyViolation,
  teamId: string,
  userId: string,
  modelRequested: string,
  now: number,
): Promise<void> {
  await client.query(
    `INSERT INTO team_model_policy_violations(id, team_id, rule_id, user_id, violation_type, model_requested, details, created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      randomHex(),
      teamId,
      violation.ruleId ?? null,
      userId,
      violation.type,
      modelRequested,
      JSON.stringify(violation.details ?? {}),
      new Date(now),
    ],
  );
}

/** 记录一次成功调用的用量。 */
export async function recordPolicyUsage(
  client: PoolClient,
  teamId: string,
  userId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  now: number,
): Promise<void> {
  const { hourBucket, dayBucket } = usageBuckets(now);
  await client.query(
    `INSERT INTO team_model_policy_usage(id, team_id, user_id, model, request_count, input_tokens, output_tokens, hour_bucket, day_bucket, created_at, updated_at)
     VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$9)
     ON CONFLICT(team_id, user_id, model, hour_bucket) DO UPDATE SET
       request_count = team_model_policy_usage.request_count + 1,
       input_tokens = team_model_policy_usage.input_tokens + EXCLUDED.input_tokens,
       output_tokens = team_model_policy_usage.output_tokens + EXCLUDED.output_tokens,
       updated_at = EXCLUDED.updated_at`,
    [randomHex(), teamId, userId, model, inputTokens, outputTokens, hourBucket, dayBucket, new Date(now)],
  );
}

/** 清理超过保留期的用量记录。 */
export async function cleanupPolicyUsage(client: PoolClient, before: Date): Promise<number> {
  const result = await client.query("DELETE FROM team_model_policy_usage WHERE created_at < $1", [before]);
  return result.rowCount ?? 0;
}

function randomHex(): string {
  return randomBytes(16).toString("hex");
}
