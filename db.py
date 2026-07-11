import os
import sqlite3
import hashlib
import json
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import config

SUPPORTED_THREAD_TOPICS = (
    "general",
    "memes",
    "wallpapers",
    "trivia",
    "quotes",
    "facts",
    "polls",
    "discussions",
    "events_hk",
    "events_global",
    "gaming",
    "lightsabers",
)

THREAD_TOPIC_LABELS = {
    "general": "General channel",
    "memes": "Memes",
    "wallpapers": "Wallpapers",
    "trivia": "Trivia",
    "quotes": "Quotes",
    "facts": "Facts",
    "polls": "Polls",
    "discussions": "Discussions",
    "events_hk": "Hong Kong events",
    "events_global": "Global events",
    "gaming": "Gaming",
    "lightsabers": "Lightsabers",
}

try:
    import psycopg
    from psycopg.rows import dict_row
except Exception:  # pragma: no cover - optional dependency
    psycopg = None
    dict_row = None

DB_PATH = "starwars.db"
DB_BACKEND = os.getenv("DB_BACKEND", "sqlite").strip().lower()
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
ROOT_DIR = Path(__file__).resolve().parent
DATA_DIR = ROOT_DIR / "data"


def _dataset_seed_path(dataset_name):
    clean_name = str(dataset_name or "").strip().lower()
    if not clean_name:
        return None
    return DATA_DIR / f"{clean_name}.json"


def _load_dataset_seed(dataset_name):
    path = _dataset_seed_path(dataset_name)
    if not path or not path.exists():
        return []
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except Exception:
        return []
    return payload if isinstance(payload, list) else []


