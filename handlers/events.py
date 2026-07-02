import hashlib
import re
from datetime import datetime, date, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse
from urllib import robotparser

from dateutil import parser as dt_parser
import feedparser
import requests
from telegram import Update
from telegram.ext import CommandHandler, ContextTypes

import config
import db


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
}

DATE_PATTERNS = (
    r"\b\d{4}-\d{2}-\d{2}\b",
    r"\b\d{1,2}/\d{1,2}/\d{4}\b",
    r"\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},\s*\d{4}\b",
)


def _normalize_text(v):
    return " ".join((v or "").strip().split())


def _parse_date(value):
    if not value:
        return None
    try:
        return parsedate_to_datetime(value).date().isoformat()
    except Exception:
        return None


def _source_tz(region):
    return config.RELEASE_TIMEZONE if region == "hk" else "UTC"


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

                local_dt = parsed.astimezone(ZoneInfo(config.RELEASE_TIMEZONE))
            except Exception:
                local_dt = parsed
            return local_dt.date().isoformat()

    parsed_published = _parse_date(published)
    return parsed_published


def _classify_category(text):
    low = text.lower()
    for cat, words in CATEGORY_KEYWORDS.items():
        if any(w in low for w in words):
            return cat
    return "event"


def _score_item(source_tier, title, summary, region):
    score = SOURCE_WEIGHTS.get(source_tier, 0.1)
    combined = f"{title} {summary}".lower()

    if "star wars" in combined:
        score += 0.25
    if any(k in combined for k in ("release", "launch", "official", "trailer", "announcement")):
        score += 0.15
    if region == "hk" and any(k in combined for k in ("hong kong", "hk")):
        score += 0.1
    if _classify_category(combined) in ("game", "tv", "movie"):
        score += 0.1

    return min(score, 0.99)


def _status_for_score(score):
    if score >= config.AUTO_PUBLISH_THRESHOLD:
        return "approved", True
    if score >= config.MIN_REVIEW_THRESHOLD:
        return "pending_review", False
    return "rejected", False


def _build_item_key(url, title):
    raw = f"{url}|{_normalize_text(title).lower()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _domain_from_url(url):
    return (urlparse(url).hostname or "").lower()


def _domain_allowed_for_tier(tier, domain):
    allowlist = config.SOURCE_ALLOWLISTS.get(tier, set())
    if not allowlist:
        return False
    return any(domain == d or domain.endswith(f".{d}") for d in allowlist)


def _tos_allowed_for_scrape(domain):
    if not config.REQUIRE_TOS_ALLOWLIST_FOR_SCRAPE:
        return True
    if not config.SCRAPE_TOS_ALLOWLIST_SET:
        return False
    return any(domain == d or domain.endswith(f".{d}") for d in config.SCRAPE_TOS_ALLOWLIST_SET)


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
    parsed = feedparser.parse(source["url"])
    entries = parsed.entries or []
    out = []
    for ent in entries[:30]:
        title = _normalize_text(getattr(ent, "title", ""))
        if not title:
            continue
        link = _normalize_text(getattr(ent, "link", ""))
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
            }
        )
    return out


def _fetch_scrape(source):
    # Lightweight scrape mode: fetch HTML and parse as feed fallback when possible.
    # For unknown sites this returns no items, but keeps the pipeline safe.
    try:
        response = requests.get(source["url"], timeout=12)
        response.raise_for_status()
    except Exception:
        return []
    parsed = feedparser.parse(response.text)
    entries = parsed.entries or []
    out = []
    for ent in entries[:20]:
        title = _normalize_text(getattr(ent, "title", ""))
        link = _normalize_text(getattr(ent, "link", ""))
        if not title or not link:
            continue
        out.append(
            {
                "title": title,
                "url": link,
                "summary": _normalize_text(getattr(ent, "summary", "")),
                "event_date": _parse_date(getattr(ent, "published", "")),
            }
        )
    return out


def _source_items(source):
    tier = source["tier"]
    if tier in ("official", "api", "rss"):
        return _fetch_feed(source)
    if tier == "scrape":
        return _fetch_scrape(source)
    return []


def _eligible_star_wars(item):
    txt = f"{item['title']} {item.get('summary', '')}".lower()
    return "star wars" in txt


