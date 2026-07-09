import os
import json
from dotenv import load_dotenv

load_dotenv()


def _required_env(name):
    value = os.getenv(name)
    if value is None or not str(value).strip():
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value.strip()


def _required_int_env(name):
    raw = _required_env(name)
    try:
        return int(raw)
    except (TypeError, ValueError) as exc:
        raise RuntimeError(f"Environment variable {name} must be an integer, got: {raw!r}") from exc


def _parse_json_env(name):
    raw = os.getenv(name, "").strip()
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def _as_bool(value, default):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def _as_int(value, default):
    try:
        return int(value)
    except Exception:
        return default


def _as_float(value, default):
    try:
        return float(value)
    except Exception:
        return default


def _as_str(value, default):
    if value is None:
        return default
    out = str(value).strip()
    return out if out else default


# Optional compact JSON block for event pipeline settings.
# Legacy env keys still take precedence for backwards compatibility.
EVENT_PIPELINE = _parse_json_env("EVENT_PIPELINE")


def _event_setting(name, env_name, default, cast):
    legacy_raw = os.getenv(env_name)
    if legacy_raw is not None:
        return cast(legacy_raw, default)
    return cast(EVENT_PIPELINE.get(name), default)


BOT_TOKEN = _required_env("BOT_TOKEN")
GROUP_ID = _required_int_env("GROUP_ID")
EXIT_ON_TELEGRAM_CONFLICT = os.getenv("EXIT_ON_TELEGRAM_CONFLICT", "true").lower() == "true"

REDDIT_CLIENT_ID = os.getenv("REDDIT_CLIENT_ID")
REDDIT_CLIENT_SECRET = os.getenv("REDDIT_CLIENT_SECRET")
REDDIT_USER_AGENT = os.getenv("REDDIT_USER_AGENT")

USE_REDDIT = os.getenv("USE_REDDIT", "true").lower() == "true"
MEME_PROVIDER_PRIORITY = [
    p.strip().lower() for p in os.getenv("MEME_PROVIDER_PRIORITY", "imgflip,reddit").split(",") if p.strip()
]
REDDIT_INGEST_ENABLED = os.getenv("REDDIT_INGEST_ENABLED", "true").lower() == "true"
REDDIT_RELAY_ENABLED = os.getenv("REDDIT_RELAY_ENABLED", "true").lower() == "true"
REDDIT_SUBREDDITS = [
    s.strip() for s in os.getenv("REDDIT_SUBREDDITS", "StarWars,StarWarsMemes,PrequelMemes,sequelmemes").split(",") if s.strip()
]
REDDIT_POST_LIMIT = int(os.getenv("REDDIT_POST_LIMIT", 20))
REDDIT_COMMENTS_PER_POST = int(os.getenv("REDDIT_COMMENTS_PER_POST", 2))
REDDIT_MIN_POST_SCORE = int(os.getenv("REDDIT_MIN_POST_SCORE", 30))
REDDIT_MIN_COMMENT_SCORE = int(os.getenv("REDDIT_MIN_COMMENT_SCORE", 8))
REDDIT_INGEST_INTERVAL_MINUTES = int(os.getenv("REDDIT_INGEST_INTERVAL_MINUTES", 30))
REDDIT_RELAY_INTERVAL_MINUTES = int(os.getenv("REDDIT_RELAY_INTERVAL_MINUTES", 45))
REDDIT_RELAY_BATCH_SIZE = int(os.getenv("REDDIT_RELAY_BATCH_SIZE", 4))
REDDIT_RELAY_THREAD = os.getenv("REDDIT_RELAY_THREAD", "memes").strip().lower()
REDDIT_BANNED_SUBREDDITS = {
    s.strip().lower()
    for s in os.getenv("REDDIT_BANNED_SUBREDDITS", "").split(",")
    if s.strip()
}
REDDIT_BANNED_WORDS = [
    w.strip().lower()
    for w in os.getenv("REDDIT_BANNED_WORDS", "").split(",")
    if w.strip()
]

