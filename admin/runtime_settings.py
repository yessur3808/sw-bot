import json

import config
import db


SETTING_TYPES = {
    "enable_event_ingestion": "bool",
    "auto_publish_threshold": "float",
    "min_review_threshold": "float",
    "event_ingest_hours": "int",
    "ingest_feed_limit": "int",
    "ingest_api_limit": "int",
    "ingest_scrape_limit": "int",
    "release_timezone": "str",
    "official_source_allowlist": "str",
    "rss_source_allowlist": "str",
    "api_source_allowlist": "str",
    "scrape_source_allowlist": "str",
    "scrape_tos_allowlist": "str",
    "enable_llm_autonomy": "bool",
    "llm_reply_daily_cap": "int",
    "llm_reply_cooldown_seconds": "int",
    "llm_random_reply_chance": "float",
    "llm_min_trigger_score": "float",
    "llm_max_input_chars": "int",
    "llm_thread_scope_mode": "str",
    "llm_denied_thread_names": "str",
    "llm_denied_thread_ids": "str",
    "enable_reddit_ingest": "bool",
    "enable_reddit_relay": "bool",
    "reddit_post_limit": "int",
    "reddit_comments_per_post": "int",
    "reddit_min_post_score": "int",
    "reddit_min_comment_score": "int",
    "reddit_relay_batch_size": "int",
    "reddit_banned_subreddits": "str",
    "reddit_banned_words": "str",
    "enable_dataset_collectors": "bool",
    "dataset_collector_interval_minutes": "int",
    "dataset_collector_source_limit": "int",
}


SETTING_DEFAULTS = {
    "enable_event_ingestion": config.ENABLE_EVENT_INGESTION,
    "auto_publish_threshold": config.AUTO_PUBLISH_THRESHOLD,
    "min_review_threshold": config.MIN_REVIEW_THRESHOLD,
    "event_ingest_hours": config.EVENT_INGEST_HOURS,
    "ingest_feed_limit": config.INGEST_FEED_LIMIT,
    "ingest_api_limit": config.INGEST_API_LIMIT,
    "ingest_scrape_limit": config.INGEST_SCRAPE_LIMIT,
    "release_timezone": config.RELEASE_TIMEZONE,
    "official_source_allowlist": config.OFFICIAL_SOURCE_ALLOWLIST,
    "rss_source_allowlist": config.RSS_SOURCE_ALLOWLIST,
    "api_source_allowlist": config.API_SOURCE_ALLOWLIST,
    "scrape_source_allowlist": config.SCRAPE_SOURCE_ALLOWLIST,
    "scrape_tos_allowlist": config.SCRAPE_TOS_ALLOWLIST,
    "enable_llm_autonomy": config.LLM_AUTONOMOUS_MODE,
    "llm_reply_daily_cap": config.LLM_REPLY_DAILY_CAP,
    "llm_reply_cooldown_seconds": config.LLM_REPLY_COOLDOWN_SECONDS,
    "llm_random_reply_chance": config.LLM_RANDOM_REPLY_CHANCE,
    "llm_min_trigger_score": config.LLM_MIN_TRIGGER_SCORE,
    "llm_max_input_chars": config.LLM_MAX_INPUT_CHARS,
    "llm_thread_scope_mode": config.LLM_THREAD_SCOPE_MODE,
    "llm_denied_thread_names": ",".join(sorted(config.LLM_DENIED_THREAD_NAMES)),
    "llm_denied_thread_ids": ",".join(str(v) for v in sorted(config.LLM_DENIED_THREAD_IDS)),
    "enable_reddit_ingest": config.REDDIT_INGEST_ENABLED,
    "enable_reddit_relay": config.REDDIT_RELAY_ENABLED,
    "reddit_post_limit": config.REDDIT_POST_LIMIT,
    "reddit_comments_per_post": config.REDDIT_COMMENTS_PER_POST,
    "reddit_min_post_score": config.REDDIT_MIN_POST_SCORE,
    "reddit_min_comment_score": config.REDDIT_MIN_COMMENT_SCORE,
    "reddit_relay_batch_size": config.REDDIT_RELAY_BATCH_SIZE,
    "reddit_banned_subreddits": ",".join(sorted(config.REDDIT_BANNED_SUBREDDITS)),
    "reddit_banned_words": ",".join(config.REDDIT_BANNED_WORDS),
    "enable_dataset_collectors": config.DATASET_COLLECTORS_ENABLED,
    "dataset_collector_interval_minutes": config.DATASET_COLLECTOR_INTERVAL_MINUTES,
    "dataset_collector_source_limit": config.DATASET_COLLECTOR_SOURCE_LIMIT,
}


