import hashlib
from datetime import datetime, timezone

import praw
import requests
from telegram import Update
from telegram.ext import CommandHandler, ContextTypes

import config
import db
from admin import runtime_settings


IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp")


def _valid_reddit_credentials():
    vals = (config.REDDIT_CLIENT_ID, config.REDDIT_CLIENT_SECRET, config.REDDIT_USER_AGENT)
    return all(v and v.strip() and v.strip().lower() != "xxx" for v in vals)


def _reddit_client():
    if not config.USE_REDDIT or not _valid_reddit_credentials():
        return None
    try:
        return praw.Reddit(
            client_id=config.REDDIT_CLIENT_ID,
            client_secret=config.REDDIT_CLIENT_SECRET,
            user_agent=config.REDDIT_USER_AGENT,
            timeout=10,
        )
    except Exception:
        return None


def _reddit_enabled():
    return bool(runtime_settings.get("enable_reddit_ingest"))


def _relay_enabled():
    return bool(runtime_settings.get("enable_reddit_relay"))


def _safety_banned_subreddits():
    configured = str(runtime_settings.get("reddit_banned_subreddits") or "")
    values = {s.strip().lower() for s in configured.split(",") if s.strip()}
    if not values:
        values = set(config.REDDIT_BANNED_SUBREDDITS)
    return values


def _safety_banned_words():
    configured = str(runtime_settings.get("reddit_banned_words") or "")
    values = [s.strip().lower() for s in configured.split(",") if s.strip()]
    if not values:
        values = list(config.REDDIT_BANNED_WORDS)
    return values


def _as_utc_iso(ts):
    try:
        return datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat()
    except Exception:
        return None


def _item_key(kind, source_id, body):
    raw = f"{kind}|{source_id}|{(body or '').strip().lower()[:220]}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _iter_top_comments(post, limit, min_score):
    try:
        post.comments.replace_more(limit=0)
        comments = [c for c in post.comments if hasattr(c, "body")]
    except Exception:
        return []

    comments.sort(key=lambda c: int(getattr(c, "score", 0) or 0), reverse=True)
    out = []
    for c in comments:
        score = int(getattr(c, "score", 0) or 0)
        if score < min_score:
            continue
        body = str(getattr(c, "body", "") or "").strip()
        if not body:
            continue
        out.append(c)
        if len(out) >= limit:
            break
    return out


def ingest_now():
    if not _reddit_enabled():
        return {
            "ok": False,
            "reason": "reddit-ingest-disabled",
            "saved": 0,
            "posts": 0,
            "comments": 0,
            "errors": [],
        }

    reddit = _reddit_client()
    if not reddit:
        return {
            "ok": False,
            "reason": "reddit-client-unavailable",
            "saved": 0,
            "posts": 0,
            "comments": 0,
            "errors": ["Missing or invalid Reddit credentials"],
        }

    post_limit = max(1, int(runtime_settings.get("reddit_post_limit")))
    comments_per_post = max(0, int(runtime_settings.get("reddit_comments_per_post")))
    min_post_score = int(runtime_settings.get("reddit_min_post_score"))
    min_comment_score = int(runtime_settings.get("reddit_min_comment_score"))

    subreddits = config.REDDIT_SUBREDDITS or ["StarWars"]
    saved = 0
    posts_seen = 0
    comments_seen = 0
    errors = []

    for name in subreddits:
        try:
            sr = reddit.subreddit(name)
            listing = sr.hot(limit=post_limit)
            for post in listing:
                score = int(getattr(post, "score", 0) or 0)
                if score < min_post_score:
                    continue
                posts_seen += 1
                post_body = str(getattr(post, "selftext", "") or "").strip()
                media_url = str(getattr(post, "url", "") or "").strip()
                title = str(getattr(post, "title", "") or "").strip()

                db.reddit_cache_upsert(
                    {
                        "content_type": "post",
                        "source_id": f"post:{post.id}",
                        "dedupe_key": _item_key("post", post.id, f"{title}|{post_body}"),
                        "subreddit": name,
                        "parent_post_id": None,
                        "permalink": f"https://reddit.com{getattr(post, 'permalink', '')}",
                        "author": str(getattr(post, "author", "") or "unknown"),
                        "title": title,
                        "body": post_body[:1600],
                        "media_url": media_url if media_url.lower().endswith(IMAGE_EXT) else None,
                        "score": score,
                        "created_utc": _as_utc_iso(getattr(post, "created_utc", None)),
                    }
                )
                saved += 1

                if comments_per_post <= 0:
                    continue
                for comment in _iter_top_comments(post, comments_per_post, min_comment_score):
                    comments_seen += 1
                    c_body = str(getattr(comment, "body", "") or "").strip()
                    db.reddit_cache_upsert(
                        {
                            "content_type": "comment",
                            "source_id": f"comment:{comment.id}",
                            "dedupe_key": _item_key("comment", comment.id, c_body),
                            "subreddit": name,
                            "parent_post_id": post.id,
                            "permalink": f"https://reddit.com{getattr(comment, 'permalink', '')}",
                            "author": str(getattr(comment, "author", "") or "unknown"),
                            "title": title,
                            "body": c_body[:1600],
                            "media_url": None,
                            "score": int(getattr(comment, "score", 0) or 0),
                            "created_utc": _as_utc_iso(getattr(comment, "created_utc", None)),
                        }
                    )
                    saved += 1
        except Exception as exc:
            errors.append(f"r/{name}: {exc}")

    return {
        "ok": len(errors) == 0,
        "saved": saved,
        "posts": posts_seen,
        "comments": comments_seen,
        "errors": errors,
    }