DAILY_MIN_POSTS = int(os.getenv("DAILY_MIN_POSTS", 30))
DAILY_MAX_POSTS = int(os.getenv("DAILY_MAX_POSTS", 45))
MAX_PER_TOPIC_PER_DAY = int(os.getenv("MAX_PER_TOPIC_PER_DAY", 10))
MIN_GAP_MINUTES = int(os.getenv("MIN_GAP_MINUTES", 2))
INITIAL_POST_WINDOW_MINUTES = int(os.getenv("INITIAL_POST_WINDOW_MINUTES", 15))
POSTING_WINDOW_ENABLED = os.getenv("POSTING_WINDOW_ENABLED", "true").lower() == "true"
POSTING_WINDOW_START_HOUR = int(os.getenv("POSTING_WINDOW_START_HOUR", 8))
POSTING_WINDOW_START_MINUTE = int(os.getenv("POSTING_WINDOW_START_MINUTE", 0))
POSTING_WINDOW_END_HOUR = int(os.getenv("POSTING_WINDOW_END_HOUR", 1))
POSTING_WINDOW_END_MINUTE = int(os.getenv("POSTING_WINDOW_END_MINUTE", 0))
POSTING_WINDOW_TIMEZONE = os.getenv("POSTING_WINDOW_TIMEZONE", "Asia/Hong_Kong").strip() or "Asia/Hong_Kong"
STARTUP_RECOVERY_ENABLED = os.getenv("STARTUP_RECOVERY_ENABLED", "true").lower() == "true"
STARTUP_RECOVERY_HOURS = float(os.getenv("STARTUP_RECOVERY_HOURS", 0.5))
GREETING_ENABLED = os.getenv("GREETING_ENABLED", "true").lower() == "true"
GREETING_UTC_HOUR = int(os.getenv("GREETING_UTC_HOUR", 1))
GREETING_UTC_MINUTE = int(os.getenv("GREETING_UTC_MINUTE", 30))
SATURDAY_POST_MULTIPLIER = float(os.getenv("SATURDAY_POST_MULTIPLIER", 1.5))
STAR_WARS_DAY_POST_MULTIPLIER = float(os.getenv("STAR_WARS_DAY_POST_MULTIPLIER", 2.5))

WALLPAPER_PROVIDER_PRIORITY = [
    p.strip().lower()
    for p in os.getenv("WALLPAPER_PROVIDER_PRIORITY", "wallhaven,pinterest,instagram").split(",")
    if p.strip()
]
PINTEREST_WALLPAPER_FEEDS = [
    v.strip()
    for v in os.getenv("PINTEREST_WALLPAPER_FEEDS", "").split(",")
    if v.strip()
]
INSTAGRAM_WALLPAPER_FEEDS = [
    v.strip()
    for v in os.getenv("INSTAGRAM_WALLPAPER_FEEDS", "").split(",")
    if v.strip()
]
WALLPAPER_FEED_FETCH_LIMIT = int(os.getenv("WALLPAPER_FEED_FETCH_LIMIT", 30))

POST_BOOST_ENABLED = os.getenv("POST_BOOST_ENABLED", "true").lower() == "true"
POST_BOOST_TOPIC_CAP_MULTIPLIER = float(os.getenv("POST_BOOST_TOPIC_CAP_MULTIPLIER", 3.0))
_holidays_raw = os.getenv("HK_PUBLIC_HOLIDAYS", "")
HK_PUBLIC_HOLIDAYS = {
    v.strip() for v in _holidays_raw.split(",") if v.strip()
}

ENABLE_EVENT_INGESTION = _event_setting("enable_ingestion", "ENABLE_EVENT_INGESTION", True, _as_bool)
AUTO_PUBLISH_THRESHOLD = _event_setting("auto_publish_threshold", "AUTO_PUBLISH_THRESHOLD", 0.90, _as_float)
MIN_REVIEW_THRESHOLD = _event_setting("min_review_threshold", "MIN_REVIEW_THRESHOLD", 0.65, _as_float)
RELEASE_TIMEZONE = _event_setting("release_timezone", "RELEASE_TIMEZONE", "Asia/Hong_Kong", _as_str)

