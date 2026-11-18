CREATE TABLE IF NOT EXISTS team_projects (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
  repository_url TEXT NOT NULL CHECK (char_length(repository_url) BETWEEN 1 AND 500),
  clone_url TEXT NOT NULL CHECK (char_length(clone_url) BETWEEN 1 AND 500),
  default_branch TEXT NOT NULL CHECK (char_length(default_branch) BETWEEN 1 AND 120),
  created_by TEXT NOT NULL REFERENCES team_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(team_id, id),
  UNIQUE(team_id, clone_url)
);
CREATE INDEX IF NOT EXISTS team_projects_team_recent ON team_projects(team_id, created_at DESC, id);
