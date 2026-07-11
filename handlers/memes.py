import requests
import praw
from telegram.ext import ContextTypes
from config import (REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET,
                    REDDIT_USER_AGENT, GROUP_ID, THREADS,
                    USE_REDDIT, MEME_PROVIDER_PRIORITY)
import db
from telemetry import mark_scheduler_execution_outcome

SUBS = "StarWarsMemes+PrequelMemes+sequelmemes"
IMGFLIP_API = "https://api.imgflip.com/get_memes"
KEYWORDS = ("star wars", "yoda", "darth", "jedi", "sith", "mandalorian", "clone")


def _valid_reddit_credentials():
    vals = (REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USER_AGENT)
    return all(v and v.strip() and v.strip().lower() != "xxx" for v in vals)


def _build_reddit_client():
    if not USE_REDDIT or not _valid_reddit_credentials():
        return None
    try:
        return praw.Reddit(
            client_id=REDDIT_CLIENT_ID,
            client_secret=REDDIT_CLIENT_SECRET,
            user_agent=REDDIT_USER_AGENT,
            timeout=8,
        )
    except Exception:
        return None


def _reddit_candidates():
    reddit = _build_reddit_client()
    if not reddit:
        return []
    try:
        out = []
        for post in reddit.subreddit(SUBS).top(time_filter="day", limit=25):
            if post.url.endswith((".jpg", ".png", ".jpeg")) and post.score > 50:
                out.append({
                    "id": f"reddit:{post.id}",
                    "url": post.url,
                    "caption": f"😂 {post.title}\n\n(via r/{post.subreddit})",
                })
        return out
    except Exception:
        return []


def _imgflip_candidates():
    try:
        res = requests.get(IMGFLIP_API, timeout=12)
        res.raise_for_status()
        payload = res.json()
        memes = payload.get("data", {}).get("memes", [])
        out = []
        for item in memes:
            name = (item.get("name") or "").lower()
            if any(k in name for k in KEYWORDS):
                out.append({
                    "id": f"imgflip:{item.get('id')}",
                    "url": item.get("url"),
                    "caption": f"😂 Meme template challenge: {item.get('name')}",
                })
        return out
    except Exception:
        return []

async def daily_meme(context: ContextTypes.DEFAULT_TYPE):
    provider_map = {
        "reddit": _reddit_candidates,
        "imgflip": _imgflip_candidates,
    }

    provider_counts = {}
    thread_id = db.resolve_thread_id("memes", default=THREADS["memes"])

    for provider in MEME_PROVIDER_PRIORITY:
        fetch = provider_map.get(provider)
        if not fetch:
            continue
        candidates = fetch()
        provider_counts[provider] = len(candidates)
        for candidate in candidates:
            meme_id = candidate.get("id")
            meme_url = candidate.get("url")
            if not meme_id or not meme_url:
                continue
            if db.already_posted("meme", meme_id):
                continue
            caption = candidate.get("caption") or "😂 Daily meme drop"
            message = await context.bot.send_photo(
                chat_id=GROUP_ID,
                message_thread_id=thread_id,
                photo=meme_url,
                caption=caption,
            )
            db.log_post_audit(
                topic="meme",
                thread_id=thread_id,
                telegram_message_id=message.message_id,
                content_type="meme",
                content_id=meme_id,
                text=caption,
            )
            mark_scheduler_execution_outcome(
                context,
                "sent",
                message_id=message.message_id,
                content_type="meme",
                content_id=meme_id,
            )
            return

    if provider_counts:
        detail = ", ".join(f"{name}:{count}" for name, count in provider_counts.items())
        mark_scheduler_execution_outcome(context, "no_content", error=f"meme provider exhaustion ({detail})")