def _as_bool(value):
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def _cast_value(setting_key, raw):
    kind = SETTING_TYPES.get(setting_key, "str")
    if kind == "bool":
        return _as_bool(raw)
    if kind == "int":
        try:
            return int(raw)
        except Exception:
            return int(SETTING_DEFAULTS.get(setting_key, 0))
    if kind == "float":
        try:
            return float(raw)
        except Exception:
            return float(SETTING_DEFAULTS.get(setting_key, 0.0))
    return str(raw)


def get(setting_key):
    default_value = SETTING_DEFAULTS.get(setting_key)
    raw = db.get_runtime_setting(setting_key, default_value)
    return _cast_value(setting_key, raw)


def set_many(items, updated_by=None):
    for key, value in items.items():
        if key not in SETTING_DEFAULTS:
            continue
        db.upsert_runtime_setting(key, value, updated_by=updated_by)


def export_runtime_settings():
    rows = db.list_runtime_settings()
    current = {k: SETTING_DEFAULTS[k] for k in SETTING_DEFAULTS}
    for row in rows:
        key = row.get("setting_key") if hasattr(row, "get") else row[0]
        value = row.get("setting_value") if hasattr(row, "get") else row[1]
        if key in current:
            current[key] = _cast_value(key, value)
    return current


def _normalize_source(raw, idx):
    return {
        "tier": str(raw.get("tier") or "rss").strip().lower(),
        "kind": str(raw.get("kind") or "event").strip().lower(),
        "name": str(raw.get("name") or f"source-{idx + 1}").strip(),
        "url": str(raw.get("url") or "").strip(),
        "meta": raw.get("meta") or {},
        "enabled": bool(raw.get("enabled", True)),
        "position": int(raw.get("position", idx)),
    }


def get_sources(run_type):
    overrides = db.list_source_overrides(run_type)
    if overrides:
        out = []
        for row in overrides:
            if int(row.get("is_enabled", 1) or 0) != 1:
                continue
            out.append(
                {
                    "tier": row.get("source_tier"),
                    "kind": row.get("source_kind"),
                    "name": row.get("source_name"),
                    "url": row.get("source_url"),
                    "meta": row.get("source_meta") or {},
                }
            )
        return out
    if run_type == "hk":
        return config.HK_SOURCES
    return config.GLOBAL_SOURCES


def set_sources(run_type, sources, updated_by=None):
    normalized = [_normalize_source(item, idx) for idx, item in enumerate(sources)]
    db.replace_source_overrides(run_type, normalized, updated_by=updated_by)


def source_overrides_for_ui(run_type):
    rows = db.list_source_overrides(run_type)
    if rows:
        return [
            {
                "tier": row.get("source_tier"),
                "kind": row.get("source_kind"),
                "name": row.get("source_name"),
                "url": row.get("source_url"),
                "meta": row.get("source_meta") or {},
                "enabled": bool(row.get("is_enabled", 1)),
                "position": int(row.get("position", 0)),
            }
            for row in rows
        ]
    defaults = config.HK_SOURCES if run_type == "hk" else config.GLOBAL_SOURCES
    return [
        {
            "tier": s.get("tier"),
            "kind": s.get("kind"),
            "name": s.get("name"),
            "url": s.get("url"),
            "meta": s.get("meta") or {},
            "enabled": True,
            "position": idx,
        }
        for idx, s in enumerate(defaults)
    ]


def parse_source_text(raw_text):
    sources = []
    for idx, line in enumerate(str(raw_text or "").splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except Exception:
            continue
        sources.append(_normalize_source(item, idx))
    return sources
