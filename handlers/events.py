import hashlib
import json
import re
from datetime import datetime, date, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse
from urllib import robotparser

from dateutil import parser as dt_parser
import feedparser
import requests
from bs4 import BeautifulSoup
from telegram import Update
from telegram.ext import CommandHandler, ContextTypes

import config
import db
from admin import runtime_settings
from telemetry import instrument_command_handler


SOURCE_WEIGHTS = {
    "official": 0.45,
    "api": 0.35,
    "rss": 0.25,
    "scrape": 0.15,
}

CATEGORY_KEYWORDS = {
    "game": ("game", "gaming", "xbox", "playstation", "nintendo", "pc"),
    "tv": ("series", "show", "tv", "episode", "andor", "mandalorian", "ahsoka"),
    "movie": ("film", "movie", "cinema", "theater", "release date"),
    "event": ("event", "meetup", "convention", "expo", "celebration", "screening"),
    "merch": ("merch", "merchandise", "shop", "store", "drop", "collectible", "figure"),
}

ZH_CATEGORY_KEYWORDS = {
    "game": ("遊戲", "游戏", "主機", "发售", "發售"),
    "tv": ("劇集", "剧集", "影集", "電視", "电视", "連載", "连载"),
    "movie": ("電影", "电影", "院線", "院线", "上映"),
    "event": ("活動", "活动", "聚會", "聚会", "展覽", "展览", "放映"),
    "merch": ("周邊", "周边", "限定", "商品", "商店", "快閃", "快闪"),
}

STAR_WARS_KEYWORDS = (
    "star wars",
    "starwars",
    "星球大战",
    "星際大戰",
    "星际大战",
    "星戰",
    "星战",
)

HK_REGION_KEYWORDS = (
    "hong kong",
    "hk",
    "香港",
)

TRACKING_QUERY_KEYS = {
    "fbclid",
    "gclid",
    "mc_cid",
    "mc_eid",
    "igshid",
    "ref",
    "source",
}

STRATEGY_STARWARS_TAG = "starwars_tag"
STRATEGY_FANDOM = "fandom"
STRATEGY_GENERIC = "generic"

DATE_PATTERNS = (
    r"\b\d{4}-\d{2}-\d{2}\b",
    r"\b\d{1,2}/\d{1,2}/\d{4}\b",
    r"\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},\s*\d{4}\b",
)


def _today_in_release_timezone():
    tz_name = runtime_settings.get("release_timezone")
    try:
        from zoneinfo import ZoneInfo

        return datetime.now(ZoneInfo(tz_name)).date()
    except Exception:
        return date.today()


def _event_thread_id(region=None):
    region_name = str(region or "").strip().lower()
    if region_name == "global":
        return config.get_thread_id("events_global") or config.get_thread_id("general")
    return config.get_thread_id("events_hk") or config.get_thread_id("general")


def _parse_event_date(raw_date):
    if not raw_date:
        return None
    try:
        return date.fromisoformat(str(raw_date))
    except Exception:
        return None


def _is_incoming_event_date(raw_date, today=None, max_days=None):
    parsed = _parse_event_date(raw_date)
    if not parsed:
        return False
    today_date = today or _today_in_release_timezone()
    if parsed < today_date:
        return False
    if max_days is None:
        return True
    return parsed <= (today_date + timedelta(days=max(1, int(max_days))))


def _normalize_text(v):
    return " ".join((v or "").strip().split())


def _canonicalize_url(url):
    if not url:
        return ""
    try:
        parsed = urlparse(url)
    except Exception:
        return url

    query_items = []
    for k, v in parse_qsl(parsed.query, keep_blank_values=True):
        low = k.lower().strip()
        if low.startswith("utm_") or low in TRACKING_QUERY_KEYS:
            continue
        query_items.append((k, v))

    query_items.sort(key=lambda i: i[0].lower())
    normalized = parsed._replace(
        scheme=(parsed.scheme or "https").lower(),
        netloc=parsed.netloc.lower(),
        query=urlencode(query_items, doseq=True),
        fragment="",
    )
    return urlunparse(normalized)


def _parse_date(value):
    if not value:
        return None
    try:
        return parsedate_to_datetime(value).date().isoformat()
    except Exception:
        return None


def _contains_star_wars(text):
    low = (text or "").lower()
    return any(k in low for k in STAR_WARS_KEYWORDS)


def _source_tz(region):
    return runtime_settings.get("release_timezone") if region == "hk" else "UTC"


def _parse_datetime_with_tz(raw_value, fallback_tz):
    if not raw_value:
        return None
    try:
        dt = dt_parser.parse(raw_value, fuzzy=True)
    except Exception:
        return None
    if dt.tzinfo is None:
        if fallback_tz.upper() == "UTC":
            dt = dt.replace(tzinfo=timezone.utc)
        else:
            try:
                from zoneinfo import ZoneInfo

                dt = dt.replace(tzinfo=ZoneInfo(fallback_tz))
            except Exception:
                dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _extract_release_date(title, summary, published, region):
    candidates = []
    if published:
        candidates.append(published)
    blob = f"{title} {summary}"
    low_blob = blob.lower()
    if any(k in low_blob for k in ("release", "launch", "premiere", "coming", "arrives")):
        for pattern in DATE_PATTERNS:
            candidates.extend(re.findall(pattern, low_blob, flags=re.IGNORECASE))

    fallback_tz = _source_tz(region)
    for raw in candidates:
        parsed = _parse_datetime_with_tz(raw, fallback_tz)
        if parsed:
            try:
                from zoneinfo import ZoneInfo

                local_dt = parsed.astimezone(ZoneInfo(runtime_settings.get("release_timezone")))
            except Exception:
                local_dt = parsed
            return local_dt.date().isoformat()

    parsed_published = _parse_date(published)
    return parsed_published


