import os
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


BOT_TOKEN = _required_env("BOT_TOKEN")
GROUP_ID = _required_int_env("GROUP_ID")

REDDIT_CLIENT_ID = os.getenv("REDDIT_CLIENT_ID")
REDDIT_CLIENT_SECRET = os.getenv("REDDIT_CLIENT_SECRET")
REDDIT_USER_AGENT = os.getenv("REDDIT_USER_AGENT")

USE_REDDIT = os.getenv("USE_REDDIT", "true").lower() == "true"
MEME_PROVIDER_PRIORITY = [
    p.strip().lower() for p in os.getenv("MEME_PROVIDER_PRIORITY", "imgflip,reddit").split(",") if p.strip()
]
REDDIT_INGEST_ENABLED = os.getenv("REDDIT_INGEST_ENABLED", "false").lower() == "true"
REDDIT_RELAY_ENABLED = os.getenv("REDDIT_RELAY_ENABLED", "false").lower() == "true"
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

DAILY_MIN_POSTS = int(os.getenv("DAILY_MIN_POSTS", 4))
DAILY_MAX_POSTS = int(os.getenv("DAILY_MAX_POSTS", 8))
MAX_PER_TOPIC_PER_DAY = int(os.getenv("MAX_PER_TOPIC_PER_DAY", 2))
MIN_GAP_MINUTES = int(os.getenv("MIN_GAP_MINUTES", 60))
STARTUP_RECOVERY_ENABLED = os.getenv("STARTUP_RECOVERY_ENABLED", "true").lower() == "true"
STARTUP_RECOVERY_HOURS = float(os.getenv("STARTUP_RECOVERY_HOURS", 4))
GREETING_ENABLED = os.getenv("GREETING_ENABLED", "true").lower() == "true"
GREETING_UTC_HOUR = int(os.getenv("GREETING_UTC_HOUR", 1))
GREETING_UTC_MINUTE = int(os.getenv("GREETING_UTC_MINUTE", 30))

POST_BOOST_ENABLED = os.getenv("POST_BOOST_ENABLED", "true").lower() == "true"
POST_BOOST_MULTIPLIER = float(os.getenv("POST_BOOST_MULTIPLIER", 3.0))
POST_BOOST_TOPIC_CAP_MULTIPLIER = float(os.getenv("POST_BOOST_TOPIC_CAP_MULTIPLIER", 3.0))
BOOST_FRIDAY_EVENING_EXTRA = int(os.getenv("BOOST_FRIDAY_EVENING_EXTRA", 1))
BOOST_WEEKEND_EXTRA = int(os.getenv("BOOST_WEEKEND_EXTRA", 1))
BOOST_HOLIDAY_EXTRA = int(os.getenv("BOOST_HOLIDAY_EXTRA", 1))
BOOST_STAR_WARS_DAY_EXTRA = int(os.getenv("BOOST_STAR_WARS_DAY_EXTRA", 2))
_holidays_raw = os.getenv("HK_PUBLIC_HOLIDAYS", "")
HK_PUBLIC_HOLIDAYS = {
    v.strip() for v in _holidays_raw.split(",") if v.strip()
}

ENABLE_EVENT_INGESTION = os.getenv("ENABLE_EVENT_INGESTION", "true").lower() == "true"
AUTO_PUBLISH_THRESHOLD = float(os.getenv("AUTO_PUBLISH_THRESHOLD", 0.82))
MIN_REVIEW_THRESHOLD = float(os.getenv("MIN_REVIEW_THRESHOLD", 0.55))
RELEASE_TIMEZONE = os.getenv("RELEASE_TIMEZONE", "Asia/Hong_Kong")

EVENT_INGEST_HOURS = int(os.getenv("EVENT_INGEST_HOURS", 6))
DAILY_EVENT_DIGEST_UTC_HOUR = int(os.getenv("DAILY_EVENT_DIGEST_UTC_HOUR", 11))
DAILY_EVENT_DIGEST_UTC_MINUTE = int(os.getenv("DAILY_EVENT_DIGEST_UTC_MINUTE", 0))