def _relay_thread_id():
    configured = config.get_thread_id(config.REDDIT_RELAY_THREAD)
    if configured:
        return configured
    return config.get_thread_id("memes") or config.get_thread_id("general") or config.THREADS.get("general", 0)


def _relay_text(row):
    content_type = row.get("content_type") if hasattr(row, "get") else row[1]
    subreddit = row.get("subreddit") if hasattr(row, "get") else row[4]
    score = row.get("score") if hasattr(row, "get") else row[11]
    author = row.get("author") if hasattr(row, "get") else row[7]
    title = (row.get("title") if hasattr(row, "get") else row[8]) or ""
    body = (row.get("body") if hasattr(row, "get") else row[9]) or ""
    permalink = (row.get("permalink") if hasattr(row, "get") else row[6]) or ""

    if content_type == "comment":
        head = "Reddit comment spotlight"
        core = body[:300]
    else:
        head = "Reddit post spotlight"
        core = (title or body)[:300]

    core = " ".join(core.split())
    return f"{head} | r/{subreddit} | score {score}\n{core}\nby u/{author}\n{permalink}".strip()


def _row_value(row, key, idx):
    if hasattr(row, "get"):
        return row.get(key)
    return row[idx]


def _safety_check_row(row):
    subreddit = str(_row_value(row, "subreddit", 4) or "").strip().lower()
    title = str(_row_value(row, "title", 8) or "")
    body = str(_row_value(row, "body", 9) or "")
    blob = f"{title} {body}".lower()

    if subreddit and subreddit in _safety_banned_subreddits():
        return False, f"banned-subreddit:{subreddit}"

    for token in _safety_banned_words():
        if token and token in blob:
            return False, f"banned-word:{token}"

    return True, None


def _send_telegram_sync(text, media_url, thread_id):
    if media_url:
        endpoint = f"https://api.telegram.org/bot{config.BOT_TOKEN}/sendPhoto"
        payload = {
            "chat_id": config.GROUP_ID,
            "message_thread_id": thread_id,
            "photo": media_url,
            "caption": text[:1024],
        }
    else:
        endpoint = f"https://api.telegram.org/bot{config.BOT_TOKEN}/sendMessage"
        payload = {
            "chat_id": config.GROUP_ID,
            "message_thread_id": thread_id,
            "text": text,
            "disable_web_page_preview": False,
        }

    response = requests.post(endpoint, json=payload, timeout=15)
    response.raise_for_status()
    data = response.json()
    if not data.get("ok"):
        raise RuntimeError(str(data))
    return data.get("result") or {}