def _classify_category(text):
    low = (text or "").lower()
    for cat, words in CATEGORY_KEYWORDS.items():
        if any(w in low for w in words):
            return cat
    for cat, words in ZH_CATEGORY_KEYWORDS.items():
        if any(w in text for w in words):
            return cat
    return "event"


def _score_item(source_tier, title, summary, region):
    score = SOURCE_WEIGHTS.get(source_tier, 0.1)
    combined_text = f"{title} {summary}"
    combined = combined_text.lower()

    if _contains_star_wars(combined_text):
        score += 0.25
    if any(k in combined for k in ("release", "launch", "official", "trailer", "announcement")):
        score += 0.15
    if region == "hk" and any(k in combined for k in HK_REGION_KEYWORDS):
        score += 0.1
    if region == "hk" and any(k in combined_text for k in ("香港", "九龍", "九龙", "港島", "港岛", "新界")):
        score += 0.08
    if _classify_category(combined) in ("game", "tv", "movie"):
        score += 0.1
    if _classify_category(combined_text) in ("event", "merch"):
        score += 0.05

    return min(score, 0.99)


def _status_for_score(score):
    if score >= runtime_settings.get("auto_publish_threshold"):
        return "approved", True
    if score >= runtime_settings.get("min_review_threshold"):
        return "pending_review", False
    return "rejected", False


def _status_for_score_and_date(score, release_date, today=None):
    base_status, auto_allowed = _status_for_score(score)
    if not release_date:
        return base_status, auto_allowed

    parsed = _parse_event_date(release_date)
    if not parsed:
        return base_status, auto_allowed

    today_date = today or _today_in_release_timezone()
    tomorrow_date = today_date + timedelta(days=1)
    if parsed < tomorrow_date:
        return "rejected", False
    return base_status, auto_allowed


def auto_reject_pending_before_tomorrow(region=None):
    tomorrow = _today_in_release_timezone() + timedelta(days=1)
    return db.reject_pending_events_before(tomorrow.isoformat(), region=region)


def _build_item_key(url, title):
    canonical = _canonicalize_url(url)
    raw = f"{canonical}|{_normalize_text(title).lower()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _build_dedupe_key(title, event_date=None, location_text=None):
    base = _normalize_text(title).lower()
    d = _normalize_text(event_date or "").lower()
    loc = _normalize_text(location_text or "").lower()
    raw = f"{base}|{d}|{loc}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _domain_from_url(url):
    return (urlparse(url).hostname or "").lower()


def _domain_allowed_for_tier(tier, domain):
    if tier == "official":
        raw = runtime_settings.get("official_source_allowlist")
    elif tier == "rss":
        raw = runtime_settings.get("rss_source_allowlist")
    elif tier == "api":
        raw = runtime_settings.get("api_source_allowlist")
    elif tier == "scrape":
        raw = runtime_settings.get("scrape_source_allowlist")
    else:
        raw = ""
    allowlist = {v.strip().lower() for v in str(raw).split(",") if v.strip()}
    if not allowlist:
        return False
    return any(domain == d or domain.endswith(f".{d}") for d in allowlist)


def _tos_allowed_for_scrape(domain):
    if not config.REQUIRE_TOS_ALLOWLIST_FOR_SCRAPE:
        return True
    raw = runtime_settings.get("scrape_tos_allowlist")
    allowlist = {v.strip().lower() for v in str(raw).split(",") if v.strip()}
    if not allowlist:
        return False
    return any(domain == d or domain.endswith(f".{d}") for d in allowlist)


def _robots_allowed(url):
    if not config.REQUIRE_ROBOTS_FOR_SCRAPE:
        return True
    parsed = urlparse(url)
    robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
    rp = robotparser.RobotFileParser()
    try:
        rp.set_url(robots_url)
        rp.read()
        return rp.can_fetch("*", url)
    except Exception:
        return False


def _source_compliant(source):
    if not config.ENABLE_SOURCE_COMPLIANCE:
        return True, None

    domain = _domain_from_url(source["url"])
    tier = source["tier"]
    if not domain:
        return False, "invalid-domain"
    if not _domain_allowed_for_tier(tier, domain):
        return False, "domain-not-allowlisted"
    if tier == "scrape":
        if not _tos_allowed_for_scrape(domain):
            return False, "tos-not-allowlisted"
        if not _robots_allowed(source["url"]):
            return False, "robots-disallow"
    return True, None


