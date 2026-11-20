import type { PoolClient } from "pg";

/**
 * 策略监控与告警。
 *
 * 与归档副本的差异：归档副本的这份代码查的是归档副本自己的表
 * （team_model_usage_tracking、team_model_policies），在本项目里根本不存在，
 * 直接拿来会查询报错。这里按 013_policy_rules.sql 里的实际表结构重写：
 *   team_model_policy_usage       —— 用量计数
 *   team_model_policy_violations  —— 违规记录
 *   team_model_policy_rules       —— 规则（配额上限写在规则上）
 *
 * 告警只是「看一眼」的辅助信息，不参与任何放行/拒绝判定——
 * 判定在 policy-rules.ts 里做，两边不重复决策。
 */

export type PolicyAlertType = "high_violation_rate" | "quota_approaching" | "rate_limit_spike" | "blocked_model_requested";

export interface PolicyAlert {
  type: PolicyAlertType;
  severity: "info" | "warning" | "critical";
  teamId: string;
  message: string;
  details: Record<string, unknown>;
  timestamp: string;
}

export interface UsageMetrics {
  teamId: string;
  period: "hour" | "day";
  totalRequests: number;
  blockedRequests: number;
  violationsByType: Record<string, number>;
  topModels: Array<{ model: string; count: number }>;
  topUsers: Array<{ userId: string; userEmail: string; requests: number }>;
}

/** 违规率告警阈值：超过 warn 为警告，超过 critical 为严重。 */
const VIOLATION_WARN = 20;
const VIOLATION_CRITICAL = 50;
/** 速率限制告警阈值。 */
const RATE_LIMIT_WARN = 10;
/** 同一被禁模型被请求的次数阈值。 */
const BLOCKED_MODEL_WARN = 5;
/** 配额告警的百分比阈值。 */
const QUOTA_WARN_PCT = 80;
const QUOTA_CRITICAL_PCT = 95;

export class PolicyMonitor {
  constructor(private readonly now: () => number = Date.now) {}

  async checkAlerts(client: PoolClient, teamId: string): Promise<PolicyAlert[]> {
    const alerts: PolicyAlert[] = [];
    const currentTime = new Date(this.now());
    const oneHourAgo = new Date(this.now() - 60 * 60 * 1000);
    const oneDayAgo = new Date(this.now() - 24 * 60 * 60 * 1000);

    // 一小时内的违规总数。
    const recentViolations = await client.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM team_model_policy_violations
       WHERE team_id = $1 AND created_at > $2`,
      [teamId, oneHourAgo],
    );
    const violationCount = Number(recentViolations.rows[0]?.count ?? "0");
    // 涉及的人：用于把「全队告警」缩小到「与我有关的告警」。
    const violationUsers = await client.query<{ user_id: string | null }>(
      `SELECT DISTINCT user_id FROM team_model_policy_violations
       WHERE team_id = $1 AND created_at > $2 AND user_id IS NOT NULL`,
      [teamId, oneHourAgo],
    );
    const userIds = violationUsers.rows.map((row) => row.user_id as string);
    if (violationCount > VIOLATION_CRITICAL) {
      alerts.push({
        type: "high_violation_rate",
        severity: "critical",
        teamId,
        message: `最近一小时有 ${violationCount} 次违规`,
        details: { count: violationCount, threshold: VIOLATION_CRITICAL, userIds },
        timestamp: currentTime.toISOString(),
      });
    } else if (violationCount > VIOLATION_WARN) {
      alerts.push({
        type: "high_violation_rate",
        severity: "warning",
        teamId,
        message: `最近一小时有 ${violationCount} 次违规`,
        details: { count: violationCount, threshold: VIOLATION_WARN, userIds },
        timestamp: currentTime.toISOString(),
      });
    }

    // 接近每日 token 配额的成员。
    //
    // 两条腿分开算：先把用量按人汇总，再把规则里的每日上限按人取出来，最后对着比。
    // 如果把两张表直接 JOIN，用量行会被规则行「乘一遍」——一个成员命中 3 条规则，
    // 他的用量就被算成 3 倍，配额告警会误报。
    //
    // 上限取 MAX（最宽松的那条）：判定是「与」关系，成员真正撞到的是最紧的那条线，
    // 但告警要报「离哪条线最近」，就得看最宽松的那条，否则会一直报一个还没撞到的线。
    const quotaStatus = await client.query<{
      user_id: string;
      user_email: string;
      total_tokens: string;
      max_quota: string;
    }>(
      `SELECT usage.user_id, usage.user_email, usage.total_tokens, limits.max_quota
         FROM (
           SELECT u.user_id, tu.email AS user_email,
                  COALESCE(SUM(u.input_tokens + u.output_tokens), 0) AS total_tokens
             FROM team_model_policy_usage u
             JOIN team_users tu ON tu.id = u.user_id
            WHERE u.team_id = $1 AND u.day_bucket = $2::date
            GROUP BY u.user_id, tu.email
         ) usage
         JOIN (
           SELECT MAX(r.max_total_tokens_per_user_per_day) AS max_quota
             FROM team_model_policy_rules r
            WHERE r.team_id = $1 AND r.enabled = true
              AND r.max_total_tokens_per_user_per_day IS NOT NULL
         ) limits ON TRUE
        WHERE usage.total_tokens > limits.max_quota * 0.8`,
      // 用「应用自己的今天」，不用数据库的 CURRENT_DATE：
      // 两者不在一台机器上时可能差一天，差一天就会整条查不到。
      [teamId, currentTime.toISOString().slice(0, 10)],
    );
    for (const row of quotaStatus.rows) {
      const used = BigInt(row.total_tokens);
      const quota = BigInt(row.max_quota);
      if (quota <= 0n) continue;
      const percentage = Number((used * 100n) / quota);
      if (percentage < QUOTA_WARN_PCT) continue;
      alerts.push({
        type: "quota_approaching",
        severity: percentage >= QUOTA_CRITICAL_PCT ? "critical" : "warning",
        teamId,
        message: `${row.user_email} 已用掉今日 token 配额的 ${percentage}%`,
        details: {
          userId: row.user_id,
          userEmail: row.user_email,
          used: used.toString(),
          quota: quota.toString(),
          percentage,
        },
        timestamp: currentTime.toISOString(),
      });
    }

    // 速率限制类违规集中出现。
    const rateLimitViolations = await client.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM team_model_policy_violations
       WHERE team_id = $1 AND violation_type = 'rate_limit_exceeded' AND created_at > $2`,
      [teamId, oneHourAgo],
    );
    const rateLimitCount = Number(rateLimitViolations.rows[0]?.count ?? "0");
    if (rateLimitCount > RATE_LIMIT_WARN) {
      alerts.push({
        type: "rate_limit_spike",
        severity: "warning",
        teamId,
        message: `最近一小时有 ${rateLimitCount} 次触到速率限制`,
        details: { count: rateLimitCount, threshold: RATE_LIMIT_WARN },
        timestamp: currentTime.toISOString(),
      });
    }

