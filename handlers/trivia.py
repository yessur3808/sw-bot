import json, random
from telegram.ext import ContextTypes
from config import GROUP_ID, THREADS
import db
from telemetry import mark_scheduler_execution_outcome

with open("data/trivia.json", encoding="utf-8") as f:
    QUESTIONS = json.load(f)


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
    q = random.choice(QUESTIONS)
    question = _pick_text(q, ("q", "question", "prompt"))
    options = q.get("options") if isinstance(q, dict) else None
    correct = q.get("correct") if isinstance(q, dict) else None
    if not question or not isinstance(options, list) or len(options) < 2:
        return
    if not isinstance(correct, int) or correct < 0 or correct >= len(options):
        return

    message = await context.bot.send_poll(
        chat_id=GROUP_ID,
        message_thread_id=THREADS["general"],
        question="🧠 " + question,
        options=options,
        type="quiz",
        correct_option_id=correct,
        is_anonymous=False,
    )
    raw = f"{question}|{'|'.join([str(v) for v in options])}|{correct}"
    db.log_post_audit(
        topic="trivia",
        thread_id=THREADS["general"],
        telegram_message_id=message.message_id,
        content_type="trivia",
        content_id=f"trivia:{db.compute_text_hash(raw)[:16]}",
        text=raw,
    )
    mark_scheduler_execution_outcome(
        context,
        "sent",
        message_id=message.message_id,
        content_type="trivia",
        content_id=f"trivia:{db.compute_text_hash(raw)[:16]}",
    )