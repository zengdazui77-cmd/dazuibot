CREATE TABLE IF NOT EXISTS team_code_tasks (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES team_projects(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES team_users(id),
  branch TEXT NOT NULL CHECK (char_length(branch) BETWEEN 1 AND 120),
  instructions TEXT NOT NULL CHECK (char_length(instructions) BETWEEN 1 AND 20000),
  status TEXT NOT NULL CHECK (status IN ('pending_approval', 'approved_waiting_executor', 'rejected', 'cancelled')) DEFAULT 'pending_approval',
  decision_reason TEXT,
  decided_by TEXT REFERENCES team_users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(team_id, project_id) REFERENCES team_projects(team_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS team_code_tasks_team_recent ON team_code_tasks(team_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS team_code_tasks_project_recent ON team_code_tasks(project_id, created_at DESC, id);
