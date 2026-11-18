ALTER TABLE team_code_tasks DROP CONSTRAINT IF EXISTS team_code_tasks_status_check;
ALTER TABLE team_code_tasks ADD CONSTRAINT team_code_tasks_status_check
  CHECK (status IN ('pending_approval', 'approved_waiting_executor', 'dispatching', 'running', 'succeeded', 'failed', 'rejected', 'cancelled'));
ALTER TABLE team_code_tasks ADD COLUMN IF NOT EXISTS executor_job_id TEXT UNIQUE;
ALTER TABLE team_code_tasks ADD COLUMN IF NOT EXISTS executor_attempts INTEGER NOT NULL DEFAULT 0 CHECK (executor_attempts >= 0 AND executor_attempts <= 3);
ALTER TABLE team_code_tasks ADD COLUMN IF NOT EXISTS executor_lease_until TIMESTAMPTZ;
ALTER TABLE team_code_tasks ADD COLUMN IF NOT EXISTS executor_started_at TIMESTAMPTZ;
ALTER TABLE team_code_tasks ADD COLUMN IF NOT EXISTS executor_finished_at TIMESTAMPTZ;
ALTER TABLE team_code_tasks ADD COLUMN IF NOT EXISTS executor_result TEXT;
ALTER TABLE team_code_tasks ADD COLUMN IF NOT EXISTS executor_error TEXT;
CREATE INDEX IF NOT EXISTS team_code_tasks_executor_queue ON team_code_tasks(status, updated_at, id);