ENABLE_SOURCE_COMPLIANCE = os.getenv("ENABLE_SOURCE_COMPLIANCE", "true").lower() == "true"
REQUIRE_ROBOTS_FOR_SCRAPE = os.getenv("REQUIRE_ROBOTS_FOR_SCRAPE", "true").lower() == "true"
REQUIRE_TOS_ALLOWLIST_FOR_SCRAPE = os.getenv("REQUIRE_TOS_ALLOWLIST_FOR_SCRAPE", "true").lower() == "true"

OFFICIAL_SOURCE_ALLOWLIST = os.getenv("OFFICIAL_SOURCE_ALLOWLIST", "starwars.com,news.google.com")
RSS_SOURCE_ALLOWLIST = os.getenv("RSS_SOURCE_ALLOWLIST", "starwars.com,news.google.com")
API_SOURCE_ALLOWLIST = os.getenv("API_SOURCE_ALLOWLIST", "")
SCRAPE_SOURCE_ALLOWLIST = os.getenv("SCRAPE_SOURCE_ALLOWLIST", "")
SCRAPE_TOS_ALLOWLIST = os.getenv("SCRAPE_TOS_ALLOWLIST", "")

INGEST_FEED_LIMIT = int(os.getenv("INGEST_FEED_LIMIT", 30))
INGEST_API_LIMIT = int(os.getenv("INGEST_API_LIMIT", 40))
INGEST_SCRAPE_LIMIT = int(os.getenv("INGEST_SCRAPE_LIMIT", 60))
HK_ENABLE_ZH = os.getenv("HK_ENABLE_ZH", "true").lower() == "true"

DATASET_COLLECTORS_ENABLED = os.getenv("DATASET_COLLECTORS_ENABLED", "true").lower() == "true"
DATASET_COLLECTOR_INTERVAL_MINUTES = int(os.getenv("DATASET_COLLECTOR_INTERVAL_MINUTES", 180))
DATASET_COLLECTOR_SOURCE_LIMIT = int(os.getenv("DATASET_COLLECTOR_SOURCE_LIMIT", 20))

LLM_ENABLED = os.getenv("LLM_ENABLED", "false").lower() == "true"
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "openrouter").strip().lower()
LLM_MODEL = os.getenv("LLM_MODEL", "meta-llama/llama-3.1-8b-instruct:free").strip()
LLM_API_KEY = os.getenv("LLM_API_KEY", "").strip()
LLM_API_BASE_URL = os.getenv("LLM_API_BASE_URL", "").strip()
LLM_TIMEOUT_SECONDS = int(os.getenv("LLM_TIMEOUT_SECONDS", 18))
LLM_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", 140))
LLM_TEMPERATURE = float(os.getenv("LLM_TEMPERATURE", 0.85))
LLM_AUTONOMOUS_MODE = os.getenv("LLM_AUTONOMOUS_MODE", "false").lower() == "true"
LLM_REPLY_DAILY_CAP = int(os.getenv("LLM_REPLY_DAILY_CAP", 40))
LLM_REPLY_THREAD_DAILY_CAP = int(os.getenv("LLM_REPLY_THREAD_DAILY_CAP", 12))
LLM_REPLY_COOLDOWN_SECONDS = int(os.getenv("LLM_REPLY_COOLDOWN_SECONDS", 180))
LLM_RANDOM_REPLY_CHANCE = float(os.getenv("LLM_RANDOM_REPLY_CHANCE", 0.12))
LLM_MIN_TRIGGER_SCORE = float(os.getenv("LLM_MIN_TRIGGER_SCORE", 0.65))
LLM_MAX_INPUT_CHARS = int(os.getenv("LLM_MAX_INPUT_CHARS", 500))
LLM_ALLOWED_THREAD_NAMES = {
    v.strip().lower()
    for v in os.getenv("LLM_ALLOWED_THREAD_NAMES", "general,memes,lore,movie,show").split(",")
    if v.strip()
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
    "rss|event|GoogleNews HK Star Wars ZH|https://news.google.com/rss/search?q=%E6%98%9F%E9%9A%9B%E5%A4%A7%E6%88%B0+%E9%A6%99%E6%B8%AF+%E6%B4%BB%E5%8B%95&hl=zh-HK&gl=HK&ceid=HK:zh-Hant|locale=zh-hant;"
    "scrape|event|StarWars.com Events Category|https://www.starwars.com/news/category/events|parser=starwars_tag,locale=en",
)

