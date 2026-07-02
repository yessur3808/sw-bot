"""One-time migration utility: SQLite -> Postgres.

Usage:
  DATABASE_URL='postgresql://user:pass@host/db' python3 scripts/db/migrate_sqlite_to_postgres.py

Optional env vars:
  SQLITE_PATH=starwars.db
  PG_SSLMODE=require
"""

import os
import sqlite3

import psycopg


SQLITE_PATH = os.getenv("SQLITE_PATH", "starwars.db")
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
PG_SSLMODE = os.getenv("PG_SSLMODE", "prefer")


def ensure_postgres_schema(pg_conn):
    with pg_conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                user_id   BIGINT PRIMARY KEY,
                username  TEXT,
                xp        INTEGER DEFAULT 0,
                weekly_xp INTEGER DEFAULT 0
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS posted (
                content_type TEXT,
                content_id   TEXT,
                PRIMARY KEY (content_type, content_id)
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS events (
                id BIGSERIAL PRIMARY KEY,
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS ingestion_runs (
                id BIGSERIAL PRIMARY KEY,
                run_type TEXT NOT NULL,
                source_name TEXT NOT NULL,
                source_url TEXT NOT NULL,
                status TEXT NOT NULL,
                fetched_count INTEGER NOT NULL DEFAULT 0,
                saved_count INTEGER NOT NULL DEFAULT 0,
                error TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS post_audit (
                id BIGSERIAL PRIMARY KEY,
                posted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                topic TEXT,
                thread_id BIGINT,
                telegram_message_id BIGINT,
                content_type TEXT,
                content_id TEXT,
                text_hash TEXT,
                status TEXT NOT NULL DEFAULT 'sent'
            )
            """
        )
    pg_conn.commit()


def migrate_users(sqlite_conn, pg_conn):
    rows = sqlite_conn.execute("SELECT user_id, username, xp, weekly_xp FROM users").fetchall()
    with pg_conn.cursor() as cur:
        for r in rows:
            cur.execute(
                """
                INSERT INTO users (user_id, username, xp, weekly_xp)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT(user_id) DO UPDATE SET
                    username = EXCLUDED.username,
                    xp = EXCLUDED.xp,
                    weekly_xp = EXCLUDED.weekly_xp
                """,
                (r[0], r[1], r[2], r[3]),
            )
    pg_conn.commit()
    return len(rows)


def migrate_posted(sqlite_conn, pg_conn):
    rows = sqlite_conn.execute("SELECT content_type, content_id FROM posted").fetchall()
    with pg_conn.cursor() as cur:
        for r in rows:
            cur.execute(
                """
                INSERT INTO posted (content_type, content_id)
                VALUES (%s, %s)
                ON CONFLICT(content_type, content_id) DO NOTHING
                """,
                (r[0], r[1]),
            )
    pg_conn.commit()
    return len(rows)


def migrate_events(sqlite_conn, pg_conn):
    rows = sqlite_conn.execute(
        """
        SELECT item_key, title, url, source_name, source_tier, region, category,
               event_date, confidence, status, auto_publish_allowed, created_at, updated_at
        FROM events
        """
    ).fetchall()
    with pg_conn.cursor() as cur:
        for r in rows:
            cur.execute(
                """
                INSERT INTO events (
                    item_key, title, url, source_name, source_tier, region, category,
                    event_date, confidence, status, auto_publish_allowed, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT(item_key) DO UPDATE SET
                    title = EXCLUDED.title,
                    url = EXCLUDED.url,
                    source_name = EXCLUDED.source_name,
                    source_tier = EXCLUDED.source_tier,
                    region = EXCLUDED.region,
                    category = EXCLUDED.category,
                    event_date = EXCLUDED.event_date,
                    confidence = EXCLUDED.confidence,
                    status = EXCLUDED.status,
                    auto_publish_allowed = EXCLUDED.auto_publish_allowed,
                    updated_at = EXCLUDED.updated_at
                """,
                (
                    r[0],
                    r[1],
                    r[2],
                    r[3],
                    r[4],
                    r[5],
                    r[6],
                    r[7],
                    r[8],
                    r[9],
                    int(r[10] or 0),
                    r[11],
                    r[12],
                ),
            )
    pg_conn.commit()
    return len(rows)


def migrate_ingestion_runs(sqlite_conn, pg_conn):
    rows = sqlite_conn.execute(
        """
        SELECT run_type, source_name, source_url, status,
               fetched_count, saved_count, error, created_at
        FROM ingestion_runs
        """
    ).fetchall()
    with pg_conn.cursor() as cur:
        for r in rows:
            cur.execute(
                """
                INSERT INTO ingestion_runs (
                    run_type, source_name, source_url, status,
                    fetched_count, saved_count, error, created_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7]),
            )
    pg_conn.commit()
    return len(rows)


def migrate_post_audit(sqlite_conn, pg_conn):
    exists = sqlite_conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='post_audit'"
    ).fetchone()
    if not exists:
        return 0

    rows = sqlite_conn.execute(
        """
        SELECT posted_at, topic, thread_id, telegram_message_id,
               content_type, content_id, text_hash, status
        FROM post_audit
        """
    ).fetchall()
    with pg_conn.cursor() as cur:
        for r in rows:
            cur.execute(
                """
                INSERT INTO post_audit (
                    posted_at, topic, thread_id, telegram_message_id,
                    content_type, content_id, text_hash, status
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7]),
            )
    pg_conn.commit()
    return len(rows)


def main():
    if not DATABASE_URL:
        raise SystemExit("DATABASE_URL is required")

    sqlite_conn = sqlite3.connect(SQLITE_PATH)
    pg_conn = psycopg.connect(DATABASE_URL, sslmode=PG_SSLMODE)

    try:
        ensure_postgres_schema(pg_conn)

        users_n = migrate_users(sqlite_conn, pg_conn)
        posted_n = migrate_posted(sqlite_conn, pg_conn)
        events_n = migrate_events(sqlite_conn, pg_conn)
        runs_n = migrate_ingestion_runs(sqlite_conn, pg_conn)
        audit_n = migrate_post_audit(sqlite_conn, pg_conn)

        print("Migration completed")
        print(f"users: {users_n}")
        print(f"posted: {posted_n}")
        print(f"events: {events_n}")
        print(f"ingestion_runs: {runs_n}")
        print(f"post_audit: {audit_n}")
    finally:
        sqlite_conn.close()
        pg_conn.close()


if __name__ == "__main__":
    main()
