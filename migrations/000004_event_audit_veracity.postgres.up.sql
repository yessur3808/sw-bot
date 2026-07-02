ALTER TABLE events ADD COLUMN IF NOT EXISTS source_veracity TEXT NOT NULL DEFAULT 'rumor';

CREATE TABLE IF NOT EXISTS event_crawl_audit (
    id BIGSERIAL PRIMARY KEY,
    run_type TEXT NOT NULL,
    source_name TEXT NOT NULL,
    source_url TEXT NOT NULL,
    source_tier TEXT NOT NULL,
    parser_strategy TEXT,
    status TEXT NOT NULL,
    extraction_health TEXT,
    extraction_ratio REAL,
    fetched_count INTEGER NOT NULL DEFAULT 0,
    saved_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS event_scrape_audit (
    id BIGSERIAL PRIMARY KEY,
    run_type TEXT NOT NULL,
    source_name TEXT NOT NULL,
    source_url TEXT NOT NULL,
    source_tier TEXT NOT NULL,
    parser_strategy TEXT,
    status TEXT NOT NULL,
    extraction_health TEXT,
    extraction_ratio REAL,
    fetched_count INTEGER NOT NULL DEFAULT 0,
    saved_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_events_source_veracity ON events(source_veracity);
CREATE INDEX IF NOT EXISTS idx_event_crawl_audit_created ON event_crawl_audit(created_at);
CREATE INDEX IF NOT EXISTS idx_event_scrape_audit_created ON event_scrape_audit(created_at);
