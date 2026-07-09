import random
from html import unescape
from urllib.parse import urlparse

import feedparser
import requests
from telegram.ext import ContextTypes
import config
import db
from telemetry import mark_scheduler_execution_outcome

API = "https://wallhaven.cc/api/v1/search"


def _extract_urls_from_text(text):
    out = []
    for token in str(text or "").replace("\n", " ").split(" "):
        candidate = token.strip().strip('"\'()<>')
        if candidate.startswith(("http://", "https://")):
            out.append(candidate)
    return out


def _looks_like_image(url):
    low = str(url or "").lower()
    return any(ext in low for ext in (".jpg", ".jpeg", ".png", ".webp"))


def _domain(url):
    return (urlparse(str(url or "")).hostname or "").lower()


def _feed_candidates(feed_urls, source_label):
    out = []
    fetch_limit = max(1, int(config.WALLPAPER_FEED_FETCH_LIMIT))
    for feed_url in feed_urls:
        try:
            parsed = feedparser.parse(feed_url)
            entries = parsed.entries or []
        except Exception:
            continue

        for ent in entries[:fetch_limit]:
            title = unescape(str(getattr(ent, "title", "") or "").strip())
            link = str(getattr(ent, "link", "") or "").strip()
            summary = str(getattr(ent, "summary", "") or "")

            candidates = []
            for media in getattr(ent, "media_content", []) or []:
                maybe = str((media or {}).get("url") or "").strip()
                if maybe:
                    candidates.append(maybe)
            for enclosure in getattr(ent, "enclosures", []) or []:
                maybe = str((enclosure or {}).get("href") or "").strip()
                if maybe:
                    candidates.append(maybe)
            candidates.extend(_extract_urls_from_text(summary))
            if link:
                candidates.append(link)

            image_url = next((u for u in candidates if _looks_like_image(u)), None)
            if not image_url:
                continue

            content_id = f"{source_label}:{db.compute_text_hash(image_url)[:16]}"
            caption = (
                f"📱 Wallpaper of the day ({source_label})\n"
                f"{title[:120] if title else 'Star Wars wallpaper'}\n"
                f"Source: {link or feed_url}"
            )
            out.append(
                {
                    "id": content_id,
                    "photo": image_url,
                    "caption": caption,
                    "source": source_label,
                }
            )
    random.shuffle(out)
    return out


def _wallhaven_candidates():
    params = {
        "q": "star wars",
        "categories": "010",   # general
        "purity": "100",       # SFW only
        "ratios": "9x16",      # phone-friendly
        "sorting": "random",
    }
    try:
        response = requests.get(API, params=params, timeout=15)
        response.raise_for_status()
        payload = response.json()
    except Exception:
        return []

    out = []
    for wp in payload.get("data", []):
        content_id = f"wallhaven:{wp.get('id')}"
        path = wp.get("path")
        thumb = (wp.get("thumbs") or {}).get("large")
        if not content_id or not thumb:
            continue
        out.append(
            {
                "id": content_id,
                "photo": thumb,
                "caption": f"📱 Wallpaper of the day\nFull res: {path}",
                "source": "wallhaven",
            }
        )
    return out


def _pinterest_candidates():
    return _feed_candidates(config.PINTEREST_WALLPAPER_FEEDS, "pinterest")


def _instagram_candidates():
    return _feed_candidates(config.INSTAGRAM_WALLPAPER_FEEDS, "instagram")

async def daily_wallpaper(context: ContextTypes.DEFAULT_TYPE):
    provider_map = {
        "wallhaven": _wallhaven_candidates,
        "pinterest": _pinterest_candidates,
        "instagram": _instagram_candidates,
    }
    thread_id = config.get_thread_id("wallpapers") or config.get_chat_thread_id() or config.THREADS["wallpapers"]
    provider_counts = {}

    for provider in config.WALLPAPER_PROVIDER_PRIORITY:
        fetch = provider_map.get(provider)
        if not fetch:
            continue
        candidates = fetch()
        provider_counts[provider] = len(candidates)
        for candidate in candidates:
            wallpaper_id = candidate.get("id")
            photo = candidate.get("photo")
            caption = candidate.get("caption") or "📱 Wallpaper of the day"
            if not wallpaper_id or not photo:
                continue
            if not db.already_posted("wallpaper", wallpaper_id):
                message = await context.bot.send_photo(
                    chat_id=config.GROUP_ID,
                    message_thread_id=thread_id,
                    photo=photo,
                    caption=caption,
                )
                db.log_post_audit(
                    topic=f"wallpaper:{candidate.get('source', provider)}",
                    thread_id=thread_id,
                    telegram_message_id=message.message_id,
                    content_type="wallpaper",
                    content_id=wallpaper_id,
                    text=caption,
                )
                mark_scheduler_execution_outcome(
                    context,
                    "sent",
                    message_id=message.message_id,
                    content_type="wallpaper",
                    content_id=wallpaper_id,
                )
                return

    if provider_counts:
        detail = ", ".join(f"{name}:{count}" for name, count in provider_counts.items())
        mark_scheduler_execution_outcome(context, "no_content", error=f"wallpaper provider exhaustion ({detail})")