def _fetch_feed(source):
    source_meta = source.get("meta") or {}
    source_locale = _normalize_text(source_meta.get("locale", ""))
    parsed = feedparser.parse(source["url"])
    entries = parsed.entries or []
    out = []
    for ent in entries[: max(1, runtime_settings.get("ingest_feed_limit"))]:
        title = _normalize_text(getattr(ent, "title", ""))
        if not title:
            continue
        link = _canonicalize_url(_normalize_text(getattr(ent, "link", "")))
        if not link:
            continue
        summary = _normalize_text(getattr(ent, "summary", ""))
        published = _parse_date(getattr(ent, "published", ""))
        out.append(
            {
                "title": title,
                "url": link,
                "summary": summary,
                "event_date": published,
                "language": source_locale or None,
                "source_meta": {"fetcher": "feed"},
            }
        )
    if out:
        return out

    domain = _domain_from_url(source.get("url", ""))
    path = urlparse(source.get("url", "")).path.lower()
    if domain.endswith("starwars.com") and path.endswith("/news/feed"):
        return _extract_starwars_news_page_items(source)

    return out


def _extract_starwars_news_page_items(source):
    source_meta = source.get("meta") or {}
    source_locale = _normalize_text(source_meta.get("locale", ""))
    page_url = _normalize_text(source_meta.get("fallback_url") or "https://www.starwars.com/news")
    try:
        response = requests.get(page_url, timeout=18)
        response.raise_for_status()
    except Exception:
        return []

    soup = BeautifulSoup(response.text, "html.parser")
    out = []
    seen = set()
    selectors = [
        "a[href*='/news/']",
        "article a[href]",
    ]
    for selector in selectors:
        for anchor in soup.select(selector):
            href = _normalize_text(anchor.get("href", ""))
            if not href:
                continue
            link = _canonicalize_url(urljoin(page_url, href))
            if "/news/" not in urlparse(link).path:
                continue
            title = _normalize_text(anchor.get("aria-label") or anchor.get_text(" ", strip=True))
            if len(title) < 8:
                continue
            parent = _normalize_text(anchor.parent.get_text(" ", strip=True) if anchor.parent else "")
            key = (link, title.lower())
            if key in seen:
                continue
            seen.add(key)
            out.append(
                {
                    "title": title,
                    "url": link,
                    "summary": parent[:500],
                    "event_date": _extract_release_date(title, parent, None, "global"),
                    "language": source_locale or None,
                    "force_relevance": True,
                    "source_meta": {"fetcher": "feed_page_fallback"},
                }
            )
            if len(out) >= max(1, runtime_settings.get("ingest_feed_limit")):
                return out
    return _dedupe_raw_items(out, runtime_settings.get("ingest_feed_limit"))


def _extract_json_items(payload, items_key=None):
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []
    if items_key and isinstance(payload.get(items_key), list):
        return payload.get(items_key) or []
    for key in ("events", "items", "results", "data", "articles"):
        candidate = payload.get(key)
        if isinstance(candidate, list):
            return candidate
    return []


def _pick_field(row, keys):
    for key in keys:
        value = row.get(key)
        if value:
            return str(value)
    return ""


def _fetch_api(source, region):
    meta = source.get("meta") or {}
    try:
        response = requests.get(source["url"], timeout=15, headers={"Accept": "application/json"})
        response.raise_for_status()
        payload = response.json()
    except Exception:
        return []

    items_key = meta.get("items_key")
    title_key = meta.get("title_key")
    url_key = meta.get("url_key")
    summary_key = meta.get("summary_key")
    date_key = meta.get("date_key")

    rows = _extract_json_items(payload, items_key=items_key)
    out = []
    for row in rows[: max(1, runtime_settings.get("ingest_api_limit"))]:
        if not isinstance(row, dict):
            continue
        title = _normalize_text(_pick_field(row, [title_key, "title", "name", "headline"]))
        link = _canonicalize_url(_normalize_text(_pick_field(row, [url_key, "url", "link", "permalink"])))
        if not title or not link:
            continue
        summary = _normalize_text(_pick_field(row, [summary_key, "summary", "description", "excerpt"]))
        raw_date = _pick_field(row, [date_key, "event_date", "startDate", "start_date", "published", "published_at", "date"])
        out.append(
            {
                "title": title,
                "url": link,
                "summary": summary,
                "event_date": _parse_date(raw_date) or _extract_release_date(title, summary, raw_date, region),
                "location_text": _normalize_text(_pick_field(row, ["location", "venue", "place"])) or None,
                "language": _normalize_text(meta.get("locale", "")) or None,
                "raw_event_type": _normalize_text(_pick_field(row, ["type", "event_type", "category"])) or None,
                "source_meta": {"fetcher": "api"},
            }
        )
    return out


def _walk_json_nodes(node):
    if isinstance(node, list):
        for item in node:
            yield from _walk_json_nodes(item)
        return
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from _walk_json_nodes(value)


