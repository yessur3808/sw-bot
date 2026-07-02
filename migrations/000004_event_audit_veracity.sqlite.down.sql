DROP INDEX IF EXISTS idx_event_scrape_audit_created;
DROP INDEX IF EXISTS idx_event_crawl_audit_created;
DROP INDEX IF EXISTS idx_events_source_veracity;

DROP TABLE IF EXISTS event_scrape_audit;
DROP TABLE IF EXISTS event_crawl_audit;

CREATE TABLE IF NOT EXISTS events_backup_000004 AS
SELECT
    id,
    item_key,
    title,
    url,
    canonical_url,
    dedupe_key,
    source_name,
    source_tier,
    region,
    category,
    event_date,
    location_text,
    language,
    raw_event_type,
    source_meta,
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
    canonical_url TEXT,
    dedupe_key TEXT,
    source_name TEXT NOT NULL,
    source_tier TEXT NOT NULL,
    region TEXT NOT NULL,
    category TEXT NOT NULL,
    event_date TEXT,
    location_text TEXT,
    language TEXT,
    raw_event_type TEXT,
    source_meta TEXT,
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
    canonical_url,
    dedupe_key,
    source_name,
    source_tier,
    region,
    category,
    event_date,
    location_text,
    language,
    raw_event_type,
    source_meta,
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
    canonical_url,
    dedupe_key,
    source_name,
    source_tier,
    region,
    category,
    event_date,
    location_text,
    language,
    raw_event_type,
    source_meta,
    confidence,
    status,
    auto_publish_allowed,
    created_at,
    updated_at
FROM events_backup_000004;

DROP TABLE IF EXISTS events_backup_000004;
