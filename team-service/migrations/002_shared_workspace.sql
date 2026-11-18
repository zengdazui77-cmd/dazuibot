CREATE TABLE IF NOT EXISTS team_bots (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
  instructions TEXT NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 12000),
  created_by TEXT NOT NULL REFERENCES team_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(team_id, id)
);
CREATE INDEX IF NOT EXISTS team_bots_team ON team_bots(team_id, created_at, id);

CREATE TABLE IF NOT EXISTS team_conversations (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  visibility TEXT NOT NULL CHECK (visibility IN ('team', 'private')),
  created_by TEXT NOT NULL REFERENCES team_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(team_id, bot_id) REFERENCES team_bots(team_id, id) ON DELETE CASCADE,
  UNIQUE(team_id, id)
);
CREATE INDEX IF NOT EXISTS team_conversations_team_recent ON team_conversations(team_id, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS team_conversations_bot ON team_conversations(team_id, bot_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS team_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES team_conversations(id) ON DELETE CASCADE,
  author_user_id TEXT REFERENCES team_users(id) ON DELETE SET NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 20000),
  sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_messages_conversation_recent ON team_messages(conversation_id, sequence);

CREATE TABLE IF NOT EXISTS team_model_credentials (
  team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  model TEXT NOT NULL CHECK (char_length(model) BETWEEN 1 AND 120),
  encrypted_api_key TEXT NOT NULL,
  key_tail TEXT NOT NULL CHECK (char_length(key_tail) BETWEEN 1 AND 4),
  updated_by TEXT NOT NULL REFERENCES team_users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_jobs (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  user_message_id TEXT NOT NULL REFERENCES team_messages(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES team_users(id),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')) DEFAULT 'queued',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  error_code TEXT,
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(team_id, conversation_id) REFERENCES team_conversations(team_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS team_jobs_queue ON team_jobs(status, available_at, created_at, id);
CREATE INDEX IF NOT EXISTS team_jobs_conversation_recent ON team_jobs(conversation_id, created_at, id);