def _extract_json_ld_events(soup, source_url, region):
    out = []
    for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
        raw = (script.string or script.get_text() or "").strip()
        if not raw:
            continue
        try:
            payload = json.loads(raw)
        except Exception:
            continue
        for node in _walk_json_nodes(payload):
            raw_type = node.get("@type")
            if isinstance(raw_type, list):
                type_values = [str(v).lower() for v in raw_type]
            else:
                type_values = [str(raw_type).lower()]
            if not any("event" in t for t in type_values):
                continue
            title = _normalize_text(str(node.get("name") or ""))
            link = _canonicalize_url(_normalize_text(str(node.get("url") or source_url)))
            summary = _normalize_text(str(node.get("description") or ""))
            raw_date = str(node.get("startDate") or node.get("endDate") or "")
            location = node.get("location")
            location_text = ""
            if isinstance(location, dict):
                location_text = _normalize_text(
                    str(location.get("name") or location.get("address") or "")
                )
            elif isinstance(location, str):
                location_text = _normalize_text(location)
            if not title or not link:
                continue
            out.append(
                {
                    "title": title,
                    "url": link,
                    "summary": summary,
                    "event_date": _extract_release_date(title, summary, raw_date, region),
                    "location_text": location_text or None,
                    "raw_event_type": ",".join(type_values),
                    "source_meta": {"fetcher": "jsonld"},
                }
            )
    return out


def _extract_anchor_candidates(soup, source, region):
    out = []
    seen = set()
    for anchor in soup.select("a[href]"):
        href = _normalize_text(anchor.get("href", ""))
        if not href or href.startswith(("mailto:", "javascript:", "#")):
            continue
        link = _canonicalize_url(urljoin(source["url"], href))
        title = _normalize_text(anchor.get_text(" ", strip=True))
        if len(title) < 8:
            continue
        parent = anchor.parent.get_text(" ", strip=True) if anchor.parent else ""
        summary = _normalize_text(parent)
        combined = f"{title} {summary}"
        if not _contains_star_wars(combined):
            continue
        key = (link, title.lower())
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "title": title,
                "url": link,
                "summary": summary[:500],
                "event_date": _extract_release_date(title, summary, None, region),
                "location_text": "Hong Kong" if any(k in combined.lower() for k in HK_REGION_KEYWORDS) else None,
                "source_meta": {"fetcher": "anchor"},
            }
        )
        if len(out) >= max(1, runtime_settings.get("ingest_scrape_limit")):
            break
    return out


def _extract_starwars_tag_items(soup, source, region):
    out = []
    seen = set()
    selectors = [
        "article a[href]",
        "a.content-grid__link[href]",
        "a[href*='/news/']",
    ]
    for selector in selectors:
        for anchor in soup.select(selector):
            href = _normalize_text(anchor.get("href", ""))
            if not href:
                continue
            link = _canonicalize_url(urljoin(source["url"], href))
            title = _normalize_text(anchor.get_text(" ", strip=True))
            if len(title) < 6:
                continue
            parent_text = _normalize_text(anchor.parent.get_text(" ", strip=True) if anchor.parent else "")
            key = (link, title.lower())
            if key in seen:
                continue
            seen.add(key)
            out.append(
                {
                    "title": title,
                    "url": link,
                    "summary": parent_text[:500],
                    "event_date": _extract_release_date(title, parent_text, None, region),
                    "raw_event_type": "editorial_event",
                    "force_relevance": True,
                    "source_meta": {"fetcher": "starwars_tag"},
                }
            )
            if len(out) >= max(1, runtime_settings.get("ingest_scrape_limit")):
                return out
    return out


def _extract_fandom_items(soup, source, region):
    out = []
    seen = set()
    for anchor in soup.select("main a[href], .mw-parser-output a[href]"):
        href = _normalize_text(anchor.get("href", ""))
        if not href:
            continue
        link = _canonicalize_url(urljoin(source["url"], href))
        title = _normalize_text(anchor.get_text(" ", strip=True))
        if len(title) < 6:
            continue
        combined = f"{title} {_normalize_text(anchor.parent.get_text(' ', strip=True) if anchor.parent else '')}"
        if not _contains_star_wars(combined):
            continue
        key = (link, title.lower())
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "title": title,
                "url": link,
                "summary": combined[:500],
                "event_date": _extract_release_date(title, combined, None, region),
                "source_meta": {"fetcher": "fandom"},
            }
        )
        if len(out) >= max(1, runtime_settings.get("ingest_scrape_limit")):
            break
    return out


def _dedupe_raw_items(items, limit):
    out = []
    seen = set()
    for item in items:
        link = _canonicalize_url(item.get("url", ""))
        title = _normalize_text(item.get("title", "")).lower()
        if not link or not title:
            continue
        key = (link, title)
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
        if len(out) >= max(1, limit):
            break
    return out


def _parser_strategy_for_source(source):
    meta = source.get("meta") or {}
    strategy = _normalize_text(meta.get("parser", "")).lower()
    if strategy in (STRATEGY_STARWARS_TAG, STRATEGY_FANDOM, STRATEGY_GENERIC):
        return strategy
    domain = _domain_from_url(source.get("url", ""))
    if domain.endswith("starwars.com"):
        return STRATEGY_STARWARS_TAG
    if domain.endswith("fandom.com") or domain.endswith("wookieepedia.com"):
        return STRATEGY_FANDOM
    return STRATEGY_GENERIC


