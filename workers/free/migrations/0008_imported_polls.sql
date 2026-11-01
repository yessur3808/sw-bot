-- Apply once, before importing poll datasets. Existing posts remain unchanged.
ALTER TABLE admin_posts ADD COLUMN import_key TEXT;
ALTER TABLE admin_posts ADD COLUMN import_metadata TEXT;
CREATE UNIQUE INDEX admin_posts_import_key ON admin_posts(import_key);
