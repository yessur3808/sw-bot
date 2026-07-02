DROP INDEX IF EXISTS idx_events_dedupe_key;
DROP INDEX IF EXISTS idx_events_canonical_url;
DROP INDEX IF EXISTS idx_events_status_region_date;

CREATE TABLE IF NOT EXISTS events_backup_000003 AS
SELECT
    id,
    item_key,
    title,
    url,
    source_name,
    source_tier,
    region,
    category,
    event_date,
    confidence,
    status,
    auto_publish_allowed,
    created_at,
    updated_at
FROM events;

DROP TABLE IF EXISTS events;

CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO events (
    id,
    item_key,
    title,
    url,
    source_name,
    source_tier,
    region,
    category,
    event_date,
    confidence,
    status,
    auto_publish_allowed,
    created_at,
    updated_at
)
SELECT
    id,
    item_key,
    title,
    url,
    source_name,
    source_tier,
    region,
    category,
    event_date,
    confidence,
    status,
    auto_publish_allowed,
    created_at,
    updated_at
FROM events_backup_000003;

DROP TABLE IF EXISTS events_backup_000003;