def force_relay_cache_item(cache_id, force=True):
    row = db.reddit_cache_by_id(cache_id)
    if not row:
        return {"ok": False, "reason": "not-found"}

    if int(_row_value(row, "relayed", 14) or 0) == 1 and not force:
        return {"ok": False, "reason": "already-relayed"}

    allowed, reason = _safety_check_row(row)
    if not allowed and not force:
        db.mark_reddit_blocked(cache_id, reason)
        return {"ok": False, "reason": reason}

    db.clear_reddit_blocked(cache_id)
    thread_id = _relay_thread_id()
    media_url = str(_row_value(row, "media_url", 10) or "")
    text = _relay_text(row)
    try:
        result = _send_telegram_sync(text, media_url, thread_id)
    except Exception as exc:
        return {"ok": False, "reason": f"send-failed:{exc}"}

    message_id = result.get("message_id")
    db.mark_reddit_relayed(cache_id, message_id=message_id, thread_id=thread_id)
    db.log_post_audit(
        topic="reddit_relay",
        thread_id=thread_id,
        telegram_message_id=message_id,
        content_type="reddit",
        content_id=f"reddit_cache:{cache_id}",
        text=text,
    )
    return {"ok": True, "message_id": message_id, "forced": bool(force)}


async def relay_from_cache(context: ContextTypes.DEFAULT_TYPE):
    if not _relay_enabled():
        return

    batch = max(1, int(runtime_settings.get("reddit_relay_batch_size")))
    rows = db.reddit_unrelayed(limit=batch)
    if not rows:
        return

    thread_id = _relay_thread_id()
    for row in rows:
        cache_id = row.get("id") if hasattr(row, "get") else row[0]
        allowed, reason = _safety_check_row(row)
        if not allowed:
            db.mark_reddit_blocked(cache_id, reason)
            continue

        media_url = (row.get("media_url") if hasattr(row, "get") else row[10]) or ""
        text = _relay_text(row)

        try:
            if media_url:
                sent = await context.bot.send_photo(
                    chat_id=config.GROUP_ID,
                    message_thread_id=thread_id,
                    photo=media_url,
                    caption=text[:1024],
                )
            else:
                sent = await context.bot.send_message(
                    chat_id=config.GROUP_ID,
                    message_thread_id=thread_id,
                    text=text,
                    disable_web_page_preview=False,
                )
        except Exception:
            continue

        db.mark_reddit_relayed(cache_id, message_id=sent.message_id, thread_id=thread_id)
        db.log_post_audit(
            topic="reddit_relay",
            thread_id=thread_id,
            telegram_message_id=sent.message_id,
            content_type="reddit",
            content_id=f"reddit_cache:{cache_id}",
            text=text,
        )


async def ingest_job(context: ContextTypes.DEFAULT_TYPE):
    ingest_now()


async def relay_job(context: ContextTypes.DEFAULT_TYPE):
    await relay_from_cache(context)


async def reddit_ingest_now_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if not (user and db.is_admin_user(user.id)):
        await update.message.reply_text("Admin only command.")
        return
    summary = ingest_now()
    await update.message.reply_text(
        f"Reddit ingest: saved={summary.get('saved', 0)} posts={summary.get('posts', 0)} comments={summary.get('comments', 0)} errors={len(summary.get('errors', []))}"
        + (f"\n{summary['errors'][0]}" if summary.get("errors") else "")
    )


async def reddit_digest_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    limit = 3
    if context.args and context.args[0].isdigit():
        limit = max(1, min(10, int(context.args[0])))
    rows = db.reddit_unrelayed(limit=limit)
    if not rows:
        await update.message.reply_text("No unrelayed Reddit items in cache.")
        return

    lines = ["Reddit cache preview:"]
    for row in rows:
        content_type = row.get("content_type") if hasattr(row, "get") else row[1]
        subreddit = row.get("subreddit") if hasattr(row, "get") else row[4]
        score = row.get("score") if hasattr(row, "get") else row[11]
        title = (row.get("title") if hasattr(row, "get") else row[8]) or ""
        body = (row.get("body") if hasattr(row, "get") else row[9]) or ""
        text = (title or body).replace("\n", " ").strip()
        lines.append(f"- [{content_type}] r/{subreddit} score={score} {text[:120]}")
    await update.message.reply_text("\n".join(lines))


def register(app):
    app.add_handler(CommandHandler("reddit_ingest_now", reddit_ingest_now_cmd))
    app.add_handler(CommandHandler("reddit_digest", reddit_digest_cmd))