EVENT_INGEST_HOURS = _event_setting("ingest_hours", "EVENT_INGEST_HOURS", 12, _as_int)
DAILY_EVENT_DIGEST_UTC_HOUR = _event_setting("digest_utc_hour", "DAILY_EVENT_DIGEST_UTC_HOUR", 11, _as_int)
DAILY_EVENT_DIGEST_UTC_MINUTE = _event_setting("digest_utc_minute", "DAILY_EVENT_DIGEST_UTC_MINUTE", 0, _as_int)

ENABLE_SOURCE_COMPLIANCE = _event_setting("enable_source_compliance", "ENABLE_SOURCE_COMPLIANCE", True, _as_bool)
REQUIRE_ROBOTS_FOR_SCRAPE = _event_setting("require_robots_for_scrape", "REQUIRE_ROBOTS_FOR_SCRAPE", True, _as_bool)
REQUIRE_TOS_ALLOWLIST_FOR_SCRAPE = _event_setting("require_tos_allowlist_for_scrape", "REQUIRE_TOS_ALLOWLIST_FOR_SCRAPE", True, _as_bool)

OFFICIAL_SOURCE_ALLOWLIST = _event_setting("official_source_allowlist", "OFFICIAL_SOURCE_ALLOWLIST", "starwars.com,news.google.com", _as_str)
RSS_SOURCE_ALLOWLIST = _event_setting("rss_source_allowlist", "RSS_SOURCE_ALLOWLIST", "starwars.com,news.google.com,scmp.com,hongkongfp.com", _as_str)
API_SOURCE_ALLOWLIST = _event_setting("api_source_allowlist", "API_SOURCE_ALLOWLIST", "", _as_str)
SCRAPE_SOURCE_ALLOWLIST = _event_setting("scrape_source_allowlist", "SCRAPE_SOURCE_ALLOWLIST", "wookieepedia.com,starwars.fandom.com,starwars.com", _as_str)
SCRAPE_TOS_ALLOWLIST = _event_setting("scrape_tos_allowlist", "SCRAPE_TOS_ALLOWLIST", "wookieepedia.com,starwars.fandom.com,starwars.com", _as_str)

INGEST_FEED_LIMIT = _event_setting("ingest_feed_limit", "INGEST_FEED_LIMIT", 30, _as_int)
INGEST_API_LIMIT = _event_setting("ingest_api_limit", "INGEST_API_LIMIT", 40, _as_int)
INGEST_SCRAPE_LIMIT = _event_setting("ingest_scrape_limit", "INGEST_SCRAPE_LIMIT", 60, _as_int)
HK_ENABLE_ZH = _event_setting("hk_enable_zh", "HK_ENABLE_ZH", True, _as_bool)

DATASET_COLLECTORS_ENABLED = os.getenv("DATASET_COLLECTORS_ENABLED", "true").lower() == "true"
DATASET_COLLECTOR_INTERVAL_MINUTES = int(os.getenv("DATASET_COLLECTOR_INTERVAL_MINUTES", 180))
DATASET_COLLECTOR_SOURCE_LIMIT = int(os.getenv("DATASET_COLLECTOR_SOURCE_LIMIT", 20))