def ingest_sources(region, sources):
    total_saved = 0
    total_fetched = 0
    blocked_sources = 0
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
                continue

            items = _source_items(source)
            fetched_count = len(items)
            total_fetched += fetched_count
            for raw in items:
                if not _eligible_star_wars(raw):
                    continue
                category = _classify_category(f"{raw['title']} {raw.get('summary', '')}")
                score = _score_item(source["tier"], raw["title"], raw.get("summary", ""), region)
                release_date = _extract_release_date(
                    raw["title"], raw.get("summary", ""), raw.get("event_date"), region
                )
                status, auto_allowed = _status_for_score(score)
                item = {
                    "item_key": _build_item_key(raw["url"], raw["title"]),
                    "title": raw["title"],
                    "url": raw["url"],
                    "source_name": source["name"],
                    "source_tier": source["tier"],
                    "region": region,
                    "category": category,
                    "event_date": release_date,
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
        total_saved += saved_count
    return {
        "region": region,
        "saved": total_saved,
        "fetched": total_fetched,
        "blocked_sources": blocked_sources,
    }


def ingest_now(region="all"):
    summaries = []
    if region in ("all", "hk"):
        summaries.append(ingest_sources("hk", config.HK_SOURCES))
    if region in ("all", "global"):
        summaries.append(ingest_sources("global", config.GLOBAL_SOURCES))
    return summaries


async def ingest_events_job(context: ContextTypes.DEFAULT_TYPE):
    if not config.ENABLE_EVENT_INGESTION:
        return
    ingest_now("all")


async def publish_auto_approved(context: ContextTypes.DEFAULT_TYPE):
    rows = db.list_unpublished_auto(limit=12)
    for row in rows:
        if db.already_posted("event", row["item_key"]):
            continue
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
            message_thread_id=config.THREADS["general"],
            text=text,
            parse_mode="Markdown",
            disable_web_page_preview=False,
        )
        db.log_post_audit(
            topic="event_update",
            thread_id=config.THREADS["general"],
            telegram_message_id=message.message_id,
            content_type="event",
            content_id=row["item_key"],
            text=text,
        )


async def daily_event_digest(context: ContextTypes.DEFAULT_TYPE):
    hk = db.list_events_by_status("approved", limit=5, region="hk")
    global_items = db.list_events_by_status("approved", limit=5, region="global")

    def _line(row):
        return f"- {row['title']} ({row['category']})"

    parts = ["🗓️ *Daily Star Wars Event Digest*"]
    if hk:
        parts.append("\n*Hong Kong*\n" + "\n".join(_line(r) for r in hk))
    if global_items:
        parts.append("\n*Global*\n" + "\n".join(_line(r) for r in global_items))
    if len(parts) == 1:
        parts.append("\nNo approved items yet. Ingestion is still warming up.")

    message = await context.bot.send_message(
        chat_id=config.GROUP_ID,
        message_thread_id=config.THREADS["general"],
        text="\n".join(parts),
        parse_mode="Markdown",
    )
    db.log_post_audit(
        topic="event_digest",
        thread_id=config.THREADS["general"],
        telegram_message_id=message.message_id,
        content_type="event_digest",
        content_id=f"event_digest:{date.today().isoformat()}",
        text="\n".join(parts),
    )


def _is_admin(update: Update):
    user = update.effective_user
    return bool(user and user.id in config.ADMIN_USER_IDS)


async def review_events(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _is_admin(update):
        await update.message.reply_text("Admin only command.")
        return

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

    total_ok = 0
    total_blocked = 0
    total_error = 0
    lines = ["Source status (latest run per source):"]
    for r in rows:
        status = r["status"]
        if status == "ok":
            total_ok += 1
            marker = "OK"
        elif status.startswith("blocked:"):
            total_blocked += 1
            marker = f"BLOCKED ({status.split(':', 1)[1]})"
        else:
            total_error += 1
            marker = "ERROR"

        lines.append(
            f"- [{r['run_type']}] {r['source_name']} -> {marker} | fetched={r['fetched_count']} saved={r['saved_count']}"
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
    today = date.today()
    filtered = []
    for r in rows:
        event_date = r.get("event_date") if hasattr(r, "get") else r["event_date"]
        if not event_date:
            continue
        try:
            parsed = date.fromisoformat(str(event_date))
        except Exception:
            continue
        if today <= parsed <= (today + timedelta(days=days)):
            filtered.append(r)
        if len(filtered) >= limit:
            break

    if not filtered:
        await update.message.reply_text("No upcoming approved events found for the selected filters.")
        return

    lines = [f"Upcoming Star Wars events ({region}, next {days} days, page {page}):"]
    for r in filtered:
        lines.append(
            f"- #{r['id']} {r['event_date']} | {r['title']} ({r['region']}/{r['category']})"
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
        f"Date: {row['event_date'] or 'TBD'}\n"
        f"Status: {row['status']}\n"
        f"Confidence: {row['confidence']:.2f}\n"
        f"Source: {row['source_name']} ({row['source_tier']})\n\n"
        f"URL: {row['url']}"
    )
    await update.message.reply_text(text, parse_mode="Markdown", disable_web_page_preview=False)


def register(app):
    app.add_handler(CommandHandler("events", events_cmd))
    app.add_handler(CommandHandler("events_detail", events_detail_cmd))
    app.add_handler(CommandHandler("release_calendar", release_calendar_cmd))
    app.add_handler(CommandHandler("review_events", review_events))
    app.add_handler(CommandHandler("approve", approve_event))
    app.add_handler(CommandHandler("reject", reject_event))
    app.add_handler(CommandHandler("ingest_now", ingest_now_cmd))
    app.add_handler(CommandHandler("source_status", source_status_cmd))
