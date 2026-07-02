DROP INDEX IF EXISTS idx_events_dedupe_key;
DROP INDEX IF EXISTS idx_events_canonical_url;
DROP INDEX IF EXISTS idx_events_status_region_date;

ALTER TABLE events DROP COLUMN IF EXISTS source_meta;
ALTER TABLE events DROP COLUMN IF EXISTS raw_event_type;
ALTER TABLE events DROP COLUMN IF EXISTS language;
ALTER TABLE events DROP COLUMN IF EXISTS location_text;
ALTER TABLE events DROP COLUMN IF EXISTS dedupe_key;
ALTER TABLE events DROP COLUMN IF EXISTS canonical_url;
