ALTER TABLE team_code_tasks
  ADD COLUMN IF NOT EXISTS executor_heartbeat_seq BIGINT NOT NULL DEFAULT 0
  CHECK (executor_heartbeat_seq >= 0);

-- Tasks left in running by an older dispatcher have no execution lease and cannot be monitored safely.
UPDATE team_code_tasks
   SET status='failed', executor_error='executor_lease_missing', executor_finished_at=now(), updated_at=now()
 WHERE status='running' AND executor_lease_until IS NULL;
