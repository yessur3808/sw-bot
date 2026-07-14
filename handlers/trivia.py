import random

from telegram.ext import ContextTypes

from config import GROUP_ID, get_thread_id
import db
from telemetry import mark_scheduler_execution_outcome

QUESTIONS = db.get_dataset_items("trivia")


def _shuffled(items):
    pool = list(items or [])
    random.shuffle(pool)
    return pool


def _pick_text(item, keys):
    if isinstance(item, str):
        return item.strip()
    if isinstance(item, dict):
        for key in keys:
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return ""


async def daily_trivia(context: ContextTypes.DEFAULT_TYPE):
    selected = None
    question = ""
    options = None
    correct = None
    content_id = None
    raw = ""
    for item in _shuffled(QUESTIONS):
        question = _pick_text(item, ("q", "question", "prompt"))
        options = item.get("options") if isinstance(item, dict) else None
        correct = item.get("correct") if isinstance(item, dict) else None
        if not question or not isinstance(options, list) or len(options) < 2:
            continue
        if not isinstance(correct, int) or correct < 0 or correct >= len(options):
            continue
        raw = f"{question}|{'|'.join([str(v) for v in options])}|{correct}"
        candidate_id = f"trivia:{db.compute_text_hash(raw)[:16]}"
        if db.already_posted("trivia", candidate_id):
            continue
        selected = item
        content_id = candidate_id
        break

    if selected is None or not content_id:
        return

    thread_id = get_thread_id("general")
    message = await context.bot.send_poll(
        chat_id=GROUP_ID,
        message_thread_id=thread_id,
        question="🧠 " + question,
        options=options,
        type="quiz",
        correct_option_id=correct,
        is_anonymous=False,
    )
    db.log_post_audit(
        topic="trivia",
        thread_id=thread_id,
        telegram_message_id=message.message_id,
        content_type="trivia",
        content_id=content_id,
        text=raw,
    )
    mark_scheduler_execution_outcome(
        context,
        "sent",
        message_id=message.message_id,
        content_type="trivia",
        content_id=content_id,
    )