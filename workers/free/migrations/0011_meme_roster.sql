CREATE TABLE IF NOT EXISTS meme_roster (
 id TEXT PRIMARY KEY,
 image_url TEXT NOT NULL,
 source_url TEXT NOT NULL,
 author TEXT NOT NULL,
 sha256 TEXT NOT NULL UNIQUE,
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 last_selected INTEGER NOT NULL DEFAULT 0,
 last_sent_at INTEGER,
 file_id TEXT
);
CREATE TABLE IF NOT EXISTS meme_deliveries (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 update_id INTEGER NOT NULL UNIQUE,
 meme_id TEXT NOT NULL REFERENCES meme_roster(id),
 created_at INTEGER NOT NULL,
 message_id INTEGER
);
CREATE INDEX IF NOT EXISTS meme_rotation ON meme_roster(active,last_selected);
