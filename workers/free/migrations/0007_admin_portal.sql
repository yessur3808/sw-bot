CREATE TABLE IF NOT EXISTS admin_sessions (
 token_hash TEXT PRIMARY KEY, code_hash TEXT UNIQUE, user_id INTEGER,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_sessions_expiry ON admin_sessions(expires_at);
CREATE TABLE IF NOT EXISTS admin_limits (key TEXT PRIMARY KEY,hits INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS admin_actions (
 id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,action TEXT NOT NULL,
 target_id INTEGER,created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_posts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,text TEXT NOT NULL,options TEXT NOT NULL DEFAULT '[]',
 correct INTEGER,thread_id INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'draft',
 revision INTEGER NOT NULL DEFAULT 1,approved_revision INTEGER,approved_by INTEGER,
 created_by INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 scheduled_at INTEGER,job_id INTEGER,message_id INTEGER,source_update INTEGER UNIQUE
);
CREATE INDEX IF NOT EXISTS admin_posts_state ON admin_posts(state,updated_at);