LLM_ENABLED = os.getenv("LLM_ENABLED", "true").lower() == "true"
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "openrouter").strip().lower()
LLM_MODEL = os.getenv("LLM_MODEL", "meta-llama/llama-3.1-8b-instruct:free").strip()
LLM_API_KEY = os.getenv("LLM_API_KEY", "").strip()
LLM_API_BASE_URL = os.getenv("LLM_API_BASE_URL", "").strip()
LLM_TIMEOUT_SECONDS = int(os.getenv("LLM_TIMEOUT_SECONDS", 10))
LLM_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", 500))
LLM_TEMPERATURE = float(os.getenv("LLM_TEMPERATURE", 0.85))
LLM_AUTONOMOUS_MODE = os.getenv("LLM_AUTONOMOUS_MODE", "true").lower() == "true"
LLM_REPLY_DAILY_CAP = int(os.getenv("LLM_REPLY_DAILY_CAP", 40))
# Deprecated: retained for backward compatibility only. Thread-level hard caps are no longer enforced.
LLM_REPLY_THREAD_DAILY_CAP = int(os.getenv("LLM_REPLY_THREAD_DAILY_CAP", 500))
LLM_REPLY_COOLDOWN_SECONDS = int(os.getenv("LLM_REPLY_COOLDOWN_SECONDS", 30))
LLM_RANDOM_REPLY_CHANCE = float(os.getenv("LLM_RANDOM_REPLY_CHANCE", 0.85))
LLM_MIN_TRIGGER_SCORE = float(os.getenv("LLM_MIN_TRIGGER_SCORE", 0.5))
LLM_MAX_INPUT_CHARS = int(os.getenv("LLM_MAX_INPUT_CHARS", 1000))
LLM_THREAD_SCOPE_MODE = os.getenv("LLM_THREAD_SCOPE_MODE", "allowlist").strip().lower() or "allowlist"
LLM_ALLOWED_THREAD_NAMES = {
    v.strip().lower()
    for v in os.getenv("LLM_ALLOWED_THREAD_NAMES", "general,memes,lore,movie,show").split(",")
    if v.strip()
}
LLM_DENIED_THREAD_NAMES = {
    v.strip().lower()
    for v in os.getenv("LLM_DENIED_THREAD_NAMES", "").split(",")
    if v.strip()
}
LLM_DENIED_THREAD_IDS = {
    int(v.strip())
    for v in os.getenv("LLM_DENIED_THREAD_IDS", "").split(",")
    if v.strip().lstrip("-").isdigit()
}

_admin_raw = os.getenv("ADMIN_USER_IDS", "")
ADMIN_USER_IDS = {
    int(v.strip()) for v in _admin_raw.split(",") if v.strip().lstrip("-").isdigit()
}

# Format: "tier|kind|name|url" entries separated by semicolons
# tier: official|api|rss|scrape
# kind: event|news
HK_SOURCE_CONFIG = os.getenv(
    "HK_SOURCE_CONFIG",
    "official|event|GoogleNews HK Events EN|https://news.google.com/rss/search?q=star+wars+hong+kong+events&hl=en-HK&gl=HK&ceid=HK:en;"
    "rss|event|GoogleNews HK Fan Meetup EN|https://news.google.com/rss/search?q=star+wars+hong+kong+fan+meetup&hl=en-HK&gl=HK&ceid=HK:en;"
    "rss|event|GoogleNews HK Star Wars Exhibition EN|https://news.google.com/rss/search?q=star+wars+hong+kong+exhibition&hl=en-HK&gl=HK&ceid=HK:en;"
    "rss|event|GoogleNews HK Star Wars Cosplay EN|https://news.google.com/rss/search?q=star+wars+hong+kong+cosplay+event&hl=en-HK&gl=HK&ceid=HK:en;"
    "rss|event|GoogleNews HK Star Wars ZH|https://news.google.com/rss/search?q=%E6%98%9F%E9%9A%9B%E5%A4%A7%E6%88%B0+%E9%A6%99%E6%B8%AF+%E6%B4%BB%E5%8B%95&hl=zh-HK&gl=HK&ceid=HK:zh-Hant|locale=zh-hant;"
    "rss|news|SCMP Hong Kong|https://www.scmp.com/rss/2/feed|locale=en;"
    "rss|news|HKFP Hong Kong|https://hongkongfp.com/feed/|locale=en;"
    "scrape|event|StarWars.com Events Category|https://www.starwars.com/news/category/events|parser=starwars_tag,locale=en",
)