def _fetch_scrape(source, region):
    # Prefer structured extraction (JSON-LD + anchor candidates), then feed fallback.
    try:
        response = requests.get(source["url"], timeout=15)
        response.raise_for_status()
    except Exception:
        return []

    soup = BeautifulSoup(response.text, "html.parser")
    out = []
    strategy = _parser_strategy_for_source(source)
    if strategy == STRATEGY_STARWARS_TAG:
        out.extend(_extract_starwars_tag_items(soup, source, region))
    elif strategy == STRATEGY_FANDOM:
        out.extend(_extract_fandom_items(soup, source, region))

    if len(out) < max(1, runtime_settings.get("ingest_scrape_limit") // 2):
        out.extend(_extract_json_ld_events(soup, source["url"], region))
    if len(out) < max(1, runtime_settings.get("ingest_scrape_limit")):
        out.extend(_extract_anchor_candidates(soup, source, region))

    out = _dedupe_raw_items(out, runtime_settings.get("ingest_scrape_limit"))
    if out:
        return out

    parsed = feedparser.parse(response.text)
    entries = parsed.entries or []
    fallback = []
    for ent in entries[: max(1, runtime_settings.get("ingest_scrape_limit") // 2)]:
        title = _normalize_text(getattr(ent, "title", ""))
        link = _canonicalize_url(_normalize_text(getattr(ent, "link", "")))
        if not title or not link:
            continue
        fallback.append(
            {
                "title": title,
                "url": link,
                "summary": _normalize_text(getattr(ent, "summary", "")),
                "event_date": _parse_date(getattr(ent, "published", "")),
                "source_meta": {"fetcher": "feed_fallback", "strategy": strategy},
            }
        )
    return fallback


def _source_items(source, region):
    tier = source["tier"]
    if tier in ("official", "rss"):
        return _fetch_feed(source)
    if tier == "api":
        return _fetch_api(source, region)
    if tier == "scrape":
        return _fetch_scrape(source, region)
    return []


def _source_veracity(source):
    tier = (source.get("tier") or "").lower()
    domain = _domain_from_url(source.get("url", ""))
    if tier in ("official", "api"):
        return "confirmed"
    if tier == "rss" and domain.endswith("starwars.com"):
        return "confirmed"
    return "rumor"


def _audit_strategy_for_source(source):
    tier = (source.get("tier") or "").lower()
    if tier == "scrape":
        return _parser_strategy_for_source(source)
    if tier in ("official", "rss"):
        return "feed"
    if tier == "api":
        return "api"
    return "unknown"


def _audit_health(status, fetched_count, saved_count):
    if status != "ok":
        return None, None
    fetched = int(fetched_count or 0)
    saved = int(saved_count or 0)
    if fetched <= 0:
        return "no-data", 0.0
    ratio = saved / max(1, fetched)
    if saved <= 0:
        return "no-save", ratio
    if ratio >= 0.8:
        return "strong", ratio
    if ratio >= 0.4:
        return "fair", ratio
    return "weak", ratio


def _log_source_audit(region, source, status, fetched_count, saved_count, error=None):
    source_tier = source.get("tier", "unknown")
    parser_strategy = _audit_strategy_for_source(source)
    extraction_health, extraction_ratio = _audit_health(status, fetched_count, saved_count)

    if source_tier == "scrape":
        db.log_event_scrape_audit(
            run_type=region,
            source_name=source["name"],
            source_url=source["url"],
            source_tier=source_tier,
            parser_strategy=parser_strategy,
            status=status,
            extraction_health=extraction_health,
            extraction_ratio=extraction_ratio,
            fetched_count=fetched_count,
            saved_count=saved_count,
            error=error,
        )
        return

    db.log_event_crawl_audit(
        run_type=region,
        source_name=source["name"],
        source_url=source["url"],
        source_tier=source_tier,
        parser_strategy=parser_strategy,
        status=status,
        extraction_health=extraction_health,
        extraction_ratio=extraction_ratio,
        fetched_count=fetched_count,
        saved_count=saved_count,
        error=error,
    )


def _eligible_star_wars(item):
    if item.get("force_relevance"):
        return True
    txt = f"{item['title']} {item.get('summary', '')}"
    return _contains_star_wars(txt)


def ingest_sources(region, sources):
    total_saved = 0
    total_fetched = 0
    blocked_sources = 0
    seen_keys = set()
    for source in sources:
        fetched_count = 0
        saved_count = 0
        try:
            allowed, reason = _source_compliant(source)
            if not allowed:
                blocked_sources += 1
                db.log_ingestion_run(
                    run_type=region,
                    source_name=source["name"],
                    source_url=source["url"],
                    status=f"blocked:{reason}",
                    fetched_count=0,
                    saved_count=0,
                )
                _log_source_audit(
                    region,
                    source,
                    status=f"blocked:{reason}",
                    fetched_count=0,
                    saved_count=0,
                )
                continue

            items = _source_items(source, region)
            fetched_count = len(items)
            total_fetched += fetched_count
            for raw in items:
                if not _eligible_star_wars(raw):
                    continue
                canonical_url = _canonicalize_url(raw["url"])
                item_key = _build_item_key(canonical_url, raw["title"])
                if item_key in seen_keys:
                    continue
                seen_keys.add(item_key)
                category = _classify_category(f"{raw['title']} {raw.get('summary', '')}")
                score = _score_item(source["tier"], raw["title"], raw.get("summary", ""), region)
                release_date = _extract_release_date(
                    raw["title"], raw.get("summary", ""), raw.get("event_date"), region
                )
                source_meta = {
                    "source_kind": source.get("kind"),
                    "source_config_meta": source.get("meta") or {},
                    "extract_meta": raw.get("source_meta") or {},
                }
                status, auto_allowed = _status_for_score_and_date(score, release_date)
                item = {
                    "item_key": item_key,
                    "title": raw["title"],
                    "url": canonical_url,
                    "source_name": source["name"],
                    "source_tier": source["tier"],
                    "source_veracity": _source_veracity(source),
                    "region": region,
                    "category": category,
                    "event_date": release_date,
                    "canonical_url": canonical_url,
                    "dedupe_key": _build_dedupe_key(raw["title"], release_date, raw.get("location_text")),
                    "location_text": raw.get("location_text"),
                    "language": raw.get("language") or (source.get("meta") or {}).get("locale"),
                    "raw_event_type": raw.get("raw_event_type"),
                    "source_meta": json.dumps(source_meta, ensure_ascii=False, sort_keys=True),
                    "confidence": score,
                    "status": status,
                    "auto_publish_allowed": auto_allowed,
                }
                db.upsert_event_item(item)
                saved_count += 1
            db.log_ingestion_run(
                run_type=region,
                source_name=source["name"],
                source_url=source["url"],
                status="ok",
                fetched_count=fetched_count,
                saved_count=saved_count,
            )
            _log_source_audit(
                region,
                source,
                status="ok",
                fetched_count=fetched_count,
                saved_count=saved_count,
            )
        except Exception as exc:
            db.log_ingestion_run(
                run_type=region,
                source_name=source["name"],
                source_url=source["url"],
                status="error",
                fetched_count=fetched_count,
                saved_count=saved_count,
                error=str(exc),
            )
            _log_source_audit(
                region,
                source,
                status="error",
                fetched_count=fetched_count,
                saved_count=saved_count,
                error=str(exc),
            )
        total_saved += saved_count
    return {
        "region": region,
        "saved": total_saved,
        "fetched": total_fetched,
        "blocked_sources": blocked_sources,
    }


def ingest_now(region="all"):
    auto_rejected = auto_reject_pending_before_tomorrow(region=None if region == "all" else region)
    summaries = []
    if region in ("all", "hk"):
        summaries.append(ingest_sources("hk", runtime_settings.get_sources("hk")))
    if region in ("all", "global"):
        summaries.append(ingest_sources("global", runtime_settings.get_sources("global")))
    if summaries:
        summaries[0]["auto_rejected_before_tomorrow"] = auto_rejected
    return summaries


async def ingest_events_job(context: ContextTypes.DEFAULT_TYPE):
    if not runtime_settings.get("enable_event_ingestion"):
        return
    ingest_now("all")


async def publish_auto_approved(context: ContextTypes.DEFAULT_TYPE):
    rows = db.list_unpublished_auto(limit=12)
    for row in rows:
        if db.already_posted("event", row["item_key"]):
            continue
        region = str(row.get("region") or "hk").strip().lower() or "hk"
        date_hint = f"\nDate: {row['event_date']}" if row["event_date"] else ""
        text = (
            f"📡 *Star Wars Update*\n\n"
            f"{row['title']}\n"
            f"Category: {row['category']} | Region: {row['region']}\n"
            f"Source: {row['source_name']}\n"
            f"Confidence: {row['confidence']:.2f}{date_hint}\n\n"
            f"{row['url']}"
        )
        message = await context.bot.send_message(
            chat_id=config.GROUP_ID,
            message_thread_id=_event_thread_id(region),
            text=text,
            parse_mode="Markdown",
            disable_web_page_preview=False,
        )
        db.log_post_audit(
            topic=f"event_update:{region}",
            thread_id=_event_thread_id(region),
            telegram_message_id=message.message_id,
            content_type="event",
            content_id=row["item_key"],
            text=text,
        )


async def daily_event_digest(context: ContextTypes.DEFAULT_TYPE):
    hk = db.list_events_by_status("approved", limit=5, region="hk")
    global_items = db.list_events_by_status("approved", limit=5, region="global")

    today = _today_in_release_timezone()
    hk = [row for row in hk if _is_incoming_event_date(row.get("event_date") if hasattr(row, "get") else row["event_date"], today=today)]
    global_items = [
        row
        for row in global_items
        if _is_incoming_event_date(row.get("event_date") if hasattr(row, "get") else row["event_date"], today=today)
    ]

    def _escape_md(text):
        raw = str(text or "")
        for ch in ("_", "*", "[", "]", "(", ")", "~", "`", ">", "#", "+", "-", "=", "|", "{", "}", ".", "!"):
            raw = raw.replace(ch, f"\\{ch}")
        return raw

    def _line(row):
        title = _escape_md(row["title"])
        category = _escape_md(row["category"])
        url = str(row.get("url") if hasattr(row, "get") else row["url"]).strip()
        if url:
            return f"- [{title}]({url}) ({category})"
        return f"- {title} ({category})"

    parts = ["🗓️ *Daily Star Wars Event Digest*"]
    sent_any = False
    if hk:
        hk_text = "\n*Hong Kong*\n" + "\n".join(_line(r) for r in hk)
        message = await context.bot.send_message(
            chat_id=config.GROUP_ID,
            message_thread_id=_event_thread_id("hk"),
            text="\n".join([parts[0], hk_text]),
            parse_mode="Markdown",
        )
        db.log_post_audit(
            topic="event_digest:hk",
            thread_id=_event_thread_id("hk"),
            telegram_message_id=message.message_id,
            content_type="event_digest",
            content_id=f"event_digest:hk:{date.today().isoformat()}",
            text="\n".join([parts[0], hk_text]),
        )
        sent_any = True
    if global_items:
        global_text = "\n*Global*\n" + "\n".join(_line(r) for r in global_items)
        message = await context.bot.send_message(
            chat_id=config.GROUP_ID,
            message_thread_id=_event_thread_id("global"),
            text="\n".join([parts[0], global_text]),
            parse_mode="Markdown",
        )
        db.log_post_audit(
            topic="event_digest:global",
            thread_id=_event_thread_id("global"),
            telegram_message_id=message.message_id,
            content_type="event_digest",
            content_id=f"event_digest:global:{date.today().isoformat()}",
            text="\n".join([parts[0], global_text]),
        )
        sent_any = True
    if not sent_any:
        return


def _is_admin(update: Update):
    user = update.effective_user
    return bool(user and db.is_admin_user(user.id))


async def review_events(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _is_admin(update):
        await update.message.reply_text("Admin only command.")
        return

    auto_reject_pending_before_tomorrow()
    rows = db.list_events_by_status("pending_review", limit=10)
    if not rows:
        await update.message.reply_text("No pending review items.")
        return

    lines = ["Pending review items:"]
    for r in rows:
        lines.append(
            f"#{r['id']} [{r['confidence']:.2f}] {r['title']}\n{r['url']}"
        )
    await update.message.reply_text("\n\n".join(lines))


async def approve_event(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _is_admin(update):
        await update.message.reply_text("Admin only command.")
        return
    if not context.args:
        await update.message.reply_text("Usage: /approve <event_id>")
        return

    event_id = context.args[0]
    if not event_id.isdigit():
        await update.message.reply_text("Event ID must be numeric.")
        return
    db.set_event_status(int(event_id), "approved")
    await update.message.reply_text(f"Approved event #{event_id}.")


async def reject_event(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _is_admin(update):
        await update.message.reply_text("Admin only command.")
        return
    if not context.args:
        await update.message.reply_text("Usage: /reject <event_id>")
        return

    event_id = context.args[0]
    if not event_id.isdigit():
        await update.message.reply_text("Event ID must be numeric.")
        return
    db.set_event_status(int(event_id), "rejected")
    await update.message.reply_text(f"Rejected event #{event_id}.")


async def ingest_now_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _is_admin(update):
        await update.message.reply_text("Admin only command.")
        return

    region = "all"
    if context.args:
        candidate = context.args[0].strip().lower()
        if candidate in ("all", "hk", "global"):
            region = candidate
        else:
            await update.message.reply_text("Usage: /ingest_now [all|hk|global]")
            return

    summaries = ingest_now(region)
    lines = ["Ingestion completed:"]
    for s in summaries:
        lines.append(
            f"- {s['region']}: fetched={s['fetched']}, saved={s['saved']}, blocked_sources={s['blocked_sources']}"
        )
    await update.message.reply_text("\n".join(lines))


async def source_status_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _is_admin(update):
        await update.message.reply_text("Admin only command.")
        return

    limit = 12
    if context.args and context.args[0].isdigit():
        limit = max(1, min(30, int(context.args[0])))

    rows = db.latest_ingestion_run_per_source(limit=limit)
    if not rows:
        await update.message.reply_text("No ingestion runs found yet.")
        return

    source_index = {}
    for run_type, sources in (("hk", config.HK_SOURCES), ("global", config.GLOBAL_SOURCES)):
        for source in sources:
            source_index[(run_type, source.get("name"))] = source

    def _strategy_label(source):
        if not source:
            return "unknown"
        tier = source.get("tier")
        if tier == "scrape":
            return _parser_strategy_for_source(source)
        if tier in ("official", "rss"):
            return "feed"
        if tier == "api":
            return "api"
        return "unknown"

    def _health_label(status, fetched, saved):
        if status != "ok":
            return "n/a", "n/a"
        if fetched <= 0:
            return "no-data", "0%"
        ratio = saved / max(1, fetched)
        ratio_txt = f"{ratio * 100:.0f}%"
        if saved <= 0:
            return "no-save", ratio_txt
        if ratio >= 0.8:
            return "strong", ratio_txt
        if ratio >= 0.4:
            return "fair", ratio_txt
        return "weak", ratio_txt

    total_ok = 0
    total_blocked = 0
    total_error = 0
    lines = ["Source status (latest run per source):"]
    for r in rows:
        status = r["status"]
        fetched = int(r.get("fetched_count", 0) or 0)
        saved = int(r.get("saved_count", 0) or 0)
        if status == "ok":
            total_ok += 1
            marker = "OK"
        elif status.startswith("blocked:"):
            total_blocked += 1
            marker = f"BLOCKED ({status.split(':', 1)[1]})"
        else:
            total_error += 1
            marker = "ERROR"

        source = source_index.get((r.get("run_type"), r.get("source_name")))
        tier = source.get("tier") if source else "unknown"
        strategy = _strategy_label(source)
        health, ratio_txt = _health_label(status, fetched, saved)

        lines.append(
            f"- [{r['run_type']}] {r['source_name']} -> {marker} | tier={tier} parser={strategy} health={health} ratio={ratio_txt} fetched={fetched} saved={saved}"
        )
        if r["error"]:
            lines.append(f"  error: {r['error'][:120]}")

    lines.append("")
    lines.append(f"Summary: ok={total_ok}, blocked={total_blocked}, error={total_error}")
    await update.message.reply_text("\n".join(lines))


async def events_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    region = "all"
    limit = 8
    days = 90
    page = 1

    for arg in context.args:
        low = arg.lower().strip()
        if low in ("hk", "global", "all"):
            region = low
        elif low.startswith("page=") or low.startswith("p="):
            num = low.split("=", 1)[1]
            if num.isdigit():
                page = max(1, int(num))
        elif low.isdigit():
            val = int(low)
            if val <= 30:
                limit = max(1, min(15, val))
            else:
                days = max(1, min(365, val))

    offset = (page - 1) * limit
    rows = db.list_approved_events(
        limit=max(limit, limit * 3),
        offset=offset,
        region=region,
        days=days,
    )
    today = _today_in_release_timezone()
    filtered = []
    for r in rows:
        event_date = r.get("event_date") if hasattr(r, "get") else r["event_date"]
        if _is_incoming_event_date(event_date, today=today, max_days=days):
            filtered.append(r)
        if len(filtered) >= limit:
            break

    if not filtered:
        await update.message.reply_text("No upcoming approved events found for the selected filters.")
        return

    lines = [f"Upcoming Star Wars events ({region}, next {days} days, page {page}):"]
    for r in filtered:
        veracity = (r.get("source_veracity") if hasattr(r, "get") else r["source_veracity"]) or "rumor"
        lines.append(
            f"- #{r['id']} {r['event_date']} | [{veracity.upper()}] {r['title']} ({r['region']}/{r['category']})"
        )
    lines.append("")
    lines.append("Tip: use /events_detail <id> for full source/confidence details.")
    await update.message.reply_text("\n".join(lines))


async def release_calendar_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    region = "all"
    limit = 10
    days = 365
    page = 1

    for arg in context.args:
        low = arg.lower().strip()
        if low in ("hk", "global", "all"):
            region = low
        elif low.startswith("page=") or low.startswith("p="):
            num = low.split("=", 1)[1]
            if num.isdigit():
                page = max(1, int(num))
        elif low.isdigit():
            val = int(low)
            if val <= 40:
                limit = max(1, min(20, val))
            else:
                days = max(30, min(730, val))

    offset = (page - 1) * limit
    rows = db.list_upcoming_releases(limit=limit, offset=offset, region=region, days=days)
    if not rows:
        await update.message.reply_text("No upcoming game/TV/movie releases found yet.")
        return

    lines = [f"Release calendar ({region}, next {days} days, page {page}):"]
    for r in rows:
        lines.append(
            f"- #{r['id']} {r['event_date']} | [{r['category'].upper()}] {r['title']}"
        )
    await update.message.reply_text("\n".join(lines))


async def events_detail_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args or not context.args[0].isdigit():
        await update.message.reply_text("Usage: /events_detail <id>")
        return

    row = db.get_event_by_id(int(context.args[0]))
    if not row:
        await update.message.reply_text("Event not found.")
        return

    text = (
        f"*Event Details*\n\n"
        f"ID: #{row['id']}\n"
        f"Title: {row['title']}\n"
        f"Region: {row['region']}\n"
        f"Category: {row['category']}\n"
        f"Tag: {(row.get('source_veracity') if hasattr(row, 'get') else row['source_veracity']) or 'rumor'}\n"
        f"Date: {row['event_date'] or 'TBD'}\n"
        f"Location: {(row.get('location_text') if hasattr(row, 'get') else row['location_text']) or 'Unknown'}\n"
        f"Language: {(row.get('language') if hasattr(row, 'get') else row['language']) or 'Unknown'}\n"
        f"Status: {row['status']}\n"
        f"Confidence: {row['confidence']:.2f}\n"
        f"Source: {row['source_name']} ({row['source_tier']})\n\n"
        f"URL: {row['url']}"
    )
    await update.message.reply_text(text, parse_mode="Markdown", disable_web_page_preview=False)


def register(app):
    app.add_handler(CommandHandler("events", instrument_command_handler("events", events_cmd)))
    app.add_handler(CommandHandler("events_detail", instrument_command_handler("events_detail", events_detail_cmd)))
    app.add_handler(CommandHandler("release_calendar", instrument_command_handler("release_calendar", release_calendar_cmd)))
    app.add_handler(CommandHandler("review_events", instrument_command_handler("review_events", review_events)))
    app.add_handler(CommandHandler("approve", instrument_command_handler("approve", approve_event)))
    app.add_handler(CommandHandler("reject", instrument_command_handler("reject", reject_event)))
    app.add_handler(CommandHandler("ingest_now", instrument_command_handler("ingest_now", ingest_now_cmd)))
    app.add_handler(CommandHandler("source_status", instrument_command_handler("source_status", source_status_cmd)))