GLOBAL_SOURCE_CONFIG = os.getenv(
    "GLOBAL_SOURCE_CONFIG",
    "official|news|StarWars.com News|https://www.starwars.com/news/feed;"
    "scrape|event|StarWars.com Events Category|https://www.starwars.com/news/category/events|parser=starwars_tag,locale=en;"
    "rss|news|GoogleNews Star Wars Games|https://news.google.com/rss/search?q=star+wars+new+game+release&hl=en-US&gl=US&ceid=US:en;"
    "rss|news|GoogleNews Star Wars TV|https://news.google.com/rss/search?q=star+wars+new+series+release&hl=en-US&gl=US&ceid=US:en;"
    "rss|news|GoogleNews Star Wars Movies|https://news.google.com/rss/search?q=star+wars+new+movie+release&hl=en-US&gl=US&ceid=US:en;"
    "rss|event|GoogleNews Star Wars Convention|https://news.google.com/rss/search?q=star+wars+convention+celebration+events&hl=en-US&gl=US&ceid=US:en",
)

# Format: "dataset|tier|name|url|k=v,k=v" entries separated by semicolons
# dataset: facts|quotes|trivia|polls|discussions
# tier: rss|api|scrape
DATASET_SOURCE_CONFIG = os.getenv(
    "DATASET_SOURCE_CONFIG",
    "facts|rss|StarWars News Feed Facts|https://www.starwars.com/news/feed|locale=en;"
    "quotes|scrape|StarWars Quote Sources|https://www.starwars.com/news|locale=en,parser=starwars_news_quotes;"
    "trivia|scrape|StarWars Databank Trivia|https://www.starwars.com/databank|locale=en,parser=starwars_databank;"
    "polls|rss|StarWars News Poll Prompts|https://www.starwars.com/news/feed|locale=en;"
    "discussions|rss|StarWars News Discussion Prompts|https://www.starwars.com/news/feed|locale=en",
)

THREADS = {
    "lore": int(os.getenv("THREAD_LORE", 0)),
    "memes": int(os.getenv("THREAD_MEMES", 0)),
    "wallpapers": int(os.getenv("THREAD_WALLPAPERS", 0)),
    "movie": int(os.getenv("THREAD_MOVIE", 0)),
    "show": int(os.getenv("THREAD_SHOW", 0)),
    "general": int(os.getenv("THREAD_GENERAL", 0)),
}


def get_thread_id(name):
    value = THREADS.get(name, 0)
    try:
        value = int(value)
    except Exception:
        return None
    return value if value > 0 else None


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

ADMIN_UI_ENABLED = os.getenv("ADMIN_UI_ENABLED", "false").lower() == "true"
ADMIN_UI_HOST = os.getenv("ADMIN_UI_HOST", "0.0.0.0")
ADMIN_UI_PORT = int(os.getenv("ADMIN_UI_PORT", 8088))
ADMIN_UI_ACCESS_TOKEN = os.getenv("ADMIN_UI_ACCESS_TOKEN", "")
ADMIN_UI_SECRET_KEY = os.getenv("ADMIN_UI_SECRET_KEY", "change-me-in-env")
ADMIN_UI_SESSION_HOURS = int(os.getenv("ADMIN_UI_SESSION_HOURS", 12))
ADMIN_UI_COOKIE_SECURE = os.getenv("ADMIN_UI_COOKIE_SECURE", "false").lower() == "true"
ADMIN_UI_ALLOWED_HOSTS = {
    v.strip().lower()
    for v in os.getenv("ADMIN_UI_ALLOWED_HOSTS", "").split(",")
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