CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    user_id   BIGINT PRIMARY KEY,
    username  TEXT,
    xp        INTEGER DEFAULT 0,
    weekly_xp INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS posted (
    content_type TEXT,
    content_id   TEXT,
    PRIMARY KEY (content_type, content_id)
);

CREATE TABLE IF NOT EXISTS events (
    id BIGSERIAL PRIMARY KEY,
    item_key TEXT UNIQUE,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    source_name TEXT NOT NULL,
    source_tier TEXT NOT NULL,
    region TEXT NOT NULL,
    category TEXT NOT NULL,
    event_date TEXT,
    confidence REAL NOT NULL,
    status TEXT NOT NULL,
    auto_publish_allowed INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
    id BIGSERIAL PRIMARY KEY,
    run_type TEXT NOT NULL,
    source_name TEXT NOT NULL,
    source_url TEXT NOT NULL,
    status TEXT NOT NULL,
    fetched_count INTEGER NOT NULL DEFAULT 0,
    saved_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
