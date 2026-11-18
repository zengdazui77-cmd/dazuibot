-- 模型策略的「叠加限制层」。
--
-- 与 011_model_policy.sql 的分工：
--   team_model_policies（基线）—— 每个团队一行，决定「成员可以选哪些模型」：
--     mode=all 不限制 / catalog 部署目录 / allowlist 团队白名单。成员在此范围内自主选择。
--   team_model_policy_rules（本表，叠加层）—— 每个团队多行，是加在基线之上的额外约束：
--     模型黑名单、速率限制、token 配额、只对某些角色生效。
--     生效规则之间是「与」关系：任何一条命中就拒绝。
--
-- 表名刻意与基线表 team_model_policies 区分开，避免两套语义混在一张表里。
--
-- 与归档副本的差异（归档副本的 011_model_policies.sql 建的是同名表 team_model_policies，
-- 结构与基线表冲突，已弃用）：
--   1) created_by 可空且 ON DELETE SET NULL —— 成员被删后规则仍然留存，不至于整条策略消失。
--   2) 用量唯一索引带上 team_id —— 归档副本的 (user_id, model, hour_bucket) 会让
--      同一个人在不同团队用同一个模型时互相覆盖计数。
--   3) 违规类型里没有 role_restriction —— 角色不匹配时不产生违规，
--      角色只决定「哪条规则适用」，不适用就不参与判定。

CREATE TABLE IF NOT EXISTS team_model_policy_rules (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  rule_name TEXT NOT NULL CHECK (char_length(rule_name) BETWEEN 1 AND 100),
  enabled BOOLEAN NOT NULL DEFAULT true,

  -- 模型限制：allowed_models 为空表示「本条不限制模型」，非空则与基线范围取交集。
  allowed_models TEXT[] NOT NULL DEFAULT '{}',
  blocked_models TEXT[] NOT NULL DEFAULT '{}',

  -- 速率限制（次/小时）
  max_requests_per_user_per_hour INTEGER CHECK (max_requests_per_user_per_hour >= 0),
  max_requests_per_team_per_hour INTEGER CHECK (max_requests_per_team_per_hour >= 0),

  -- token 限制
  max_input_tokens_per_request INTEGER CHECK (max_input_tokens_per_request > 0),
  max_output_tokens_per_request INTEGER CHECK (max_output_tokens_per_request > 0),
  max_total_tokens_per_user_per_day BIGINT CHECK (max_total_tokens_per_user_per_day > 0),

  -- 适用角色：空数组表示「对所有角色生效」
  applies_to_roles TEXT[] NOT NULL DEFAULT '{owner,admin,developer,viewer}' CHECK (
    applies_to_roles <@ ARRAY['owner','admin','developer','viewer']::TEXT[]
  ),

  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  created_by TEXT REFERENCES team_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(team_id, rule_name)
);

CREATE INDEX IF NOT EXISTS team_model_policy_rules_team ON team_model_policy_rules(team_id, enabled, priority DESC, created_at);

-- 违规记录：供审计与告警使用。
CREATE TABLE IF NOT EXISTS team_model_policy_violations (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  rule_id TEXT REFERENCES team_model_policy_rules(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES team_users(id) ON DELETE SET NULL,
  violation_type TEXT NOT NULL CHECK (violation_type IN (
    'model_not_allowed',
    'model_blocked',
    'rate_limit_exceeded',
    'token_limit_exceeded'
  )),
  model_requested TEXT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS team_model_policy_violations_team ON team_model_policy_violations(team_id, created_at DESC);

-- 用量统计：速率限制与 token 配额的计数来源。
CREATE TABLE IF NOT EXISTS team_model_policy_usage (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES team_users(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  hour_bucket TIMESTAMPTZ NOT NULL,
  day_bucket DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 唯一索引带上 team_id，避免跨团队互相覆盖计数。
CREATE UNIQUE INDEX IF NOT EXISTS team_model_policy_usage_bucket
  ON team_model_policy_usage(team_id, user_id, model, hour_bucket);
CREATE INDEX IF NOT EXISTS team_model_policy_usage_team_hour
  ON team_model_policy_usage(team_id, hour_bucket);
CREATE INDEX IF NOT EXISTS team_model_policy_usage_user_day
  ON team_model_policy_usage(team_id, user_id, day_bucket);
