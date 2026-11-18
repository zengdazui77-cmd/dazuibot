CREATE INDEX IF NOT EXISTS team_email_challenges_created ON team_email_challenges(created_at);
CREATE INDEX IF NOT EXISTS team_sessions_expiry ON team_sessions(expires_at);
