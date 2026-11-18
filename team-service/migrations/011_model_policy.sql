-- 团队模型授权策略：创建者决定成员可用模型的范围（全部 / 部署模型 / 指定模型），成员在范围内自主选择。
CREATE TABLE IF NOT EXISTS team_model_policies (
  team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'all' CHECK (mode IN ('all', 'catalog', 'allowlist')),
  allowed_models TEXT[] NOT NULL DEFAULT '{}',
  updated_by TEXT REFERENCES team_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_member_models (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES team_users(id) ON DELETE CASCADE,
  model TEXT NOT NULL CHECK (char_length(model) BETWEEN 1 AND 120),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS team_member_models_team ON team_member_models(team_id);

-- 代码任务在投递时固化本任务实际使用的模型（成员在授权范围内的选择），执行器据此调用。
ALTER TABLE team_code_tasks ADD COLUMN IF NOT EXISTS executor_model TEXT;
