import os
import sqlite3
import hashlib
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone

try:
    import psycopg
    from psycopg.rows import dict_row
except Exception:  # pragma: no cover - optional dependency
    psycopg = None
    dict_row = None

DB_PATH = "starwars.db"
DB_BACKEND = os.getenv("DB_BACKEND", "sqlite").strip().lower()
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()


def _use_postgres():
    return DB_BACKEND in ("postgres", "postgresql") and bool(DATABASE_URL) and psycopg is not None


def _adapt_query(query):
    if not _use_postgres():
        return query
    # sqlite uses ?, psycopg uses %s
    return query.replace("?", "%s")


def _execute(conn, query, args=()):
    return conn.execute(_adapt_query(query), args)


def _fetchall(cur):
    rows = cur.fetchall()
    if _use_postgres():
        return rows
    return rows


def _fetchone(cur):
    row = cur.fetchone()
    return row

@contextmanager
def get_db():
    if _use_postgres():
        conn = psycopg.connect(DATABASE_URL, row_factory=dict_row)
    else:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()

def init_db():
    with get_db() as conn:
        if _use_postgres():
            _execute(conn, """
            CREATE TABLE IF NOT EXISTS users (
                user_id   BIGINT PRIMARY KEY,
                username  TEXT,
                xp        INTEGER DEFAULT 0,
                weekly_xp INTEGER DEFAULT 0
            );
            """)
            _execute(conn, """
            CREATE TABLE IF NOT EXISTS posted (
                content_type TEXT,
                content_id   TEXT,
                PRIMARY KEY (content_type, content_id)
            );
            """)
            _execute(conn, """
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
            );
            """)
            _execute(conn, """
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
            );
            """)
            _execute(conn, """
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
            );
            """)
            return

        conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            user_id   INTEGER PRIMARY KEY,
            username  TEXT,
            xp        INTEGER DEFAULT 0,
            weekly_xp INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS posted (
            content_type TEXT,
            content_id   TEXT,
            PRIMARY KEY (content_type, content_id)
        );
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
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
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS ingestion_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_type TEXT NOT NULL,
            source_name TEXT NOT NULL,
            source_url TEXT NOT NULL,
            status TEXT NOT NULL,
            fetched_count INTEGER NOT NULL DEFAULT 0,
            saved_count INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS post_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            posted_at TEXT DEFAULT CURRENT_TIMESTAMP,
            topic TEXT,
            thread_id INTEGER,
            telegram_message_id INTEGER,
            content_type TEXT,
            content_id TEXT,
            text_hash TEXT,
            status TEXT NOT NULL DEFAULT 'sent'
        );
        """)


def compute_text_hash(text):
    payload = (text or "").encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def log_post_audit(topic, thread_id, telegram_message_id, content_type, content_id, text, status="sent"):
    with get_db() as conn:
        _execute(
            conn,
            """
            INSERT INTO post_audit (
                topic, thread_id, telegram_message_id,
                content_type, content_id, text_hash, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                topic,
                thread_id,
                telegram_message_id,
                content_type,
                content_id,
                compute_text_hash(text),
                status,
            ),
        )


def _coerce_posted_at(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        raw = str(value).strip()
        if not raw:
            return None
        raw = raw.replace(" ", "T")
        try:
            dt = datetime.fromisoformat(raw)
        except Exception:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def has_recent_post(hours=4):
    with get_db() as conn:
        row = _fetchone(_execute(conn, "SELECT posted_at FROM post_audit ORDER BY posted_at DESC LIMIT 1"))
    if not row:
        return False

    posted_at = row.get("posted_at") if hasattr(row, "get") else row[0]
    dt = _coerce_posted_at(posted_at)
    if not dt:
        return False
    window = timedelta(hours=max(0.0, float(hours)))
    return dt >= (datetime.now(timezone.utc) - window)


def upsert_event_item(item):
    with get_db() as conn:
        _execute(
            conn,
            """
            INSERT INTO events (
                item_key, title, url, source_name, source_tier, region, category,
                event_date, confidence, status, auto_publish_allowed, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(item_key) DO UPDATE SET
                title=excluded.title,
                url=excluded.url,
                source_name=excluded.source_name,
                source_tier=excluded.source_tier,
                region=excluded.region,
                category=excluded.category,
                event_date=excluded.event_date,
                confidence=excluded.confidence,
                status=excluded.status,
                auto_publish_allowed=excluded.auto_publish_allowed,
                updated_at=CURRENT_TIMESTAMP
            """,
            (
                item["item_key"],
                item["title"],
                item["url"],
                item["source_name"],
                item["source_tier"],
                item["region"],
                item["category"],
                item.get("event_date"),
                item["confidence"],
                item["status"],
                1 if item.get("auto_publish_allowed") else 0,
            ),
        )


def log_ingestion_run(run_type, source_name, source_url, status, fetched_count, saved_count, error=None):
    with get_db() as conn:
        _execute(
            conn,
            """
            INSERT INTO ingestion_runs (
                run_type, source_name, source_url, status, fetched_count, saved_count, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (run_type, source_name, source_url, status, fetched_count, saved_count, error),
        )


def list_events_by_status(status, limit=10, region=None):
    query = "SELECT * FROM events WHERE status=?"
    args = [status]
    if region:
        query += " AND region=?"
        args.append(region)
    query += " ORDER BY confidence DESC, created_at DESC LIMIT ?"
    args.append(limit)
    with get_db() as conn:
        return _fetchall(_execute(conn, query, tuple(args)))


def get_event_by_id(event_id):
    with get_db() as conn:
        return _fetchone(_execute(conn, "SELECT * FROM events WHERE id=?", (event_id,)))


def set_event_status(event_id, status):
    with get_db() as conn:
        _execute(
            conn,
            "UPDATE events SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
            (status, event_id),
        )


def list_unpublished_auto(limit=20):
    with get_db() as conn:
        return _fetchall(_execute(
            conn,
            """
            SELECT * FROM events
            WHERE status='approved' AND auto_publish_allowed=1
            AND NOT EXISTS (
                SELECT 1 FROM posted p
                WHERE p.content_type='event' AND p.content_id=events.item_key
            )
            ORDER BY confidence DESC, created_at ASC
            LIMIT ?
            """,
            (limit,),
        ))


def latest_ingestion_runs(limit=20):
    with get_db() as conn:
        return _fetchall(_execute(
            conn,
            """
            SELECT id, run_type, source_name, source_url, status,
                   fetched_count, saved_count, error, created_at
            FROM ingestion_runs
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ))


