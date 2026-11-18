ALTER TABLE team_jobs ADD COLUMN IF NOT EXISTS model_name TEXT;
ALTER TABLE team_jobs ADD COLUMN IF NOT EXISTS prompt_tokens BIGINT CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0);
ALTER TABLE team_jobs ADD COLUMN IF NOT EXISTS completion_tokens BIGINT CHECK (completion_tokens IS NULL OR completion_tokens >= 0);
CREATE INDEX IF NOT EXISTS team_jobs_usage_recent ON team_jobs(team_id, created_by, created_at DESC) WHERE status='succeeded';
