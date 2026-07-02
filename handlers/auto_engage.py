import hashlib
import random
import re
from datetime import datetime, timezone

from telegram import Update
from telegram.ext import ContextTypes, MessageHandler, filters

import config
import db
from admin import runtime_settings
from llm.client import generate_reply

STAR_WARS_HINTS = (
    "jedi",
    "sith",
    "lightsaber",
    "skywalker",
    "mandalorian",
    "grogu",
    "force",
    "clone",
    "andor",
    "ahsoka",
    "vader",
)

MEME_HINTS = (
    "meme",
    "template",
    "lol",
    "lmao",
    "haha",
    "funny",
    "shitpost",
)

FALLBACK_LINES = [
    "That hits harder than Order 66. Keep it coming.",
    "Strong post. Council-approved.",
    "Lore check passed. The Force is pleased.",
    "Peak thread energy right now.",
    "This belongs in the Jedi archives.",
    "Certified galactic banter.",
]


def _safe_text(message):
    return (message.text or message.caption or "").strip()


def _allowed_thread(thread_id):
    if thread_id is None:
        return False
    allowed_ids = {
        int(v)
        for k, v in config.THREADS.items()
        if k in config.LLM_ALLOWED_THREAD_NAMES and int(v) > 0
    }
    return thread_id in allowed_ids


def _normalize_line(v, max_len=220):
    cleaned = re.sub(r"\s+", " ", str(v or "")).strip()
    if len(cleaned) <= max_len:
        return cleaned
    return cleaned[: max_len - 3].rstrip() + "..."


def _score_trigger(text, is_reply_to_bot, is_meme_context, mentions_bot):
    low = text.lower()
    score = 0.0

    if "?" in text:
        score += 0.35
    if is_reply_to_bot:
        score += 0.45
    if mentions_bot:
        score += 0.4
    if is_meme_context:
        score += 0.4
    if any(token in low for token in STAR_WARS_HINTS):
        score += 0.2
    if any(token in low for token in MEME_HINTS):
        score += 0.2
    if len(text) > 120:
        score += 0.05

    return min(score, 1.0)


def _fingerprint(thread_id, text):
    normalized = re.sub(r"\W+", " ", (text or "").lower()).strip()
    payload = f"{thread_id}|{normalized[:220]}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def _reply_from_fallback(is_meme_context=False):
    line = random.choice(FALLBACK_LINES)
    if is_meme_context:
        return f"{line} Meme reactor core stable."
    return line


def _build_prompt(user_name, text, parent_text, is_meme_context):
    mode = "meme reaction" if is_meme_context else "thread reply"
    system = (
        "You are a witty Star Wars community bot. "
        "Keep replies short (1-2 lines), clever, and friendly. "
        "Never be rude, hateful, sexual, political, or toxic. "
        "Avoid roleplay violence. No markdown."
    )

    user = (
        f"Mode: {mode}\n"
        f"User: {_normalize_line(user_name, 60)}\n"
        f"Message: {_normalize_line(text, 340)}\n"
        f"Replied context: {_normalize_line(parent_text, 220)}\n"
        "Write one sharp response that sounds natural in a Telegram thread."
    )

    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def _runtime_enabled():
    return bool(runtime_settings.get("enable_llm_autonomy"))


def _runtime_cap(name, minimum):
    return max(minimum, int(runtime_settings.get(name)))


def _runtime_float(name, minimum, maximum):
    value = float(runtime_settings.get(name))
    return min(maximum, max(minimum, value))


