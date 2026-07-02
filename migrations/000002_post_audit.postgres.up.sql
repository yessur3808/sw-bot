CREATE TABLE IF NOT EXISTS post_audit (
    id BIGSERIAL PRIMARY KEY,
    posted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    topic TEXT,
    thread_id BIGINT,
    telegram_message_id BIGINT,
    content_type TEXT,
    content_id TEXT,
    text_hash TEXT,
    status TEXT NOT NULL DEFAULT 'sent'
);