    // 被禁掉的模型仍在被请求 —— 说明有人不知道它已经被禁了。
    const blockedModels = await client.query<{ model_requested: string; count: string }>(
      `SELECT model_requested, COUNT(*) as count
       FROM team_model_policy_violations
       WHERE team_id = $1 AND violation_type = 'model_blocked'
         AND model_requested IS NOT NULL AND created_at > $2
       GROUP BY model_requested
       ORDER BY COUNT(*) DESC
       LIMIT 5`,
      [teamId, oneDayAgo],
    );
    for (const row of blockedModels.rows) {
      const count = Number(row.count);
      if (count <= BLOCKED_MODEL_WARN) continue;
      alerts.push({
        type: "blocked_model_requested",
        severity: "info",
        teamId,
        message: `已被禁用的模型 '${row.model_requested}' 最近 24 小时被请求 ${count} 次`,
        details: { model: row.model_requested, count },
        timestamp: currentTime.toISOString(),
      });
    }

    return alerts;
  }

  async getUsageMetrics(client: PoolClient, teamId: string, period: "hour" | "day"): Promise<UsageMetrics> {
    const startTime = new Date(this.now() - (period === "hour" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000));

    const requestStats = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(request_count), 0) AS total
       FROM team_model_policy_usage
       WHERE team_id = $1 AND hour_bucket > $2`,
      [teamId, startTime],
    );
    const totalRequests = Number(requestStats.rows[0]?.total ?? "0");

    const blockedStats = await client.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM team_model_policy_violations
       WHERE team_id = $1 AND created_at > $2`,
      [teamId, startTime],
    );
    const blockedRequests = Number(blockedStats.rows[0]?.count ?? "0");

    const violationsByType: Record<string, number> = {};
    const violationTypeStats = await client.query<{ violation_type: string; count: string }>(
      `SELECT violation_type, COUNT(*) as count FROM team_model_policy_violations
       WHERE team_id = $1 AND created_at > $2
       GROUP BY violation_type`,
      [teamId, startTime],
    );
    for (const row of violationTypeStats.rows) {
      violationsByType[row.violation_type] = Number(row.count);
    }

    const topModelsStats = await client.query<{ model: string; count: string }>(
      `SELECT model, COALESCE(SUM(request_count), 0) AS count FROM team_model_policy_usage
       WHERE team_id = $1 AND hour_bucket > $2
       GROUP BY model
       ORDER BY count DESC
       LIMIT 10`,
      [teamId, startTime],
    );
    const topModels = topModelsStats.rows.map((row) => ({ model: row.model, count: Number(row.count) }));

    const topUsersStats = await client.query<{ user_id: string; user_email: string; count: string }>(
      `SELECT u.user_id, tu.email AS user_email, COALESCE(SUM(u.request_count), 0) AS count
       FROM team_model_policy_usage u
       JOIN team_users tu ON tu.id = u.user_id
       WHERE u.team_id = $1 AND u.hour_bucket > $2
       GROUP BY u.user_id, tu.email
       ORDER BY count DESC
       LIMIT 10`,
      [teamId, startTime],
    );
    const topUsers = topUsersStats.rows.map((row) => ({
      userId: row.user_id,
      userEmail: row.user_email,
      requests: Number(row.count),
    }));

    return { teamId, period, totalRequests, blockedRequests, violationsByType, topModels, topUsers };
  }
}
