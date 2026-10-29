CREATE TABLE IF NOT EXISTS youtube_videos (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 video_id TEXT NOT NULL UNIQUE,
 channel_id TEXT NOT NULL,
 title TEXT NOT NULL,
 topic TEXT,
 published_at INTEGER NOT NULL DEFAULT 0,
 duration INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL,
 reason TEXT,
 discovered_at INTEGER NOT NULL,
 attempted_at INTEGER,
 ready_at INTEGER NOT NULL DEFAULT 0,
 message_id INTEGER,
 thread_id INTEGER,
 sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS youtube_pending ON youtube_videos(state,ready_at);
