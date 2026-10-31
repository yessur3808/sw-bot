-- Legacy excerpts have unknown spoiler formatting: exclude them by default.
ALTER TABLE club_messages ADD COLUMN recap_safe INTEGER NOT NULL DEFAULT 0;
ALTER TABLE club_games ADD COLUMN last_step_at INTEGER;
-- A null message_id means the first round has never been confirmed delivered.
UPDATE club_games SET step=-1 WHERE message_id IS NULL AND state='open';
-- Existing delivered games wait a full interval from migration before advancing.
UPDATE club_games SET last_step_at=unixepoch() WHERE message_id IS NOT NULL AND state='open';