async def auto_engage(update: Update, context: ContextTypes.DEFAULT_TYPE):
    message = update.effective_message
    user = update.effective_user
    chat = update.effective_chat

    if not message or not user or not chat:
        return
    if user.is_bot:
        return
    if chat.id != config.GROUP_ID:
        return
    if not _runtime_enabled():
        return

    thread_id = message.message_thread_id
    if not _allowed_thread(thread_id):
        return

    text = _safe_text(message)
    if not text:
        return

    max_chars = _runtime_cap("llm_max_input_chars", 80)
    text = text[:max_chars]

    bot_username = (context.bot.username or "").lower().strip("@")
    mentions_bot = bool(bot_username and re.search(rf"@{re.escape(bot_username)}\b", text.lower()))

    replied = message.reply_to_message
    replied_user = replied.from_user if replied else None
    is_reply_to_bot = bool(replied_user and replied_user.is_bot)
    parent_text = _safe_text(replied) if replied else ""

    meme_context = bool(
        replied
        and (
            replied.photo
            or replied.animation
            or replied.sticker
            or replied.document
            or any(k in (parent_text.lower() + " " + text.lower()) for k in MEME_HINTS)
        )
    )

    trigger_score = _score_trigger(
        text=text,
        is_reply_to_bot=is_reply_to_bot,
        is_meme_context=meme_context,
        mentions_bot=mentions_bot,
    )

    minimum_score = _runtime_float("llm_min_trigger_score", 0.1, 1.0)
    random_chance = _runtime_float("llm_random_reply_chance", 0.0, 1.0)
    if trigger_score < minimum_score and random.random() > random_chance:
        db.log_llm_action(
            action_type="reply",
            status="skipped",
            reason="trigger-threshold",
            chat_id=chat.id,
            thread_id=thread_id,
            user_id=user.id,
            source_message_id=message.message_id,
            trigger_score=trigger_score,
        )
        return

    daily_cap = _runtime_cap("llm_reply_daily_cap", 1)
    thread_cap = _runtime_cap("llm_reply_thread_daily_cap", 1)
    if db.count_llm_actions_today(status="sent") >= daily_cap:
        db.log_llm_action(
            action_type="reply",
            status="skipped",
            reason="daily-cap",
            chat_id=chat.id,
            thread_id=thread_id,
            user_id=user.id,
            source_message_id=message.message_id,
            trigger_score=trigger_score,
        )
        return
    if db.count_llm_actions_today(status="sent", thread_id=thread_id) >= thread_cap:
        db.log_llm_action(
            action_type="reply",
            status="skipped",
            reason="thread-cap",
            chat_id=chat.id,
            thread_id=thread_id,
            user_id=user.id,
            source_message_id=message.message_id,
            trigger_score=trigger_score,
        )
        return

    cooldown = _runtime_cap("llm_reply_cooldown_seconds", 0)
    latest = db.latest_llm_action(thread_id=thread_id, status="sent")
    now = datetime.now(timezone.utc)
    if latest and int((now - latest).total_seconds()) < cooldown:
        db.log_llm_action(
            action_type="reply",
            status="skipped",
            reason="cooldown",
            chat_id=chat.id,
            thread_id=thread_id,
            user_id=user.id,
            source_message_id=message.message_id,
            trigger_score=trigger_score,
        )
        return

    fp = _fingerprint(thread_id, f"{text}|{parent_text}")
    if db.has_recent_llm_fingerprint(fp, seconds=max(600, cooldown * 3)):
        db.log_llm_action(
            action_type="reply",
            status="skipped",
            reason="duplicate-fingerprint",
            chat_id=chat.id,
            thread_id=thread_id,
            user_id=user.id,
            source_message_id=message.message_id,
            trigger_score=trigger_score,
            fingerprint=fp,
        )
        return

    prompt = _build_prompt(
        user_name=user.username or user.first_name or "member",
        text=text,
        parent_text=parent_text,
        is_meme_context=meme_context,
    )

    model_result = generate_reply(prompt)
    response_text = ""
    model_error = None
    if model_result.get("ok"):
        response_text = _normalize_line(model_result.get("text", ""), max_len=320)
    else:
        model_error = model_result.get("error") or "unknown"
        response_text = _reply_from_fallback(is_meme_context=meme_context)

    if not response_text:
        db.log_llm_action(
            action_type="reply",
            status="error",
            reason="empty-response",
            chat_id=chat.id,
            thread_id=thread_id,
            user_id=user.id,
            source_message_id=message.message_id,
            provider=model_result.get("provider"),
            model=model_result.get("model"),
            latency_ms=model_result.get("latency_ms"),
            prompt_chars=sum(len(m.get("content", "")) for m in prompt),
            response_chars=0,
            trigger_score=trigger_score,
            fingerprint=fp,
            error=model_error,
        )
        return

    try:
        sent = await context.bot.send_message(
            chat_id=chat.id,
            message_thread_id=thread_id,
            text=response_text,
            reply_to_message_id=message.message_id,
            allow_sending_without_reply=True,
        )
    except Exception as exc:
        db.log_llm_action(
            action_type="reply",
            status="error",
            reason="send-failed",
            chat_id=chat.id,
            thread_id=thread_id,
            user_id=user.id,
            source_message_id=message.message_id,
            provider=model_result.get("provider"),
            model=model_result.get("model"),
            latency_ms=model_result.get("latency_ms"),
            prompt_chars=sum(len(m.get("content", "")) for m in prompt),
            response_chars=len(response_text),
            trigger_score=trigger_score,
            fingerprint=fp,
            error=str(exc),
        )
        return

    db.log_post_audit(
        topic="llm_reply",
        thread_id=thread_id,
        telegram_message_id=sent.message_id,
        content_type="llm_reply",
        content_id=f"llm:{message.message_id}:{fp}",
        text=response_text,
    )
    db.log_llm_action(
        action_type="reply",
        status="sent",
        reason="fallback" if model_error else "model",
        chat_id=chat.id,
        thread_id=thread_id,
        user_id=user.id,
        source_message_id=message.message_id,
        response_message_id=sent.message_id,
        provider=model_result.get("provider"),
        model=model_result.get("model"),
        latency_ms=model_result.get("latency_ms"),
        prompt_chars=sum(len(m.get("content", "")) for m in prompt),
        response_chars=len(response_text),
        trigger_score=trigger_score,
        fingerprint=fp,
        error=model_error,
    )


def register(app):
    app.add_handler(MessageHandler((filters.TEXT | filters.CAPTION) & ~filters.COMMAND, auto_engage))