def latest_ingestion_run_per_source(limit=20):
    with get_db() as conn:
        return _fetchall(_execute(
            conn,
            """
            SELECT ir.*
            FROM ingestion_runs ir
            JOIN (
                SELECT run_type, source_name, MAX(id) AS max_id
                FROM ingestion_runs
                GROUP BY run_type, source_name
            ) last
              ON ir.id = last.max_id
            ORDER BY ir.created_at DESC
            LIMIT ?
            """,
            (limit,),
        ))


def list_approved_events(limit=10, region=None, categories=None, days=None, offset=0):
    query = "SELECT * FROM events WHERE status='approved'"
    args = []
    if region and region != "all":
        query += " AND region=?"
        args.append(region)
    if categories:
        placeholders = ",".join(["?"] * len(categories))
        query += f" AND category IN ({placeholders})"
        args.extend(categories)
    if days is not None:
        # Keep DB filter simple and backend-neutral using ISO dates.
        max_date = (date.today() + timedelta(days=max(1, int(days)))).isoformat()
        query += " AND event_date IS NOT NULL AND event_date <= ?"
        args.append(max_date)
    query += " ORDER BY event_date ASC, confidence DESC LIMIT ?"
    args.append(limit)
    if offset > 0:
        query += " OFFSET ?"
        args.append(offset)

    with get_db() as conn:
        return _fetchall(_execute(conn, query, tuple(args)))


def list_upcoming_releases(limit=10, region=None, days=180, offset=0):
    rows = list_approved_events(
        limit=max(200, (offset + limit) * 5),
        region=region,
        categories=("game", "tv", "movie"),
        days=days,
    )

    today = date.today()
    max_date = today + timedelta(days=max(1, days))
    out = []
    for row in rows:
        raw_date = row.get("event_date") if hasattr(row, "get") else row["event_date"]
        if not raw_date:
            continue
        try:
            parsed = date.fromisoformat(str(raw_date))
        except Exception:
            continue
        if today <= parsed <= max_date:
            out.append(row)
        if len(out) >= (offset + limit):
            break
    return out[offset:offset + limit]

def add_xp(user_id, username, amount):
    with get_db() as conn:
        if _use_postgres():
            _execute(conn, """
                INSERT INTO users (user_id, username, xp, weekly_xp)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    xp = users.xp + EXCLUDED.xp,
                    weekly_xp = users.weekly_xp + EXCLUDED.weekly_xp,
                    username = EXCLUDED.username
            """, (user_id, username, amount, amount))
        else:
            _execute(conn, """
                INSERT INTO users (user_id, username, xp, weekly_xp)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    xp = xp + excluded.xp,
                    weekly_xp = weekly_xp + excluded.weekly_xp,
                    username = excluded.username
            """, (user_id, username, amount, amount))

def get_user(user_id):
    with get_db() as conn:
        return _fetchone(_execute(conn, "SELECT * FROM users WHERE user_id = ?", (user_id,)))

def top_users(limit=10, weekly=False):
    col = "weekly_xp" if weekly else "xp"
    with get_db() as conn:
        return _fetchall(_execute(
            conn,
            f"SELECT username, {col} AS score FROM users "
            f"ORDER BY {col} DESC LIMIT ?", (limit,)
        ))

def reset_weekly():
    with get_db() as conn:
        _execute(conn, "UPDATE users SET weekly_xp = 0")

# Prevents reposting the same meme/wallpaper twice
def already_posted(content_type, content_id):
    with get_db() as conn:
        row = _fetchone(_execute(
            conn,
            "SELECT 1 FROM posted WHERE content_type=? AND content_id=?",
            (content_type, content_id)
        ))
        if row:
            return True
        _execute(conn,
            "INSERT INTO posted VALUES (?, ?)", (content_type, content_id)
        )
        return False