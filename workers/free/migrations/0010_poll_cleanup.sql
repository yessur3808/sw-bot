CREATE TABLE IF NOT EXISTS poll_cleanup (
 poll_id TEXT PRIMARY KEY,
 chat_id INTEGER NOT NULL,
 message_id INTEGER NOT NULL,
 options TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 closes_at INTEGER NOT NULL,
 final_votes INTEGER,
 had_votes INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'pending',
 next_attempt_at INTEGER NOT NULL DEFAULT 0,
 last_error TEXT
);
CREATE INDEX IF NOT EXISTS poll_cleanup_due ON poll_cleanup(state,next_attempt_at,closes_at);
