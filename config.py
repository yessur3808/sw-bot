import os
from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")
GROUP_ID = int(os.getenv("GROUP_ID"))

REDDIT_CLIENT_ID = os.getenv("REDDIT_CLIENT_ID")
REDDIT_CLIENT_SECRET = os.getenv("REDDIT_CLIENT_SECRET")
REDDIT_USER_AGENT = os.getenv("REDDIT_USER_AGENT")

USE_REDDIT = os.getenv("USE_REDDIT", "true").lower() == "true"
MEME_PROVIDER_PRIORITY = [
    p.strip().lower() for p in os.getenv("MEME_PROVIDER_PRIORITY", "imgflip,reddit").split(",") if p.strip()
]

DAILY_MIN_POSTS = int(os.getenv("DAILY_MIN_POSTS", 4))
DAILY_MAX_POSTS = int(os.getenv("DAILY_MAX_POSTS", 8))
MAX_PER_TOPIC_PER_DAY = int(os.getenv("MAX_PER_TOPIC_PER_DAY", 2))
MIN_GAP_MINUTES = int(os.getenv("MIN_GAP_MINUTES", 60))
STARTUP_RECOVERY_ENABLED = os.getenv("STARTUP_RECOVERY_ENABLED", "true").lower() == "true"
STARTUP_RECOVERY_HOURS = float(os.getenv("STARTUP_RECOVERY_HOURS", 4))

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

_admin_raw = os.getenv("ADMIN_USER_IDS", "")
ADMIN_USER_IDS = {
    int(v.strip()) for v in _admin_raw.split(",") if v.strip().lstrip("-").isdigit()
}

# Format: "tier|kind|name|url" entries separated by semicolons
# tier: official|api|rss|scrape
# kind: event|news
HK_SOURCE_CONFIG = os.getenv(
    "HK_SOURCE_CONFIG",
    "official|event|GoogleNews HK Events|https://news.google.com/rss/search?q=star+wars+hong+kong+events&hl=en-HK&gl=HK&ceid=HK:en;"
    "rss|event|GoogleNews HK Fan Meetup|https://news.google.com/rss/search?q=star+wars+hong+kong+fan+meetup&hl=en-HK&gl=HK&ceid=HK:en",
)

GLOBAL_SOURCE_CONFIG = os.getenv(
    "GLOBAL_SOURCE_CONFIG",
    "official|news|StarWars.com News|https://www.starwars.com/news/feed;"
    "rss|news|GoogleNews Star Wars Games|https://news.google.com/rss/search?q=star+wars+new+game+release&hl=en-US&gl=US&ceid=US:en;"
    "rss|news|GoogleNews Star Wars TV|https://news.google.com/rss/search?q=star+wars+new+series+release&hl=en-US&gl=US&ceid=US:en;"
    "rss|news|GoogleNews Star Wars Movies|https://news.google.com/rss/search?q=star+wars+new+movie+release&hl=en-US&gl=US&ceid=US:en",
)

THREADS = {
    "lore": int(os.getenv("THREAD_LORE", 0)),
    "memes": int(os.getenv("THREAD_MEMES", 0)),
    "wallpapers": int(os.getenv("THREAD_WALLPAPERS", 0)),
    "general": int(os.getenv("THREAD_GENERAL", 0)),
}


def parse_sources(raw_value):
    out = []
    for chunk in raw_value.split(";"):
        part = chunk.strip()
        if not part:
            continue
        try:
            tier, kind, name, url = [p.strip() for p in part.split("|", 3)]
        except ValueError:
            continue
        out.append({"tier": tier.lower(), "kind": kind.lower(), "name": name, "url": url})
    return out


def parse_csv_set(raw_value):
    return {v.strip().lower() for v in raw_value.split(",") if v.strip()}


HK_SOURCES = parse_sources(HK_SOURCE_CONFIG)
GLOBAL_SOURCES = parse_sources(GLOBAL_SOURCE_CONFIG)

SOURCE_ALLOWLISTS = {
    "official": parse_csv_set(OFFICIAL_SOURCE_ALLOWLIST),
    "rss": parse_csv_set(RSS_SOURCE_ALLOWLIST),
    "api": parse_csv_set(API_SOURCE_ALLOWLIST),
    "scrape": parse_csv_set(SCRAPE_SOURCE_ALLOWLIST),
}

SCRAPE_TOS_ALLOWLIST_SET = parse_csv_set(SCRAPE_TOS_ALLOWLIST)