GLOBAL_SOURCE_CONFIG = os.getenv(
    "GLOBAL_SOURCE_CONFIG",
    "official|news|StarWars.com News|https://www.starwars.com/news/feed;"
    "scrape|event|StarWars.com Events Category|https://www.starwars.com/news/category/events|parser=starwars_tag,locale=en;"
    "rss|news|GoogleNews Star Wars Games|https://news.google.com/rss/search?q=star+wars+new+game+release&hl=en-US&gl=US&ceid=US:en;"
    "rss|news|GoogleNews Star Wars TV|https://news.google.com/rss/search?q=star+wars+new+series+release&hl=en-US&gl=US&ceid=US:en;"
    "rss|news|GoogleNews Star Wars Movies|https://news.google.com/rss/search?q=star+wars+new+movie+release&hl=en-US&gl=US&ceid=US:en;"
    "rss|event|GoogleNews Star Wars Convention|https://news.google.com/rss/search?q=star+wars+convention+celebration+events&hl=en-US&gl=US&ceid=US:en;"
    "rss|event|GoogleNews Star Wars Fan Event|https://news.google.com/rss/search?q=star+wars+fan+event+tickets&hl=en-US&gl=US&ceid=US:en;"
    "rss|event|GoogleNews Star Wars Live Event|https://news.google.com/rss/search?q=star+wars+live+event+announcement&hl=en-US&gl=US&ceid=US:en",
)

# Format: "dataset|tier|name|url|k=v,k=v" entries separated by semicolons
# dataset: facts|quotes|trivia|polls|discussions
# tier: rss|api|scrape
DATASET_SOURCE_CONFIG = os.getenv(
    "DATASET_SOURCE_CONFIG",
    "facts|rss|StarWars News Feed Facts|https://www.starwars.com/news/feed|locale=en;"
    "quotes|scrape|StarWars Quote Sources|https://www.starwars.com/news|locale=en,parser=starwars_news_quotes;"
    "trivia|scrape|StarWars Databank Trivia|https://www.starwars.com/databank|locale=en,parser=starwars_databank;"
    "trivia|rss|GoogleNews Star Wars Trivia Quiz|https://news.google.com/rss/search?q=star+wars+trivia+quiz&hl=en-US&gl=US&ceid=US:en|locale=en;"
    "trivia|rss|GoogleNews Star Wars Facts Quiz|https://news.google.com/rss/search?q=star+wars+facts+quiz&hl=en-US&gl=US&ceid=US:en|locale=en;"
    "polls|rss|StarWars News Poll Prompts|https://www.starwars.com/news/feed|locale=en;"
    "discussions|rss|StarWars News Discussion Prompts|https://www.starwars.com/news/feed|locale=en",
)

THREADS = {
    "chat": int(os.getenv("THREAD_CHAT", 0)),
    "lore": int(os.getenv("THREAD_LORE", 0)),
    "memes": int(os.getenv("THREAD_MEMES", 0)),
    "wallpapers": int(os.getenv("THREAD_WALLPAPERS", 0)),
    "movie": int(os.getenv("THREAD_MOVIE", 0)),
    "show": int(os.getenv("THREAD_SHOW", 0)),
    "general": int(os.getenv("THREAD_GENERAL", 0)),
    "events": int(os.getenv("THREAD_EVENTS", os.getenv("THREAD_GENERAL", 0))),
}


def get_thread_id(name):
    value = THREADS.get(name, 0)
    try:
        value = int(value)
    except Exception:
        return None
    return value if value > 0 else None


def get_chat_thread_id():
    # Keep non-event fallback away from the events thread.
    return (
        get_thread_id("chat")
        or get_thread_id("lore")
        or get_thread_id("general")
    )


def parse_source_meta(meta_raw):
    if not meta_raw:
        return {}
    out = {}
    for chunk in str(meta_raw).split(","):
        part = chunk.strip()
        if not part or "=" not in part:
            continue
        key, value = part.split("=", 1)
        out[key.strip().lower()] = value.strip()
    return out


def parse_sources(raw_value):
    out = []
    for chunk in raw_value.split(";"):
        part = chunk.strip()
        if not part:
            continue
        bits = [p.strip() for p in part.split("|")]
        if len(bits) < 4:
            continue
        tier, kind, name, url = bits[:4]
        meta_raw = bits[4] if len(bits) > 4 else ""
        out.append(
            {
                "tier": tier.lower(),
                "kind": kind.lower(),
                "name": name,
                "url": url,
                "meta": parse_source_meta(meta_raw),
            }
        )
    return out


