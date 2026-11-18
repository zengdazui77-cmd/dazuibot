ALTER TABLE team_code_tasks
  ADD COLUMN IF NOT EXISTS executor_capability_hash TEXT,
  ADD COLUMN IF NOT EXISTS executor_capability_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS executor_model_requests INTEGER NOT NULL DEFAULT 0;

ALTER TABLE team_code_tasks
  ADD CONSTRAINT team_code_tasks_executor_capability_pair
  CHECK ((executor_capability_hash IS NULL) = (executor_capability_encrypted IS NULL));

ALTER TABLE team_code_tasks
  ADD CONSTRAINT team_code_tasks_executor_model_requests_check
  CHECK (executor_model_requests BETWEEN 0 AND 200);
