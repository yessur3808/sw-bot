import json, random
from telegram.ext import ContextTypes
from config import GROUP_ID, THREADS
import db

with open("data/trivia.json", encoding="utf-8") as f:
    QUESTIONS = json.load(f)

async def daily_trivia(context: ContextTypes.DEFAULT_TYPE):
    q = random.choice(QUESTIONS)
    message = await context.bot.send_poll(
        chat_id=GROUP_ID,
        message_thread_id=THREADS["lore"],
        question="🧠 " + q["q"],
        options=q["options"],
        type="quiz",
        correct_option_id=q["correct"],
        is_anonymous=False,
    )
    raw = f"{q['q']}|{'|'.join(q['options'])}|{q['correct']}"
    db.log_post_audit(
        topic="trivia",
        thread_id=THREADS["lore"],
        telegram_message_id=message.message_id,
        content_type="trivia",
        content_id=f"trivia:{db.compute_text_hash(raw)[:16]}",
        text=raw,
    )