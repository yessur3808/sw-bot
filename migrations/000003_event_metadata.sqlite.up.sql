ALTER TABLE events ADD COLUMN canonical_url TEXT;
ALTER TABLE events ADD COLUMN dedupe_key TEXT;
ALTER TABLE events ADD COLUMN location_text TEXT;
ALTER TABLE events ADD COLUMN language TEXT;
ALTER TABLE events ADD COLUMN raw_event_type TEXT;
ALTER TABLE events ADD COLUMN source_meta TEXT;

CREATE INDEX IF NOT EXISTS idx_events_status_region_date ON events(status, region, event_date);
CREATE INDEX IF NOT EXISTS idx_events_canonical_url ON events(canonical_url);
CREATE INDEX IF NOT EXISTS idx_events_dedupe_key ON events(dedupe_key);