def parse_dataset_sources(raw_value):
    out = []
    for chunk in raw_value.split(";"):
        part = chunk.strip()
        if not part:
            continue
        bits = [p.strip() for p in part.split("|")]
        if len(bits) < 4:
            continue
        dataset, tier, name, url = bits[:4]
        meta_raw = bits[4] if len(bits) > 4 else ""
        out.append(
            {
                "dataset": dataset.lower(),
                "tier": tier.lower(),
                "name": name,
                "url": url,
                "meta": parse_source_meta(meta_raw),
            }
        )
    return out


def parse_csv_set(raw_value):
    return {v.strip().lower() for v in raw_value.split(",") if v.strip()}


HK_SOURCES = parse_sources(HK_SOURCE_CONFIG)
GLOBAL_SOURCES = parse_sources(GLOBAL_SOURCE_CONFIG)
DATASET_SOURCES = parse_dataset_sources(DATASET_SOURCE_CONFIG)

if not HK_ENABLE_ZH:
    HK_SOURCES = [
        s
        for s in HK_SOURCES
        if not str((s.get("meta") or {}).get("locale", "")).lower().startswith("zh")
    ]

SOURCE_ALLOWLISTS = {
    "official": parse_csv_set(OFFICIAL_SOURCE_ALLOWLIST),
    "rss": parse_csv_set(RSS_SOURCE_ALLOWLIST),
    "api": parse_csv_set(API_SOURCE_ALLOWLIST),
    "scrape": parse_csv_set(SCRAPE_SOURCE_ALLOWLIST),
}

SCRAPE_TOS_ALLOWLIST_SET = parse_csv_set(SCRAPE_TOS_ALLOWLIST)

ADMIN_UI_ENABLED = os.getenv("ADMIN_UI_ENABLED", "true").lower() == "true"
ADMIN_UI_HOST = os.getenv("ADMIN_UI_HOST", "0.0.0.0")
ADMIN_UI_PORT = int(os.getenv("ADMIN_UI_PORT", 8088))
ADMIN_UI_ACCESS_TOKEN = os.getenv("ADMIN_UI_ACCESS_TOKEN", "")
ADMIN_UI_SECRET_KEY = os.getenv("ADMIN_UI_SECRET_KEY", "change-me-in-env")
ADMIN_UI_SESSION_HOURS = int(os.getenv("ADMIN_UI_SESSION_HOURS", 12))
ADMIN_UI_COOKIE_SECURE = os.getenv("ADMIN_UI_COOKIE_SECURE", "false").lower() == "true"
ADMIN_UI_ALLOWED_HOSTS = {
    v.strip().lower()
    for v in os.getenv("ADMIN_UI_ALLOWED_HOSTS", "*").split(",")
    if v.strip()
}
ADMIN_UI_IP_ALLOWLIST = {
    v.strip()
    for v in os.getenv("ADMIN_UI_IP_ALLOWLIST", "").split(",")
    if v.strip()
}
ADMIN_UI_MAX_LOGIN_ATTEMPTS = int(os.getenv("ADMIN_UI_MAX_LOGIN_ATTEMPTS", 5))
ADMIN_UI_LOGIN_WINDOW_MINUTES = int(os.getenv("ADMIN_UI_LOGIN_WINDOW_MINUTES", 10))
ADMIN_UI_LOGIN_LOCKOUT_MINUTES = int(os.getenv("ADMIN_UI_LOGIN_LOCKOUT_MINUTES", 20))
ADMIN_UI_BIND_SESSION_IP = os.getenv("ADMIN_UI_BIND_SESSION_IP", "false").lower() == "true"
ADMIN_EMERGENCY_ALERT_HOURS = float(os.getenv("ADMIN_EMERGENCY_ALERT_HOURS", 6))
SMTP_HOST = os.getenv("SMTP_HOST", "").strip()
SMTP_PORT = int(os.getenv("SMTP_PORT", 587))
SMTP_USERNAME = os.getenv("SMTP_USERNAME", "").strip()
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "").strip()
SMTP_USE_TLS = os.getenv("SMTP_USE_TLS", "true").lower() == "true"
SMTP_FROM_EMAIL = os.getenv("SMTP_FROM_EMAIL", "").strip()
SMTP_FROM_NAME = os.getenv("SMTP_FROM_NAME", "Star Wars Bot").strip()