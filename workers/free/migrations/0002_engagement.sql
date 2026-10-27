-- Additive migration. No changes to existing members, privacy preferences or queue.
CREATE TABLE IF NOT EXISTS engagement_posts (
 update_id INTEGER PRIMARY KEY,
 kind TEXT NOT NULL,
 seed TEXT NOT NULL,
 text TEXT NOT NULL,
 payload TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 message_id INTEGER,
 state TEXT NOT NULL DEFAULT 'reserved'
);
CREATE INDEX IF NOT EXISTS engagement_posts_created ON engagement_posts(created_at);
CREATE INDEX IF NOT EXISTS context_scope_time ON context(chat_id,thread_id,created_at);
CREATE INDEX IF NOT EXISTS quota_kind_time ON quota(kind,created_at);
