CREATE TABLE IF NOT EXISTS team_git_credentials (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
  encrypted_token TEXT NOT NULL,
  key_tail TEXT NOT NULL CHECK (char_length(key_tail) <= 4),
  updated_by TEXT NOT NULL REFERENCES team_users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(team_id, provider)
);
