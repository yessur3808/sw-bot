CREATE TABLE IF NOT EXISTS post_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    posted_at TEXT DEFAULT CURRENT_TIMESTAMP,
    topic TEXT,
    thread_id INTEGER,
    telegram_message_id INTEGER,
    content_type TEXT,
    content_id TEXT,
    text_hash TEXT,
    status TEXT NOT NULL DEFAULT 'sent'
);
