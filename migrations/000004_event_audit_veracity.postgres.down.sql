DROP INDEX IF EXISTS idx_event_scrape_audit_created;
DROP INDEX IF EXISTS idx_event_crawl_audit_created;
DROP INDEX IF EXISTS idx_events_source_veracity;

DROP TABLE IF EXISTS event_scrape_audit;
DROP TABLE IF EXISTS event_crawl_audit;

ALTER TABLE events DROP COLUMN IF EXISTS source_veracity;