def _is_missing_relation_error(exc):
    if exc is None:
        return False
    message = str(exc).lower()
    return "dataset_store" in message and ("does not exist" in message or "undefinedtable" in message or "relation" in message)


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
        conn = psycopg.connect(
            DATABASE_URL,
            row_factory=dict_row,
            prepare_threshold=None,
        )
    else:
        conn = sqlite3.connect(DB_PATH, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 30000")
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
                canonical_url TEXT,
                dedupe_key TEXT,
                source_name TEXT NOT NULL,
                source_tier TEXT NOT NULL,
                source_veracity TEXT NOT NULL DEFAULT 'rumor',
                region TEXT NOT NULL,
                category TEXT NOT NULL,
                event_date TEXT,
                location_text TEXT,
                language TEXT,
                raw_event_type TEXT,
                source_meta TEXT,
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
            """)
            _execute(conn, """
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
                post_payload TEXT,
                status TEXT NOT NULL DEFAULT 'sent'
            );
            """)
            _execute(conn, """
            CREATE TABLE IF NOT EXISTS scheduler_decisions (
                id BIGSERIAL PRIMARY KEY,
                plan_key TEXT NOT NULL,
                slot_index INTEGER NOT NULL,
                topic TEXT NOT NULL,
                score REAL NOT NULL DEFAULT 0,
                selected INTEGER NOT NULL DEFAULT 0,
                scheduled_for_date TEXT,
                run_at TIMESTAMP,
                score_factors TEXT,
                reason TEXT,
                execution_status TEXT,
                executed_at TIMESTAMP,
                execution_error TEXT,
                executed_message_id BIGINT,
                executed_content_type TEXT,
                executed_content_id TEXT,
                execution_latency_ms INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """)
            _execute(conn, """
            CREATE TABLE IF NOT EXISTS command_usage_audit (
                id BIGSERIAL PRIMARY KEY,
                command_name TEXT NOT NULL,
                status TEXT NOT NULL,
                user_id BIGINT,
                chat_id BIGINT,
                thread_id BIGINT,
                args_text TEXT,
                is_admin INTEGER NOT NULL DEFAULT 0,
                latency_ms INTEGER,
                error TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """)
            _execute(conn, """
            CREATE TABLE IF NOT EXISTS runtime_settings (
                setting_key TEXT PRIMARY KEY,
                setting_value TEXT NOT NULL,
                updated_by BIGINT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """)
            _execute(conn, """
            CREATE TABLE IF NOT EXISTS dataset_store (
                dataset_name TEXT PRIMARY KEY,
                dataset_value TEXT NOT NULL,
                updated_by BIGINT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """)
            _execute(conn, """
            CREATE TABLE IF NOT EXISTS thread_mappings (
                topic_name TEXT PRIMARY KEY,
                thread_id BIGINT,
                thread_label TEXT,
                updated_by BIGINT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """)
            _execute(conn, """
            CREATE TABLE IF NOT EXISTS source_overrides (
                id BIGSERIAL PRIMARY KEY,
                run_type TEXT NOT NULL,
                source_tier TEXT NOT NULL,
                source_kind TEXT NOT NULL,
                source_name TEXT NOT NULL,
                source_url TEXT NOT NULL,
                source_meta TEXT,
                is_enabled INTEGER NOT NULL DEFAULT 1,
                position INTEGER NOT NULL DEFAULT 0,
                updated_by BIGINT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """)
            _execute(conn, """
            CREATE TABLE IF NOT EXISTS admin_sessions (
                token TEXT PRIMARY KEY,
                user_id BIGINT NOT NULL,
                ip_address TEXT,
                user_agent TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NOT NULL,
                last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """)
            _execute(conn, """
            CREATE TABLE IF NOT EXISTS admin_audit (
                id BIGSERIAL PRIMARY KEY,
                action TEXT NOT NULL,
                actor_user_id BIGINT,
                actor_label TEXT,
                details TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """)
            _execute(conn, """
            CREATE TABLE IF NOT EXISTS admin_profiles (
                user_id BIGINT PRIMARY KEY,
                display_name TEXT,
                username TEXT,
                email TEXT,
                role TEXT NOT NULL DEFAULT 'admin',
                is_active INTEGER NOT NULL DEFAULT 1,
                is_primary INTEGER NOT NULL DEFAULT 0,
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """)
            _execute(conn, """
            CREATE TABLE IF NOT EXISTS bot_health_state (
                state_key TEXT PRIMARY KEY,
                state_value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_events_status_region_date ON events(status, region, event_date)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_events_canonical_url ON events(canonical_url)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_events_dedupe_key ON events(dedupe_key)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_events_source_veracity ON events(source_veracity)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_event_crawl_audit_created ON event_crawl_audit(created_at)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_event_scrape_audit_created ON event_scrape_audit(created_at)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_source_overrides_rt_enabled_pos ON source_overrides(run_type, is_enabled, position)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit(created_at)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_admin_profiles_active_primary ON admin_profiles(is_active, is_primary)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_bot_health_state_updated ON bot_health_state(updated_at)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_plan_slot ON scheduler_decisions(plan_key, slot_index, selected)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_created ON scheduler_decisions(created_at)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_run_at ON scheduler_decisions(run_at)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_exec_status ON scheduler_decisions(execution_status, executed_at)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_command_usage_created ON command_usage_audit(created_at)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_command_usage_name_created ON command_usage_audit(command_name, created_at)")
            _execute(conn, "ALTER TABLE scheduler_decisions ADD COLUMN IF NOT EXISTS execution_status TEXT")
            _execute(conn, "ALTER TABLE scheduler_decisions ADD COLUMN IF NOT EXISTS executed_at TIMESTAMP")
            _execute(conn, "ALTER TABLE scheduler_decisions ADD COLUMN IF NOT EXISTS execution_error TEXT")
            _execute(conn, "ALTER TABLE scheduler_decisions ADD COLUMN IF NOT EXISTS executed_message_id BIGINT")
            _execute(conn, "ALTER TABLE scheduler_decisions ADD COLUMN IF NOT EXISTS executed_content_type TEXT")
            _execute(conn, "ALTER TABLE scheduler_decisions ADD COLUMN IF NOT EXISTS executed_content_id TEXT")
            _execute(conn, "ALTER TABLE scheduler_decisions ADD COLUMN IF NOT EXISTS execution_latency_ms INTEGER")
            _execute(conn, """
            CREATE TABLE IF NOT EXISTS llm_action_audit (
                id BIGSERIAL PRIMARY KEY,
                action_type TEXT NOT NULL,
                status TEXT NOT NULL,
                reason TEXT,
                chat_id BIGINT,
                thread_id BIGINT,
                user_id BIGINT,
                source_message_id BIGINT,
                response_message_id BIGINT,
                provider TEXT,
                model TEXT,
                latency_ms INTEGER,
                prompt_chars INTEGER,
                response_chars INTEGER,
                trigger_score REAL,
                fingerprint TEXT,
                error TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_llm_action_created ON llm_action_audit(created_at)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_llm_action_thread_created ON llm_action_audit(thread_id, created_at)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_llm_action_fingerprint_created ON llm_action_audit(fingerprint, created_at)")
            _execute(conn, """
            CREATE TABLE IF NOT EXISTS reddit_ingest_cache (
                id BIGSERIAL PRIMARY KEY,
                content_type TEXT NOT NULL,
                source_id TEXT NOT NULL UNIQUE,
                dedupe_key TEXT NOT NULL UNIQUE,
                subreddit TEXT NOT NULL,
                parent_post_id TEXT,
                permalink TEXT,
                author TEXT,
                title TEXT,
                body TEXT,
                media_url TEXT,
                score INTEGER NOT NULL DEFAULT 0,
                created_utc TIMESTAMP,
                fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                relayed INTEGER NOT NULL DEFAULT 0,
                blocked INTEGER NOT NULL DEFAULT 0,
                blocked_reason TEXT,
                relay_message_id BIGINT,
                relay_thread_id BIGINT,
                relay_at TIMESTAMP
            );
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_reddit_cache_subreddit_score ON reddit_ingest_cache(subreddit, score DESC)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_reddit_cache_relayed_fetched ON reddit_ingest_cache(relayed, fetched_at DESC)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_reddit_cache_blocked_fetched ON reddit_ingest_cache(blocked, fetched_at DESC)")
            _execute(conn, """
            CREATE TABLE IF NOT EXISTS public_holidays (
                id BIGSERIAL PRIMARY KEY,
                region TEXT NOT NULL,
                holiday_date TEXT NOT NULL,
                holiday_name TEXT NOT NULL,
                source_name TEXT,
                source_url TEXT,
                source_meta TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(region, holiday_date)
            );
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_public_holidays_region_date ON public_holidays(region, holiday_date)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_public_holidays_date ON public_holidays(holiday_date)")
            _execute(conn, """
            CREATE TABLE IF NOT EXISTS dataset_ingest_candidates (
                id BIGSERIAL PRIMARY KEY,
                dataset_name TEXT NOT NULL,
                candidate_key TEXT NOT NULL UNIQUE,
                source_name TEXT NOT NULL,
                source_url TEXT NOT NULL,
                source_tier TEXT NOT NULL,
                title TEXT,
                body_text TEXT NOT NULL,
                options_json TEXT,
                answer_text TEXT,
                confidence REAL NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'candidate',
                source_meta TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """)
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_dataset_candidates_dataset_status ON dataset_ingest_candidates(dataset_name, status, created_at DESC)")
            _execute(conn, "CREATE INDEX IF NOT EXISTS idx_dataset_candidates_source ON dataset_ingest_candidates(source_name, created_at DESC)")
            _execute(conn, "ALTER TABLE reddit_ingest_cache ADD COLUMN IF NOT EXISTS blocked INTEGER NOT NULL DEFAULT 0")
            _execute(conn, "ALTER TABLE reddit_ingest_cache ADD COLUMN IF NOT EXISTS blocked_reason TEXT")
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
            canonical_url TEXT,
            dedupe_key TEXT,
            source_name TEXT NOT NULL,
            source_tier TEXT NOT NULL,
            source_veracity TEXT NOT NULL DEFAULT 'rumor',
            region TEXT NOT NULL,
            category TEXT NOT NULL,
            event_date TEXT,
            location_text TEXT,
            language TEXT,
            raw_event_type TEXT,
            source_meta TEXT,
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
        CREATE TABLE IF NOT EXISTS event_crawl_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
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
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS event_scrape_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
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
            post_payload TEXT,
            status TEXT NOT NULL DEFAULT 'sent'
        );
        CREATE TABLE IF NOT EXISTS scheduler_decisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            plan_key TEXT NOT NULL,
            slot_index INTEGER NOT NULL,
            topic TEXT NOT NULL,
            score REAL NOT NULL DEFAULT 0,
            selected INTEGER NOT NULL DEFAULT 0,
            scheduled_for_date TEXT,
            run_at TEXT,
            score_factors TEXT,
            reason TEXT,
            execution_status TEXT,
            executed_at TEXT,
            execution_error TEXT,
            executed_message_id INTEGER,
            executed_content_type TEXT,
            executed_content_id TEXT,
            execution_latency_ms INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS command_usage_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            command_name TEXT NOT NULL,
            status TEXT NOT NULL,
            user_id INTEGER,
            chat_id INTEGER,
            thread_id INTEGER,
            args_text TEXT,
            is_admin INTEGER NOT NULL DEFAULT 0,
            latency_ms INTEGER,
            error TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS runtime_settings (
            setting_key TEXT PRIMARY KEY,
            setting_value TEXT NOT NULL,
            updated_by INTEGER,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS dataset_store (
            dataset_name TEXT PRIMARY KEY,
            dataset_value TEXT NOT NULL,
            updated_by INTEGER,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS thread_mappings (
            topic_name TEXT PRIMARY KEY,
            thread_id INTEGER,
            thread_label TEXT,
            updated_by INTEGER,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS source_overrides (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_type TEXT NOT NULL,
            source_tier TEXT NOT NULL,
            source_kind TEXT NOT NULL,
            source_name TEXT NOT NULL,
            source_url TEXT NOT NULL,
            source_meta TEXT,
            is_enabled INTEGER NOT NULL DEFAULT 1,
            position INTEGER NOT NULL DEFAULT 0,
            updated_by INTEGER,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS admin_sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            ip_address TEXT,
            user_agent TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT NOT NULL,
            last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS admin_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            actor_user_id INTEGER,
            actor_label TEXT,
            details TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS admin_profiles (
            user_id INTEGER PRIMARY KEY,
            display_name TEXT,
            username TEXT,
            email TEXT,
            role TEXT NOT NULL DEFAULT 'admin',
            is_active INTEGER NOT NULL DEFAULT 1,
            is_primary INTEGER NOT NULL DEFAULT 0,
            notes TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS bot_health_state (
            state_key TEXT PRIMARY KEY,
            state_value TEXT NOT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS llm_action_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action_type TEXT NOT NULL,
            status TEXT NOT NULL,
            reason TEXT,
            chat_id INTEGER,
            thread_id INTEGER,
            user_id INTEGER,
            source_message_id INTEGER,
            response_message_id INTEGER,
            provider TEXT,
            model TEXT,
            latency_ms INTEGER,
            prompt_chars INTEGER,
            response_chars INTEGER,
            trigger_score REAL,
            fingerprint TEXT,
            error TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS reddit_ingest_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content_type TEXT NOT NULL,
            source_id TEXT NOT NULL UNIQUE,
            dedupe_key TEXT NOT NULL UNIQUE,
            subreddit TEXT NOT NULL,
            parent_post_id TEXT,
            permalink TEXT,
            author TEXT,
            title TEXT,
            body TEXT,
            media_url TEXT,
            score INTEGER NOT NULL DEFAULT 0,
            created_utc TEXT,
            fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            relayed INTEGER NOT NULL DEFAULT 0,
            blocked INTEGER NOT NULL DEFAULT 0,
            blocked_reason TEXT,
            relay_message_id INTEGER,
            relay_thread_id INTEGER,
            relay_at TEXT
        );
        CREATE TABLE IF NOT EXISTS dataset_ingest_candidates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dataset_name TEXT NOT NULL,
            candidate_key TEXT NOT NULL UNIQUE,
            source_name TEXT NOT NULL,
            source_url TEXT NOT NULL,
            source_tier TEXT NOT NULL,
            title TEXT,
            body_text TEXT NOT NULL,
            options_json TEXT,
            answer_text TEXT,
            confidence REAL NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'candidate',
            source_meta TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS public_holidays (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            region TEXT NOT NULL,
            holiday_date TEXT NOT NULL,
            holiday_name TEXT NOT NULL,
            source_name TEXT,
            source_url TEXT,
            source_meta TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(region, holiday_date)
        );
        CREATE INDEX IF NOT EXISTS idx_events_status_region_date ON events(status, region, event_date);
        CREATE INDEX IF NOT EXISTS idx_events_canonical_url ON events(canonical_url);
        CREATE INDEX IF NOT EXISTS idx_events_dedupe_key ON events(dedupe_key);
        CREATE INDEX IF NOT EXISTS idx_events_source_veracity ON events(source_veracity);
        CREATE INDEX IF NOT EXISTS idx_event_crawl_audit_created ON event_crawl_audit(created_at);
        CREATE INDEX IF NOT EXISTS idx_event_scrape_audit_created ON event_scrape_audit(created_at);
        CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_source_overrides_rt_enabled_pos ON source_overrides(run_type, is_enabled, position);
        CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit(created_at);
        CREATE INDEX IF NOT EXISTS idx_admin_profiles_active_primary ON admin_profiles(is_active, is_primary);
        CREATE INDEX IF NOT EXISTS idx_bot_health_state_updated ON bot_health_state(updated_at);
        CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_plan_slot ON scheduler_decisions(plan_key, slot_index, selected);
        CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_created ON scheduler_decisions(created_at);
        CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_run_at ON scheduler_decisions(run_at);
        CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_exec_status ON scheduler_decisions(execution_status, executed_at);
        CREATE INDEX IF NOT EXISTS idx_command_usage_created ON command_usage_audit(created_at);
        CREATE INDEX IF NOT EXISTS idx_command_usage_name_created ON command_usage_audit(command_name, created_at);
        CREATE INDEX IF NOT EXISTS idx_llm_action_created ON llm_action_audit(created_at);
        CREATE INDEX IF NOT EXISTS idx_llm_action_thread_created ON llm_action_audit(thread_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_llm_action_fingerprint_created ON llm_action_audit(fingerprint, created_at);
        CREATE INDEX IF NOT EXISTS idx_reddit_cache_subreddit_score ON reddit_ingest_cache(subreddit, score DESC);
        CREATE INDEX IF NOT EXISTS idx_reddit_cache_relayed_fetched ON reddit_ingest_cache(relayed, fetched_at DESC);
        CREATE INDEX IF NOT EXISTS idx_reddit_cache_blocked_fetched ON reddit_ingest_cache(blocked, fetched_at DESC);
        CREATE INDEX IF NOT EXISTS idx_dataset_candidates_dataset_status ON dataset_ingest_candidates(dataset_name, status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_dataset_candidates_source ON dataset_ingest_candidates(source_name, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_public_holidays_region_date ON public_holidays(region, holiday_date);
        CREATE INDEX IF NOT EXISTS idx_public_holidays_date ON public_holidays(holiday_date);
        """)

        # Best-effort compatibility when older sqlite DBs already exist without new columns.
        try:
            conn.execute("ALTER TABLE reddit_ingest_cache ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE reddit_ingest_cache ADD COLUMN blocked_reason TEXT")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE scheduler_decisions ADD COLUMN execution_status TEXT")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE scheduler_decisions ADD COLUMN executed_at TEXT")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE scheduler_decisions ADD COLUMN execution_error TEXT")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE scheduler_decisions ADD COLUMN executed_message_id INTEGER")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE scheduler_decisions ADD COLUMN executed_content_type TEXT")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE scheduler_decisions ADD COLUMN executed_content_id TEXT")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE scheduler_decisions ADD COLUMN execution_latency_ms INTEGER")
        except Exception:
            pass


def compute_text_hash(text):
    payload = (text or "").encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def log_post_audit(topic, thread_id, telegram_message_id, content_type, content_id, text, status="sent"):
    payload = text if isinstance(text, str) else json.dumps(text or {}, ensure_ascii=False, sort_keys=True)
    with get_db() as conn:
        _execute(
            conn,
            """
            INSERT INTO post_audit (
                topic, thread_id, telegram_message_id,
                content_type, content_id, text_hash, post_payload, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                topic,
                thread_id,
                telegram_message_id,
                content_type,
                content_id,
                compute_text_hash(text),
                payload,
                status,
            ),
        )


def list_post_audit_history(limit=50, offset=0, content_type=None, topic=None, status=None):
    sql = """
        SELECT id, posted_at, topic, thread_id, telegram_message_id, content_type,
               content_id, text_hash, post_payload, status
        FROM post_audit
        WHERE 1=1
    """
    args = []
    if content_type:
        sql += " AND content_type=?"
        args.append(str(content_type))
    if topic:
        sql += " AND topic=?"
        args.append(str(topic))
    if status:
        sql += " AND status=?"
        args.append(str(status))
    sql += " ORDER BY posted_at DESC, id DESC LIMIT ? OFFSET ?"
    args.extend([max(1, min(500, int(limit))), max(0, int(offset))])
    with get_db() as conn:
        rows = _fetchall(_execute(conn, sql, tuple(args)))
    out = []
    for row in rows:
        if hasattr(row, "keys"):
            out.append(dict(row))
        else:
            out.append({
                "id": row[0],
                "posted_at": row[1],
                "topic": row[2],
                "thread_id": row[3],
                "telegram_message_id": row[4],
                "content_type": row[5],
                "content_id": row[6],
                "text_hash": row[7],
                "post_payload": row[8],
                "status": row[9],
            })
    return out


def count_post_audit_history(content_type=None, topic=None, status=None):
    sql = "SELECT COUNT(*) FROM post_audit WHERE 1=1"
    args = []
    if content_type:
        sql += " AND content_type=?"
        args.append(str(content_type))
    if topic:
        sql += " AND topic=?"
        args.append(str(topic))
    if status:
        sql += " AND status=?"
        args.append(str(status))
    with get_db() as conn:
        row = _fetchone(_execute(conn, sql, tuple(args)))
    if not row:
        return 0
    return int(row[0] if not hasattr(row, "get") else row[0])


def get_post_audit(post_id):
    with get_db() as conn:
        row = _fetchone(
            _execute(
                conn,
                """
                SELECT id, posted_at, topic, thread_id, telegram_message_id, content_type,
                       content_id, text_hash, post_payload, status
                FROM post_audit
                WHERE id=?
                """,
                (int(post_id),),
            )
        )
    if not row:
        return None
    if hasattr(row, "keys"):
        return dict(row)
    return {
        "id": row[0],
        "posted_at": row[1],
        "topic": row[2],
        "thread_id": row[3],
        "telegram_message_id": row[4],
        "content_type": row[5],
        "content_id": row[6],
        "text_hash": row[7],
        "post_payload": row[8],
        "status": row[9],
    }


def log_scheduler_decision(
    plan_key,
    slot_index,
    topic,
    score,
    selected,
    scheduled_for_date=None,
    run_at=None,
    score_factors=None,
    reason=None,
):
    factors_payload = score_factors
    if factors_payload is not None and not isinstance(factors_payload, str):
        factors_payload = json.dumps(factors_payload, ensure_ascii=False, sort_keys=True)
    with get_db() as conn:
        _execute(
            conn,
            """
            INSERT INTO scheduler_decisions(
                plan_key, slot_index, topic, score, selected,
                scheduled_for_date, run_at, score_factors, reason
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(plan_key),
                int(slot_index),
                str(topic),
                float(score or 0.0),
                1 if selected else 0,
                scheduled_for_date,
                run_at,
                factors_payload,
                reason,
            ),
        )


def list_scheduler_decisions_window(hours=24, selected=None, limit=500):
    cutoff = _utc_cutoff(max(1, int(hours)) * 3600)
    sql = """
        SELECT id, plan_key, slot_index, topic, score, selected, scheduled_for_date,
             run_at, score_factors, reason, execution_status, executed_at,
             execution_error, executed_message_id, executed_content_type,
             executed_content_id, execution_latency_ms, created_at
        FROM scheduler_decisions
        WHERE created_at >= ?
    """
    args = [cutoff]
    if selected is not None:
        sql += " AND selected=?"
        args.append(1 if bool(selected) else 0)
    sql += " ORDER BY created_at DESC, slot_index ASC LIMIT ?"
    args.append(max(1, min(2000, int(limit))))
    with get_db() as conn:
        rows = _fetchall(_execute(conn, sql, tuple(args)))
    out = []
    for row in rows:
        payload = dict(row) if hasattr(row, "keys") else {
            "id": row[0],
            "plan_key": row[1],
            "slot_index": row[2],
            "topic": row[3],
            "score": row[4],
            "selected": row[5],
            "scheduled_for_date": row[6],
            "run_at": row[7],
            "score_factors": row[8],
            "reason": row[9],
            "execution_status": row[10],
            "executed_at": row[11],
            "execution_error": row[12],
            "executed_message_id": row[13],
            "executed_content_type": row[14],
            "executed_content_id": row[15],
            "execution_latency_ms": row[16],
            "created_at": row[17],
        }
        factors_raw = payload.get("score_factors")
        if isinstance(factors_raw, str) and factors_raw.strip():
            try:
                payload["score_factors"] = json.loads(factors_raw)
            except Exception:
                payload["score_factors"] = {}
        elif not isinstance(factors_raw, dict):
            payload["score_factors"] = {}
        out.append(payload)
    return out


def upcoming_scheduler_decisions(limit=10):
    now_value = datetime.now(timezone.utc) if _use_postgres() else datetime.now(timezone.utc).isoformat()
    with get_db() as conn:
        rows = _fetchall(
            _execute(
                conn,
                """
                SELECT id, plan_key, slot_index, topic, score, selected, scheduled_for_date,
                      run_at, score_factors, reason, execution_status, executed_at,
                      execution_error, executed_message_id, executed_content_type,
                      executed_content_id, execution_latency_ms, created_at
                FROM scheduler_decisions
                WHERE selected=1 AND run_at IS NOT NULL AND run_at >= ?
                ORDER BY run_at ASC, slot_index ASC
                LIMIT ?
                """,
                (now_value, max(1, min(100, int(limit)))),
            )
        )
    out = []
    for row in rows:
        payload = dict(row) if hasattr(row, "keys") else {
            "id": row[0],
            "plan_key": row[1],
            "slot_index": row[2],
            "topic": row[3],
            "score": row[4],
            "selected": row[5],
            "scheduled_for_date": row[6],
            "run_at": row[7],
            "score_factors": row[8],
            "reason": row[9],
            "execution_status": row[10],
            "executed_at": row[11],
            "execution_error": row[12],
            "executed_message_id": row[13],
            "executed_content_type": row[14],
            "executed_content_id": row[15],
            "execution_latency_ms": row[16],
            "created_at": row[17],
        }
        factors_raw = payload.get("score_factors")
        if isinstance(factors_raw, str) and factors_raw.strip():
            try:
                payload["score_factors"] = json.loads(factors_raw)
            except Exception:
                payload["score_factors"] = {}
        elif not isinstance(factors_raw, dict):
            payload["score_factors"] = {}
        out.append(payload)
    return out


def mark_scheduler_execution(
    plan_key,
    slot_index,
    execution_status,
    executed_at=None,
    execution_error=None,
    executed_message_id=None,
    executed_content_type=None,
    executed_content_id=None,
    execution_latency_ms=None,
):
    stamp = executed_at or (datetime.now(timezone.utc) if _use_postgres() else datetime.now(timezone.utc).isoformat())
    with get_db() as conn:
        _execute(
            conn,
            """
            UPDATE scheduler_decisions
            SET execution_status=?,
                executed_at=?,
                execution_error=?,
                executed_message_id=?,
                executed_content_type=?,
                executed_content_id=?,
                execution_latency_ms=?
            WHERE plan_key=? AND slot_index=? AND selected=1
            """,
            (
                execution_status,
                stamp,
                execution_error,
                executed_message_id,
                executed_content_type,
                executed_content_id,
                execution_latency_ms,
                str(plan_key),
                int(slot_index),
            ),
        )


def scheduler_plan_detail(plan_key):
    with get_db() as conn:
        rows = _fetchall(
            _execute(
                conn,
                """
                SELECT id, plan_key, slot_index, topic, score, selected, scheduled_for_date,
                       run_at, score_factors, reason, execution_status, executed_at,
                       execution_error, executed_message_id, executed_content_type,
                       executed_content_id, execution_latency_ms, created_at
                FROM scheduler_decisions
                WHERE plan_key=?
                ORDER BY slot_index ASC, selected DESC, score DESC, id ASC
                """,
                (str(plan_key),),
            )
        )
    out = []
    for row in rows:
        payload = dict(row) if hasattr(row, "keys") else {
            "id": row[0],
            "plan_key": row[1],
            "slot_index": row[2],
            "topic": row[3],
            "score": row[4],
            "selected": row[5],
            "scheduled_for_date": row[6],
            "run_at": row[7],
            "score_factors": row[8],
            "reason": row[9],
            "execution_status": row[10],
            "executed_at": row[11],
            "execution_error": row[12],
            "executed_message_id": row[13],
            "executed_content_type": row[14],
            "executed_content_id": row[15],
            "execution_latency_ms": row[16],
            "created_at": row[17],
        }
        factors_raw = payload.get("score_factors")
        if isinstance(factors_raw, str) and factors_raw.strip():
            try:
                payload["score_factors"] = json.loads(factors_raw)
            except Exception:
                payload["score_factors"] = {}
        elif not isinstance(factors_raw, dict):
            payload["score_factors"] = {}
        out.append(payload)
    return out


def latest_post_audit_for_delivery(telegram_message_id=None, content_type=None, content_id=None):
    sql = """
        SELECT id, posted_at, topic, thread_id, telegram_message_id, content_type, content_id, status
        FROM post_audit
        WHERE 1=1
    """
    args = []
    if telegram_message_id is not None:
        sql += " AND telegram_message_id=?"
        args.append(telegram_message_id)
    if content_type:
        sql += " AND content_type=?"
        args.append(str(content_type))
    if content_id:
        sql += " AND content_id=?"
        args.append(str(content_id))
    sql += " ORDER BY posted_at DESC LIMIT 1"
    with get_db() as conn:
        row = _fetchone(_execute(conn, sql, tuple(args)))
    if not row:
        return None
    return dict(row) if hasattr(row, "keys") else {
        "id": row[0],
        "posted_at": row[1],
        "topic": row[2],
        "thread_id": row[3],
        "telegram_message_id": row[4],
        "content_type": row[5],
        "content_id": row[6],
        "status": row[7],
    }


def scheduler_topic_counts(hours=24, selected_only=True):
    cutoff = _utc_cutoff(max(1, int(hours)) * 3600)
    sql = """
        SELECT topic, COUNT(*) AS cnt
        FROM scheduler_decisions
        WHERE created_at >= ?
    """
    args = [cutoff]
    if selected_only:
        sql += " AND selected=1"
    sql += " GROUP BY topic ORDER BY cnt DESC, topic ASC"
    with get_db() as conn:
        rows = _fetchall(_execute(conn, sql, tuple(args)))
    return [dict(row) if hasattr(row, "keys") else {"topic": row[0], "cnt": row[1]} for row in rows]


def scheduler_outcome_counts(hours=24):
    cutoff = _utc_cutoff(max(1, int(hours)) * 3600)
    with get_db() as conn:
        rows = _fetchall(
            _execute(
                conn,
                """
                SELECT COALESCE(execution_status, 'pending') AS execution_status, COUNT(*) AS cnt
                FROM scheduler_decisions
                WHERE created_at >= ? AND selected=1
                GROUP BY COALESCE(execution_status, 'pending')
                ORDER BY cnt DESC, execution_status ASC
                """,
                (cutoff,),
            )
        )
    return [dict(row) if hasattr(row, "keys") else {"execution_status": row[0], "cnt": row[1]} for row in rows]


def scheduler_selected_breakdown(hours=24, limit=30):
    rows = list_scheduler_decisions_window(hours=hours, selected=True, limit=limit)
    return rows


def log_command_usage(
    command_name,
    status,
    user_id=None,
    chat_id=None,
    thread_id=None,
    args_text=None,
    is_admin=False,
    latency_ms=None,
    error=None,
):
    with get_db() as conn:
        _execute(
            conn,
            """
            INSERT INTO command_usage_audit(
                command_name, status, user_id, chat_id, thread_id,
                args_text, is_admin, latency_ms, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(command_name),
                str(status),
                user_id,
                chat_id,
                thread_id,
                args_text,
                1 if is_admin else 0,
                latency_ms,
                error,
            ),
        )


def command_usage_counts(hours=24, limit=20):
    cutoff = _utc_cutoff(max(1, int(hours)) * 3600)
    with get_db() as conn:
        rows = _fetchall(
            _execute(
                conn,
                """
                SELECT command_name, status, COUNT(*) AS cnt
                FROM command_usage_audit
                WHERE created_at >= ?
                GROUP BY command_name, status
                ORDER BY cnt DESC, command_name ASC
                LIMIT ?
                """,
                (cutoff, max(1, min(200, int(limit)))),
            )
        )
    return [
        dict(row) if hasattr(row, "keys") else {"command_name": row[0], "status": row[1], "cnt": row[2]}
        for row in rows
    ]


def top_commands(hours=24, limit=10):
    cutoff = _utc_cutoff(max(1, int(hours)) * 3600)
    with get_db() as conn:
        rows = _fetchall(
            _execute(
                conn,
                """
                SELECT command_name, COUNT(*) AS cnt, AVG(COALESCE(latency_ms, 0)) AS avg_latency_ms
                FROM command_usage_audit
                WHERE created_at >= ?
                GROUP BY command_name
                ORDER BY cnt DESC, command_name ASC
                LIMIT ?
                """,
                (cutoff, max(1, min(100, int(limit)))),
            )
        )
    return [
        dict(row) if hasattr(row, "keys") else {"command_name": row[0], "cnt": row[1], "avg_latency_ms": row[2]}
        for row in rows
    ]


def command_error_rates(hours=24, limit=15):
    cutoff = _utc_cutoff(max(1, int(hours)) * 3600)
    with get_db() as conn:
        rows = _fetchall(
            _execute(
                conn,
                """
                SELECT command_name,
                       COUNT(*) AS total_count,
                       SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS error_count,
                       AVG(COALESCE(latency_ms, 0)) AS avg_latency_ms
                FROM command_usage_audit
                WHERE created_at >= ?
                GROUP BY command_name
                ORDER BY error_count DESC, total_count DESC, command_name ASC
                LIMIT ?
                """,
                (cutoff, max(1, min(100, int(limit)))),
            )
        )
    out = []
    for row in rows:
        if hasattr(row, "get"):
            total = int(row.get("total_count") or 0)
            errors = int(row.get("error_count") or 0)
            avg_latency = row.get("avg_latency_ms")
            name = row.get("command_name")
        else:
            name, total, errors, avg_latency = row
            total = int(total or 0)
            errors = int(errors or 0)
        out.append(
            {
                "command_name": name,
                "total_count": total,
                "error_count": errors,
                "error_rate": round((errors / total) if total else 0.0, 4),
                "avg_latency_ms": avg_latency,
            }
        )
    return out


def scheduler_outcome_timeseries(hours=24, bucket_minutes=60):
    rows = scheduler_selected_breakdown(hours=hours, limit=5000)
    buckets = {}
    for row in rows:
        dt = _coerce_any_datetime(row.get("executed_at") or row.get("created_at"))
        if not dt:
            continue
        bucket_dt = dt.replace(minute=(dt.minute // max(5, int(bucket_minutes))) * max(5, int(bucket_minutes)), second=0, microsecond=0)
        label = bucket_dt.strftime("%m-%d %H:%M")
        status = str(row.get("execution_status") or "pending")
        payload = buckets.setdefault(label, {"bucket": label, "sent": 0, "failed": 0, "no_content": 0, "pending": 0})
        if status in payload:
            payload[status] += 1
        else:
            payload[status] = payload.get(status, 0) + 1
    return [buckets[key] for key in sorted(buckets.keys())]


def command_failure_timeseries(hours=24, bucket_minutes=60):
    cutoff = _utc_cutoff(max(1, int(hours)) * 3600)
    with get_db() as conn:
        rows = _fetchall(
            _execute(
                conn,
                """
                SELECT status, created_at
                FROM command_usage_audit
                WHERE created_at >= ?
                ORDER BY created_at ASC
                """,
                (cutoff,),
            )
        )
    buckets = {}
    bucket_size = max(5, int(bucket_minutes))
    for row in rows:
        status = row.get("status") if hasattr(row, "get") else row[0]
        created_at = row.get("created_at") if hasattr(row, "get") else row[1]
        dt = _coerce_any_datetime(created_at)
        if not dt:
            continue
        bucket_dt = dt.replace(minute=(dt.minute // bucket_size) * bucket_size, second=0, microsecond=0)
        label = bucket_dt.strftime("%m-%d %H:%M")
        payload = buckets.setdefault(label, {"bucket": label, "total": 0, "errors": 0})
        payload["total"] += 1
        if str(status) == "error":
            payload["errors"] += 1
    return [buckets[key] for key in sorted(buckets.keys())]


def recent_post_counts_by_content_type(hours=72, content_types=None):
    cutoff = _utc_cutoff(max(1, int(hours)) * 3600)
    sql = """
        SELECT content_type, COUNT(*) AS cnt
        FROM post_audit
        WHERE posted_at >= ?
    """
    args = [cutoff]
    if content_types:
        placeholders = ",".join(["?"] * len(content_types))
        sql += f" AND content_type IN ({placeholders})"
        args.extend([str(value) for value in content_types])
    sql += " GROUP BY content_type ORDER BY cnt DESC"
    with get_db() as conn:
        rows = _fetchall(_execute(conn, sql, tuple(args)))
    counts = {}
    for row in rows:
        key = row.get("content_type") if hasattr(row, "get") else row[0]
        value = row.get("cnt") if hasattr(row, "get") else row[1]
        counts[str(key)] = int(value or 0)
    return counts


def posted_today_by_content_type():
    start, end = _utc_window_for_today()
    with get_db() as conn:
        rows = _fetchall(
            _execute(
                conn,
                """
                SELECT content_type, COUNT(*) AS cnt
                FROM post_audit
                WHERE posted_at >= ? AND posted_at < ?
                GROUP BY content_type
                ORDER BY cnt DESC, content_type ASC
                """,
                (start, end),
            )
        )
    return [dict(row) if hasattr(row, "keys") else {"content_type": row[0], "cnt": row[1]} for row in rows]


def topic_thread_usage(limit=200):
    with get_db() as conn:
        return _fetchall(
            _execute(
                conn,
                """
                SELECT topic, thread_id, COUNT(*) AS post_count, MAX(posted_at) AS latest_posted_at
                FROM post_audit
                GROUP BY topic, thread_id
                ORDER BY latest_posted_at DESC
                LIMIT ?
                """,
                (max(1, min(2000, int(limit))),),
            )
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


def has_any_post_audit():
    with get_db() as conn:
        row = _fetchone(_execute(conn, "SELECT 1 FROM post_audit LIMIT 1"))
    return bool(row)


def upsert_event_item(item):
    with get_db() as conn:
        _execute(
            conn,
            """
            INSERT INTO events (
                item_key, title, url, source_name, source_tier, region, category,
                event_date, canonical_url, dedupe_key, location_text, language,
                raw_event_type, source_meta, source_veracity, confidence, status, auto_publish_allowed, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(item_key) DO UPDATE SET
                title=excluded.title,
                url=excluded.url,
                canonical_url=excluded.canonical_url,
                dedupe_key=excluded.dedupe_key,
                source_name=excluded.source_name,
                source_tier=excluded.source_tier,
                region=excluded.region,
                category=excluded.category,
                event_date=excluded.event_date,
                location_text=excluded.location_text,
                language=excluded.language,
                raw_event_type=excluded.raw_event_type,
                source_meta=excluded.source_meta,
                source_veracity=excluded.source_veracity,
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
                item.get("canonical_url"),
                item.get("dedupe_key"),
                item.get("location_text"),
                item.get("language"),
                item.get("raw_event_type"),
                item.get("source_meta"),
                item.get("source_veracity", "rumor"),
                item["confidence"],
                item["status"],
                1 if item.get("auto_publish_allowed") else 0,
            ),
        )


def _log_event_audit_table(table_name, run_type, source_name, source_url, source_tier, parser_strategy,
                           status, extraction_health, extraction_ratio, fetched_count, saved_count, error=None):
    with get_db() as conn:
        _execute(
            conn,
            f"""
            INSERT INTO {table_name} (
                run_type, source_name, source_url, source_tier, parser_strategy,
                status, extraction_health, extraction_ratio, fetched_count, saved_count, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_type,
                source_name,
                source_url,
                source_tier,
                parser_strategy,
                status,
                extraction_health,
                extraction_ratio,
                fetched_count,
                saved_count,
                error,
            ),
        )


def log_event_crawl_audit(run_type, source_name, source_url, source_tier, parser_strategy,
                          status, extraction_health, extraction_ratio, fetched_count, saved_count, error=None):
    _log_event_audit_table(
        "event_crawl_audit",
        run_type,
        source_name,
        source_url,
        source_tier,
        parser_strategy,
        status,
        extraction_health,
        extraction_ratio,
        fetched_count,
        saved_count,
        error,
    )


def log_event_scrape_audit(run_type, source_name, source_url, source_tier, parser_strategy,
                           status, extraction_health, extraction_ratio, fetched_count, saved_count, error=None):
    _log_event_audit_table(
        "event_scrape_audit",
        run_type,
        source_name,
        source_url,
        source_tier,
        parser_strategy,
        status,
        extraction_health,
        extraction_ratio,
        fetched_count,
        saved_count,
        error,
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


def reject_pending_events_before(cutoff_date_iso, region=None):
    cutoff = str(cutoff_date_iso or "").strip()
    if not cutoff:
        return 0

    query = (
        "UPDATE events "
        "SET status='rejected', auto_publish_allowed=0, updated_at=CURRENT_TIMESTAMP "
        "WHERE status='pending_review' AND event_date IS NOT NULL AND event_date < ?"
    )
    args = [cutoff]
    if region:
        query += " AND region=?"
        args.append(str(region).strip().lower())

    with get_db() as conn:
        cur = _execute(conn, query, tuple(args))
        try:
            return int(cur.rowcount or 0)
        except Exception:
            return 0


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


def latest_successful_ingestion_at(run_type=None):
    sql = "SELECT MAX(created_at) FROM ingestion_runs WHERE status='ok'"
    args = []
    if run_type and run_type != "all":
        sql += " AND run_type=?"
        args.append(str(run_type).strip().lower())
    with get_db() as conn:
        row = _fetchone(_execute(conn, sql, tuple(args)))
    if not row:
        return None
    if hasattr(row, "get"):
        try:
            return row[0]
        except Exception:
            values = list(row.values())
            return values[0] if values else None
    return row[0]


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


def count_events_by_status(status, region=None):
    sql = "SELECT COUNT(*) FROM events WHERE status=?"
    args = [str(status).strip().lower()]
    if region:
        sql += " AND region=?"
        args.append(str(region).strip().lower())
    with get_db() as conn:
        row = _fetchone(_execute(conn, sql, tuple(args)))
    if not row:
        return 0
    if hasattr(row, "get"):
        try:
            return int(row[0])
        except Exception:
            values = list(row.values())
            return int(values[0]) if values else 0
    return int(row[0])


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


def list_dataset_names():
    return ["facts", "quotes", "polls", "trivia", "discussions"]


def get_dataset_items(dataset_name):
    clean_name = str(dataset_name or "").strip().lower()
    if not clean_name:
        raise ValueError("dataset_name is required")
    try:
        with get_db() as conn:
            row = _fetchone(_execute(
                conn,
                "SELECT dataset_value FROM dataset_store WHERE dataset_name=?",
                (clean_name,),
            ))
    except Exception as exc:
        if _is_missing_relation_error(exc):
            return _load_dataset_seed(clean_name)
        raise
    if not row:
        return _load_dataset_seed(clean_name)
    raw_value = row.get("dataset_value") if hasattr(row, "get") else row[0]
    if not raw_value:
        return _load_dataset_seed(clean_name)
    try:
        parsed = json.loads(raw_value)
    except Exception:
        return _load_dataset_seed(clean_name)
    return parsed if isinstance(parsed, list) else _load_dataset_seed(clean_name)


def replace_dataset_items(dataset_name, payload, updated_by=None):
    clean_name = str(dataset_name or "").strip().lower()
    if not clean_name:
        raise ValueError("dataset_name is required")
    init_db()
    payload_text = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    with get_db() as conn:
        _execute(
            conn,
            """
            INSERT INTO dataset_store(dataset_name, dataset_value, updated_by, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(dataset_name) DO UPDATE SET
                dataset_value=excluded.dataset_value,
                updated_by=excluded.updated_by,
                updated_at=CURRENT_TIMESTAMP
            """,
            (clean_name, payload_text, updated_by),
        )


def list_thread_mappings():
    with get_db() as conn:
        return _fetchall(
            _execute(
                conn,
                "SELECT topic_name, thread_id, thread_label, updated_by, updated_at FROM thread_mappings ORDER BY topic_name ASC",
            )
        )


def get_thread_mapping(topic_name):
    clean_name = str(topic_name or "").strip().lower()
    if not clean_name:
        return None
    with get_db() as conn:
        return _fetchone(
            _execute(
                conn,
                "SELECT topic_name, thread_id, thread_label, updated_by, updated_at FROM thread_mappings WHERE topic_name=?",
                (clean_name,),
            )
        )


def upsert_thread_mapping(topic_name, thread_id, thread_label=None, updated_by=None):
    clean_name = str(topic_name or "").strip().lower()
    if not clean_name:
        raise ValueError("topic_name is required")
    if clean_name not in SUPPORTED_THREAD_TOPICS:
        raise ValueError(f"unsupported topic_name: {clean_name}")
    clean_thread_id = None if thread_id is None else int(thread_id)
    if clean_thread_id is not None and clean_thread_id <= 0:
        raise ValueError("thread_id must be a positive integer")
    clean_label = None if thread_label is None else str(thread_label)
    if clean_label is not None and not clean_label.strip():
        clean_label = None
    if clean_label is None:
        clean_label = THREAD_TOPIC_LABELS.get(clean_name)
    with get_db() as conn:
        _execute(
            conn,
            """
            INSERT INTO thread_mappings(topic_name, thread_id, thread_label, updated_by, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(topic_name) DO UPDATE SET
                thread_id=excluded.thread_id,
                thread_label=excluded.thread_label,
                updated_by=excluded.updated_by,
                updated_at=CURRENT_TIMESTAMP
            """,
            (clean_name, clean_thread_id, clean_label, updated_by),
        )


def resolve_thread_id(topic_name, default=None):
    mapping = get_thread_mapping(topic_name)
    if mapping:
        value = mapping.get("thread_id") if hasattr(mapping, "get") else mapping[1]
        try:
            resolved = int(value)
            if resolved > 0:
                return resolved
        except Exception:
            pass
    try:
        return int(default) if default is not None and int(default) > 0 else None
    except Exception:
        return None


def get_runtime_setting(setting_key, default_value=None):
    with get_db() as conn:
        row = _fetchone(
            _execute(
                conn,
                "SELECT setting_value FROM runtime_settings WHERE setting_key=?",
                (setting_key,),
            )
        )
    if not row:
        return default_value
    return row.get("setting_value") if hasattr(row, "get") else row[0]


def list_runtime_settings():
    with get_db() as conn:
        return _fetchall(
            _execute(
                conn,
                "SELECT setting_key, setting_value, updated_by, updated_at FROM runtime_settings ORDER BY setting_key ASC",
            )
        )


def upsert_runtime_setting(setting_key, setting_value, updated_by=None):
    with get_db() as conn:
        _execute(
            conn,
            """
            INSERT INTO runtime_settings(setting_key, setting_value, updated_by, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(setting_key) DO UPDATE SET
                setting_value=excluded.setting_value,
                updated_by=excluded.updated_by,
                updated_at=CURRENT_TIMESTAMP
            """,
            (setting_key, str(setting_value), updated_by),
        )


def create_admin_session(token, user_id, expires_at, ip_address=None, user_agent=None):
    with get_db() as conn:
        _execute(
            conn,
            """
            INSERT INTO admin_sessions(token, user_id, ip_address, user_agent, expires_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (token, user_id, ip_address, user_agent, expires_at),
        )


def get_admin_session(token):
    with get_db() as conn:
        return _fetchone(
            _execute(
                conn,
                "SELECT token, user_id, ip_address, user_agent, created_at, expires_at, last_seen_at FROM admin_sessions WHERE token=?",
                (token,),
            )
        )


def touch_admin_session(token):
    with get_db() as conn:
        _execute(
            conn,
            "UPDATE admin_sessions SET last_seen_at=CURRENT_TIMESTAMP WHERE token=?",
            (token,),
        )


def revoke_admin_session(token):
    with get_db() as conn:
        _execute(conn, "DELETE FROM admin_sessions WHERE token=?", (token,))


def clear_expired_admin_sessions(now_utc=None):
    now_utc = now_utc or datetime.now(timezone.utc)
    stamp = now_utc.isoformat()
    with get_db() as conn:
        _execute(conn, "DELETE FROM admin_sessions WHERE expires_at < ?", (stamp,))


def list_source_overrides(run_type):
    with get_db() as conn:
        rows = _fetchall(
            _execute(
                conn,
                """
                SELECT id, run_type, source_tier, source_kind, source_name, source_url,
                       source_meta, is_enabled, position, updated_by, updated_at
                FROM source_overrides
                WHERE run_type=?
                ORDER BY is_enabled DESC, position ASC, id ASC
                """,
                (run_type,),
            )
        )

    out = []
    for row in rows:
        meta_raw = row.get("source_meta") if hasattr(row, "get") else row[6]
        try:
            meta = json.loads(meta_raw) if meta_raw else {}
        except Exception:
            meta = {}
        payload = dict(row) if hasattr(row, "keys") else {
            "id": row[0],
            "run_type": row[1],
            "source_tier": row[2],
            "source_kind": row[3],
            "source_name": row[4],
            "source_url": row[5],
            "source_meta": row[6],
            "is_enabled": row[7],
            "position": row[8],
            "updated_by": row[9],
            "updated_at": row[10],
        }
        payload["source_meta"] = meta
        out.append(payload)
    return out


def replace_source_overrides(run_type, sources, updated_by=None):
    with get_db() as conn:
        _execute(conn, "DELETE FROM source_overrides WHERE run_type=?", (run_type,))
        for idx, source in enumerate(sources):
            _execute(
                conn,
                """
                INSERT INTO source_overrides(
                    run_type, source_tier, source_kind, source_name, source_url,
                    source_meta, is_enabled, position, updated_by, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                """,
                (
                    run_type,
                    source.get("tier") or "rss",
                    source.get("kind") or "event",
                    source.get("name") or f"source-{idx + 1}",
                    source.get("url") or "",
                    json.dumps(source.get("meta") or {}, ensure_ascii=False, sort_keys=True),
                    1 if source.get("enabled", True) else 0,
                    int(source.get("position", idx)),
                    updated_by,
                ),
            )


def add_admin_audit(action, actor_user_id=None, actor_label=None, details=None):
    with get_db() as conn:
        _execute(
            conn,
            """
            INSERT INTO admin_audit(action, actor_user_id, actor_label, details)
            VALUES (?, ?, ?, ?)
            """,
            (action, actor_user_id, actor_label, details),
        )


def list_admin_audit(limit=100):
    with get_db() as conn:
        return _fetchall(
            _execute(
                conn,
                """
                SELECT id, action, actor_user_id, actor_label, details, created_at
                FROM admin_audit
                ORDER BY id DESC
                LIMIT ?
                """,
                (max(1, min(500, int(limit))),),
            )
        )


def ensure_admin_profiles(admin_user_ids):
    user_ids = []
    for raw in admin_user_ids or []:
        try:
            user_ids.append(int(raw))
        except Exception:
            continue
    if not user_ids:
        return
    primary = user_ids[0]
    with get_db() as conn:
        for user_id in user_ids:
            row = _fetchone(_execute(conn, "SELECT user_id FROM admin_profiles WHERE user_id=?", (user_id,)))
            if row:
                continue
            _execute(
                conn,
                """
                INSERT INTO admin_profiles(user_id, display_name, username, email, role, is_active, is_primary, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (user_id, f"Admin {user_id}", "", "", "admin", 1, 1 if user_id == primary else 0, ""),
            )


def list_admin_profiles():
    with get_db() as conn:
        return _fetchall(
            _execute(
                conn,
                """
                SELECT user_id, display_name, username, email, role, is_active, is_primary, notes, created_at, updated_at
                FROM admin_profiles
                ORDER BY is_primary DESC, is_active DESC, user_id ASC
                """,
            )
        )


def list_active_admin_profiles():
    with get_db() as conn:
        return _fetchall(
            _execute(
                conn,
                """
                SELECT user_id, display_name, username, email, role, is_active, is_primary, notes, created_at, updated_at
                FROM admin_profiles
                WHERE is_active=1
                ORDER BY is_primary DESC, user_id ASC
                """,
            )
        )


def is_admin_user(user_id):
    try:
        user_id = int(user_id)
    except Exception:
        return False
    rows = list_active_admin_profiles()
    if rows:
        return any(int((row.get("user_id") if hasattr(row, "get") else row[0])) == user_id for row in rows)
    return user_id in config.ADMIN_USER_IDS


def list_active_admin_emails():
    emails = []
    for row in list_active_admin_profiles():
        email = (row.get("email") if hasattr(row, "get") else row[3]) or ""
        email = str(email).strip()
        if email:
            emails.append(email)
    return emails


def get_admin_profile(user_id):
    with get_db() as conn:
        return _fetchone(
            _execute(
                conn,
                """
                SELECT user_id, display_name, username, email, role, is_active, is_primary, notes, created_at, updated_at
                FROM admin_profiles
                WHERE user_id=?
                """,
                (int(user_id),),
            )
        )


def schema_migration_versions():
    with get_db() as conn:
        try:
            rows = _fetchall(
                _execute(
                    conn,
                    "SELECT version, applied_at FROM schema_migrations ORDER BY version ASC",
                )
            )
        except Exception:
            return []
    out = []
    for row in rows:
        if hasattr(row, "keys"):
            out.append({
                "version": row.get("version"),
                "applied_at": row.get("applied_at"),
            })
        else:
            out.append({
                "version": row[0],
                "applied_at": row[1],
            })
    return out


def upsert_admin_profile(user_id, display_name=None, username=None, email=None, role="admin", is_active=True, is_primary=False, notes=None):
    with get_db() as conn:
        _execute(
            conn,
            """
            INSERT INTO admin_profiles(user_id, display_name, username, email, role, is_active, is_primary, notes, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET
                display_name=excluded.display_name,
                username=excluded.username,
                email=excluded.email,
                role=excluded.role,
                is_active=excluded.is_active,
                is_primary=excluded.is_primary,
                notes=excluded.notes,
                updated_at=CURRENT_TIMESTAMP
            """,
            (
                int(user_id),
                display_name,
                username,
                email,
                role or "admin",
                1 if is_active else 0,
                1 if is_primary else 0,
                notes,
            ),
        )


def delete_admin_profile(user_id):
    with get_db() as conn:
        _execute(conn, "DELETE FROM admin_profiles WHERE user_id=?", (int(user_id),))


def set_bot_health_state(state_key, state_value):
    with get_db() as conn:
        _execute(
            conn,
            """
            INSERT INTO bot_health_state(state_key, state_value, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(state_key) DO UPDATE SET
                state_value=excluded.state_value,
                updated_at=CURRENT_TIMESTAMP
            """,
            (str(state_key), str(state_value)),
        )


def get_bot_health_state(state_key, default_value=None):
    with get_db() as conn:
        row = _fetchone(_execute(conn, "SELECT state_value FROM bot_health_state WHERE state_key=?", (str(state_key),)))
    if not row:
        return default_value
    return row.get("state_value") if hasattr(row, "get") else row[0]


def _utc_window_for_today():
    now = datetime.now(timezone.utc)
    day_start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
    day_end = day_start + timedelta(days=1)
    if _use_postgres():
        return day_start, day_end
    return day_start.isoformat(), day_end.isoformat()


def _utc_cutoff(seconds):
    dt = datetime.now(timezone.utc) - timedelta(seconds=max(0, int(seconds)))
    if _use_postgres():
        return dt
    return dt.isoformat()


def _coerce_any_datetime(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        raw = str(value).strip().replace(" ", "T").replace("Z", "+00:00")
        if not raw:
            return None
        try:
            dt = datetime.fromisoformat(raw)
        except Exception:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def log_llm_action(
    action_type,
    status,
    reason=None,
    chat_id=None,
    thread_id=None,
    user_id=None,
    source_message_id=None,
    response_message_id=None,
    provider=None,
    model=None,
    latency_ms=None,
    prompt_chars=None,
    response_chars=None,
    trigger_score=None,
    fingerprint=None,
    error=None,
):
    with get_db() as conn:
        _execute(
            conn,
            """
            INSERT INTO llm_action_audit(
                action_type, status, reason, chat_id, thread_id, user_id,
                source_message_id, response_message_id, provider, model,
                latency_ms, prompt_chars, response_chars, trigger_score,
                fingerprint, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                action_type,
                status,
                reason,
                chat_id,
                thread_id,
                user_id,
                source_message_id,
                response_message_id,
                provider,
                model,
                latency_ms,
                prompt_chars,
                response_chars,
                trigger_score,
                fingerprint,
                error,
            ),
        )


def count_llm_actions_today(status="sent", thread_id=None):
    start, end = _utc_window_for_today()
    query = "SELECT COUNT(*) FROM llm_action_audit WHERE created_at >= ? AND created_at < ?"
    args = [start, end]
    if status:
        query += " AND status=?"
        args.append(status)
    if thread_id is not None:
        query += " AND thread_id=?"
        args.append(thread_id)
    with get_db() as conn:
        row = _fetchone(_execute(conn, query, tuple(args)))
    if not row:
        return 0
    if hasattr(row, "get"):
        value = row.get("count")
        if value is None:
            value = row.get("COUNT(*)")
        if value is None:
            try:
                value = row[0]
            except Exception:
                value = 0
        return int(value)
    return int(row[0])


def latest_llm_action(thread_id=None, status="sent"):
    query = "SELECT created_at FROM llm_action_audit WHERE 1=1"
    args = []
    if status:
        query += " AND status=?"
        args.append(status)
    if thread_id is not None:
        query += " AND thread_id=?"
        args.append(thread_id)
    query += " ORDER BY created_at DESC LIMIT 1"
    with get_db() as conn:
        row = _fetchone(_execute(conn, query, tuple(args)))
    if not row:
        return None
    created = row.get("created_at") if hasattr(row, "get") else row[0]
    return _coerce_posted_at(created)


def has_recent_llm_fingerprint(fingerprint, seconds=21600):
    if not fingerprint:
        return False
    cutoff = _utc_cutoff(seconds)
    with get_db() as conn:
        row = _fetchone(
            _execute(
                conn,
                """
                SELECT 1
                FROM llm_action_audit
                WHERE fingerprint=? AND status='sent' AND created_at >= ?
                LIMIT 1
                """,
                (fingerprint, cutoff),
            )
        )
    return bool(row)


def llm_status_counts(hours=24):
    cutoff = _utc_cutoff(max(1, int(hours)) * 3600)
    with get_db() as conn:
        rows = _fetchall(
            _execute(
                conn,
                """
                SELECT status, COUNT(*) AS cnt
                FROM llm_action_audit
                WHERE created_at >= ?
                GROUP BY status
                ORDER BY cnt DESC
                """,
                (cutoff,),
            )
        )
    return [dict(row) if hasattr(row, "keys") else {"status": row[0], "cnt": row[1]} for row in rows]


def llm_skip_reason_counts(hours=24, limit=8):
    cutoff = _utc_cutoff(max(1, int(hours)) * 3600)
    with get_db() as conn:
        rows = _fetchall(
            _execute(
                conn,
                """
                SELECT reason, COUNT(*) AS cnt
                FROM llm_action_audit
                WHERE created_at >= ? AND status='skipped'
                GROUP BY reason
                ORDER BY cnt DESC
                LIMIT ?
                """,
                (cutoff, max(1, min(30, int(limit)))),
            )
        )
    return [dict(row) if hasattr(row, "keys") else {"reason": row[0], "cnt": row[1]} for row in rows]


def reddit_cache_upsert(item):
    with get_db() as conn:
        _execute(
            conn,
            """
            INSERT INTO reddit_ingest_cache(
                content_type, source_id, dedupe_key, subreddit, parent_post_id,
                permalink, author, title, body, media_url, score, created_utc,
                fetched_at, relayed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 0)
            ON CONFLICT(source_id) DO UPDATE SET
                score=excluded.score,
                title=excluded.title,
                body=excluded.body,
                media_url=excluded.media_url,
                fetched_at=CURRENT_TIMESTAMP,
                blocked=0,
                blocked_reason=NULL
            """,
            (
                item.get("content_type"),
                item.get("source_id"),
                item.get("dedupe_key"),
                item.get("subreddit"),
                item.get("parent_post_id"),
                item.get("permalink"),
                item.get("author"),
                item.get("title"),
                item.get("body"),
                item.get("media_url"),
                int(item.get("score") or 0),
                item.get("created_utc"),
            ),
        )


def reddit_unrelayed(limit=10):
    with get_db() as conn:
        rows = _fetchall(
            _execute(
                conn,
                """
                SELECT *
                FROM reddit_ingest_cache
                WHERE relayed=0 AND blocked=0
                ORDER BY score DESC, fetched_at DESC
                LIMIT ?
                """,
                (max(1, min(50, int(limit))),),
            )
        )
    return rows


def reddit_cache_by_id(cache_id):
    with get_db() as conn:
        return _fetchone(_execute(conn, "SELECT * FROM reddit_ingest_cache WHERE id=?", (cache_id,)))


def mark_reddit_relayed(cache_id, message_id=None, thread_id=None):
    with get_db() as conn:
        _execute(
            conn,
            """
            UPDATE reddit_ingest_cache
            SET relayed=1,
                blocked=0,
                blocked_reason=NULL,
                relay_message_id=?,
                relay_thread_id=?,
                relay_at=CURRENT_TIMESTAMP
            WHERE id=?
            """,
            (message_id, thread_id, cache_id),
        )


def mark_reddit_blocked(cache_id, reason):
    with get_db() as conn:
        _execute(
            conn,
            """
            UPDATE reddit_ingest_cache
            SET blocked=1,
                blocked_reason=?,
                relay_at=CURRENT_TIMESTAMP
            WHERE id=?
            """,
            (reason, cache_id),
        )


def clear_reddit_blocked(cache_id):
    with get_db() as conn:
        _execute(
            conn,
            "UPDATE reddit_ingest_cache SET blocked=0, blocked_reason=NULL WHERE id=?",
            (cache_id,),
        )


def list_reddit_cache(
    limit=30,
    offset=0,
    relayed=None,
    blocked=None,
    subreddit=None,
    content_type=None,
    query=None,
    sort_by="fetched_at",
    sort_dir="desc",
):
    sql = "SELECT * FROM reddit_ingest_cache WHERE 1=1"
    args = []
    if relayed is not None:
        sql += " AND relayed=?"
        args.append(1 if bool(relayed) else 0)
    if blocked is not None:
        sql += " AND blocked=?"
        args.append(1 if bool(blocked) else 0)
    if subreddit:
        sql += " AND LOWER(subreddit)=?"
        args.append(str(subreddit).strip().lower())
    if content_type:
        sql += " AND content_type=?"
        args.append(str(content_type).strip().lower())
    if query:
        like = f"%{str(query).strip().lower()}%"
        sql += " AND (LOWER(COALESCE(title, '')) LIKE ? OR LOWER(COALESCE(body, '')) LIKE ? OR LOWER(COALESCE(author, '')) LIKE ?)"
        args.extend([like, like, like])
    allowed_sorts = {
        "id": "id",
        "score": "score",
        "fetched_at": "fetched_at",
        "subreddit": "subreddit",
        "content_type": "content_type",
        "created_utc": "created_utc",
    }
    sort_key = allowed_sorts.get(str(sort_by or "").strip().lower(), "fetched_at")
    sort_order = "ASC" if str(sort_dir or "").strip().lower() == "asc" else "DESC"

    sql += f" ORDER BY {sort_key} {sort_order}, id DESC LIMIT ? OFFSET ?"
    args.extend([max(1, min(200, int(limit))), max(0, int(offset))])

    with get_db() as conn:
        rows = _fetchall(_execute(conn, sql, tuple(args)))
    return rows


def reddit_cache_count(relayed=None, blocked=None, subreddit=None, content_type=None, query=None):
    sql = "SELECT COUNT(*) FROM reddit_ingest_cache WHERE 1=1"
    args = []
    if relayed is not None:
        sql += " AND relayed=?"
        args.append(1 if bool(relayed) else 0)
    if blocked is not None:
        sql += " AND blocked=?"
        args.append(1 if bool(blocked) else 0)
    if subreddit:
        sql += " AND LOWER(subreddit)=?"
        args.append(str(subreddit).strip().lower())
    if content_type:
        sql += " AND content_type=?"
        args.append(str(content_type).strip().lower())
    if query:
        like = f"%{str(query).strip().lower()}%"
        sql += " AND (LOWER(COALESCE(title, '')) LIKE ? OR LOWER(COALESCE(body, '')) LIKE ? OR LOWER(COALESCE(author, '')) LIKE ?)"
        args.extend([like, like, like])

    with get_db() as conn:
        row = _fetchone(_execute(conn, sql, tuple(args)))
    if not row:
        return 0
    if hasattr(row, "get"):
        try:
            return int(row[0])
        except Exception:
            values = list(row.values())
            return int(values[0]) if values else 0
    return int(row[0])


def latest_reddit_cache_activity_at():
    with get_db() as conn:
        row = _fetchone(
            _execute(
                conn,
                "SELECT MAX(fetched_at) FROM reddit_ingest_cache",
            )
        )
    if not row:
        return None
    if hasattr(row, "get"):
        try:
            return row[0]
        except Exception:
            values = list(row.values())
            return values[0] if values else None
    return row[0]


def reddit_subreddit_counts(hours=24):
    cutoff = _utc_cutoff(max(1, int(hours)) * 3600)
    with get_db() as conn:
        rows = _fetchall(
            _execute(
                conn,
                """
                SELECT subreddit, COUNT(*) AS cnt
                FROM reddit_ingest_cache
                WHERE fetched_at >= ?
                GROUP BY subreddit
                ORDER BY cnt DESC
                LIMIT 12
                """,
                (cutoff,),
            )
        )
    return [dict(row) if hasattr(row, "keys") else {"subreddit": row[0], "cnt": row[1]} for row in rows]


def ingestion_runs_window(hours=24, run_type=None):
    cutoff = _utc_cutoff(max(1, int(hours)) * 3600)
    sql = """
        SELECT id, run_type, source_name, source_url, status, fetched_count, saved_count, error, created_at
        FROM ingestion_runs
        WHERE created_at >= ?
    """
    args = [cutoff]
    if run_type and run_type != "all":
        sql += " AND run_type=?"
        args.append(run_type)
    sql += " ORDER BY created_at ASC LIMIT 500"
    with get_db() as conn:
        rows = _fetchall(_execute(conn, sql, tuple(args)))
    return [dict(row) if hasattr(row, "keys") else {
        "id": row[0],
        "run_type": row[1],
        "source_name": row[2],
        "source_url": row[3],
        "status": row[4],
        "fetched_count": row[5],
        "saved_count": row[6],
        "error": row[7],
        "created_at": row[8],
    } for row in rows]


def reddit_cache_stats(hours=24):
    cutoff = _utc_cutoff(max(1, int(hours)) * 3600)
    with get_db() as conn:
        total_row = _fetchone(
            _execute(
                conn,
                "SELECT COUNT(*) FROM reddit_ingest_cache WHERE fetched_at >= ?",
                (cutoff,),
            )
        )
        relayed_row = _fetchone(
            _execute(
                conn,
                "SELECT COUNT(*) FROM reddit_ingest_cache WHERE fetched_at >= ? AND relayed=1",
                (cutoff,),
            )
        )
        type_rows = _fetchall(
            _execute(
                conn,
                """
                SELECT content_type, COUNT(*) AS cnt
                FROM reddit_ingest_cache
                WHERE fetched_at >= ?
                GROUP BY content_type
                ORDER BY cnt DESC
                """,
                (cutoff,),
            )
        )
    if total_row:
        if hasattr(total_row, "get"):
            total_val = total_row.get("count")
            if total_val is None:
                try:
                    total_val = total_row[0]
                except Exception:
                    total_val = 0
            total = int(total_val)
        else:
            total = int(total_row[0])
    else:
        total = 0

    if relayed_row:
        if hasattr(relayed_row, "get"):
            relayed_val = relayed_row.get("count")
            if relayed_val is None:
                try:
                    relayed_val = relayed_row[0]
                except Exception:
                    relayed_val = 0
            relayed = int(relayed_val)
        else:
            relayed = int(relayed_row[0])
    else:
        relayed = 0
    by_type = [dict(row) if hasattr(row, "keys") else {"content_type": row[0], "cnt": row[1]} for row in type_rows]
    return {"total": total, "relayed": relayed, "by_type": by_type}


def latest_dataset_candidate_activity_at(status=None):
    sql = "SELECT MAX(updated_at) FROM dataset_ingest_candidates"
    args = []
    if status:
        sql += " WHERE status=?"
        args.append(str(status).strip().lower())
    with get_db() as conn:
        row = _fetchone(_execute(conn, sql, tuple(args)))
    if not row:
        return None
    if hasattr(row, "get"):
        try:
            return row[0]
        except Exception:
            values = list(row.values())
            return values[0] if values else None
    return row[0]


def dataset_candidate_upsert(item):
    options_json = item.get("options_json")
    if options_json is not None and not isinstance(options_json, str):
        options_json = json.dumps(options_json, ensure_ascii=False)

    source_meta = item.get("source_meta")
    if source_meta is not None and not isinstance(source_meta, str):
        source_meta = json.dumps(source_meta, ensure_ascii=False, sort_keys=True)

    with get_db() as conn:
        _execute(
            conn,
            """
            INSERT INTO dataset_ingest_candidates(
                dataset_name, candidate_key, source_name, source_url, source_tier,
                title, body_text, options_json, answer_text, confidence, status, source_meta, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(candidate_key) DO UPDATE SET
                source_name=excluded.source_name,
                source_url=excluded.source_url,
                source_tier=excluded.source_tier,
                title=excluded.title,
                body_text=excluded.body_text,
                options_json=excluded.options_json,
                answer_text=excluded.answer_text,
                confidence=excluded.confidence,
                source_meta=excluded.source_meta,
                updated_at=CURRENT_TIMESTAMP
            """,
            (
                item.get("dataset_name"),
                item.get("candidate_key"),
                item.get("source_name"),
                item.get("source_url"),
                item.get("source_tier"),
                item.get("title"),
                item.get("body_text"),
                options_json,
                item.get("answer_text"),
                float(item.get("confidence") or 0.0),
                item.get("status") or "candidate",
                source_meta,
            ),
        )


def list_dataset_candidates(dataset_name=None, status=None, limit=50, offset=0):
    sql = "SELECT * FROM dataset_ingest_candidates WHERE 1=1"
    args = []
    if dataset_name:
        sql += " AND dataset_name=?"
        args.append(str(dataset_name).strip().lower())
    if status:
        sql += " AND status=?"
        args.append(str(status).strip().lower())
    sql += " ORDER BY confidence DESC, created_at DESC, id DESC LIMIT ? OFFSET ?"
    args.extend([max(1, min(300, int(limit))), max(0, int(offset))])
    with get_db() as conn:
        rows = _fetchall(_execute(conn, sql, tuple(args)))
    return rows


def dataset_candidates_count(dataset_name=None, status=None):
    sql = "SELECT COUNT(*) FROM dataset_ingest_candidates WHERE 1=1"
    args = []
    if dataset_name:
        sql += " AND dataset_name=?"
        args.append(str(dataset_name).strip().lower())
    if status:
        sql += " AND status=?"
        args.append(str(status).strip().lower())
    with get_db() as conn:
        row = _fetchone(_execute(conn, sql, tuple(args)))
    if not row:
        return 0
    if hasattr(row, "get"):
        try:
            return int(row[0])
        except Exception:
            values = list(row.values())
            return int(values[0]) if values else 0
    return int(row[0])


def get_dataset_candidate(candidate_id):
    with get_db() as conn:
        return _fetchone(_execute(conn, "SELECT * FROM dataset_ingest_candidates WHERE id=?", (candidate_id,)))


def set_dataset_candidate_status(candidate_id, status):
    with get_db() as conn:
        _execute(
            conn,
            "UPDATE dataset_ingest_candidates SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
            (str(status).strip().lower(), candidate_id),
        )


def replace_public_holidays(region, rows):
    clean_region = str(region or "").strip().lower()
    if not clean_region:
        raise ValueError("region is required")
    if not isinstance(rows, list) or not rows:
        return 0

    cleaned = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        holiday_date = str(row.get("holiday_date") or "").strip()
        holiday_name = str(row.get("holiday_name") or "").strip()
        if not holiday_date or not holiday_name:
            continue
        source_name = str(row.get("source_name") or "").strip()
        source_url = str(row.get("source_url") or "").strip()
        source_meta = row.get("source_meta")
        if source_meta is not None and not isinstance(source_meta, str):
            source_meta = json.dumps(source_meta, ensure_ascii=False, sort_keys=True)
        cleaned.append(
            {
                "holiday_date": holiday_date,
                "holiday_name": holiday_name,
                "source_name": source_name,
                "source_url": source_url,
                "source_meta": source_meta,
            }
        )

    if not cleaned:
        return 0

    dates = sorted({row["holiday_date"] for row in cleaned})
    start_date = dates[0]
    end_date = dates[-1]

    with get_db() as conn:
        _execute(
            conn,
            "DELETE FROM public_holidays WHERE region=? AND holiday_date>=? AND holiday_date<=?",
            (clean_region, start_date, end_date),
        )
        for row in cleaned:
            _execute(
                conn,
                """
                INSERT INTO public_holidays(
                    region, holiday_date, holiday_name, source_name, source_url, source_meta, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(region, holiday_date) DO UPDATE SET
                    holiday_name=excluded.holiday_name,
                    source_name=excluded.source_name,
                    source_url=excluded.source_url,
                    source_meta=excluded.source_meta,
                    updated_at=CURRENT_TIMESTAMP
                """,
                (
                    clean_region,
                    row["holiday_date"],
                    row["holiday_name"],
                    row["source_name"],
                    row["source_url"],
                    row["source_meta"],
                ),
            )
    return len(cleaned)


def get_public_holiday(region, holiday_date):
    clean_region = str(region or "").strip().lower()
    date_iso = str(holiday_date or "").strip()
    if not clean_region or not date_iso:
        return None
    with get_db() as conn:
        row = _fetchone(
            _execute(
                conn,
                """
                SELECT id, region, holiday_date, holiday_name, source_name, source_url, source_meta, created_at, updated_at
                FROM public_holidays
                WHERE region=? AND holiday_date=?
                LIMIT 1
                """,
                (clean_region, date_iso),
            )
        )
    if not row:
        return None
    payload = dict(row) if hasattr(row, "keys") else {
        "id": row[0],
        "region": row[1],
        "holiday_date": row[2],
        "holiday_name": row[3],
        "source_name": row[4],
        "source_url": row[5],
        "source_meta": row[6],
        "created_at": row[7],
        "updated_at": row[8],
    }
    raw_meta = payload.get("source_meta")
    if isinstance(raw_meta, str) and raw_meta.strip():
        try:
            payload["source_meta"] = json.loads(raw_meta)
        except Exception:
            payload["source_meta"] = {}
    elif raw_meta is None:
        payload["source_meta"] = {}
    return payload


def list_public_holidays(region=None, year=None, limit=120, offset=0):
    sql = """
        SELECT id, region, holiday_date, holiday_name, source_name, source_url, source_meta, created_at, updated_at
        FROM public_holidays
        WHERE 1=1
    """
    args = []
    if region:
        sql += " AND region=?"
        args.append(str(region).strip().lower())
    if year:
        year_text = str(year).strip()
        if year_text.isdigit() and len(year_text) == 4:
            sql += " AND holiday_date LIKE ?"
            args.append(f"{year_text}-%")

    sql += " ORDER BY holiday_date ASC LIMIT ? OFFSET ?"
    args.extend([max(1, min(366, int(limit))), max(0, int(offset))])

    with get_db() as conn:
        rows = _fetchall(_execute(conn, sql, tuple(args)))

    out = []
    for row in rows:
        payload = dict(row) if hasattr(row, "keys") else {
            "id": row[0],
            "region": row[1],
            "holiday_date": row[2],
            "holiday_name": row[3],
            "source_name": row[4],
            "source_url": row[5],
            "source_meta": row[6],
            "created_at": row[7],
            "updated_at": row[8],
        }
        raw_meta = payload.get("source_meta")
        if isinstance(raw_meta, str) and raw_meta.strip():
            try:
                payload["source_meta"] = json.loads(raw_meta)
            except Exception:
                payload["source_meta"] = {}
        elif raw_meta is None:
            payload["source_meta"] = {}
        out.append(payload)
    return out


def count_public_holidays(region=None, year=None):
    sql = "SELECT COUNT(*) FROM public_holidays WHERE 1=1"
    args = []
    if region:
        sql += " AND region=?"
        args.append(str(region).strip().lower())
    if year:
        year_text = str(year).strip()
        if year_text.isdigit() and len(year_text) == 4:
            sql += " AND holiday_date LIKE ?"
            args.append(f"{year_text}-%")

    with get_db() as conn:
        row = _fetchone(_execute(conn, sql, tuple(args)))
    if not row:
        return 0
    if hasattr(row, "get"):
        try:
            return int(row[0])
        except Exception:
            values = list(row.values())
            return int(values[0]) if values else 0
    return int(row[0])