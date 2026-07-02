import json, random
from telegram.ext import ContextTypes
from config import GROUP_ID, THREADS
import db

with open("data/quotes.json", encoding="utf-8") as f:
    QUOTES = json.load(f)

with open("data/facts.json", encoding="utf-8") as f:
    FACTS = json.load(f)

with open("data/polls.json", encoding="utf-8") as f:
    POLLS = json.load(f)

async def daily_quote(context: ContextTypes.DEFAULT_TYPE):
    quote = random.choice(QUOTES)
    text = f"💬 *Quote of the Day*\n\n_{quote}_"
    message = await context.bot.send_message(
        chat_id=GROUP_ID,
        message_thread_id=THREADS["general"],
        text=text,
        parse_mode="Markdown",
    )
    db.log_post_audit(
        topic="quote",
        thread_id=THREADS["general"],
        telegram_message_id=message.message_id,
        content_type="quote",
        content_id=f"quote:{db.compute_text_hash(quote)[:16]}",
        text=text,
    )


async def daily_fact(context: ContextTypes.DEFAULT_TYPE):
    fact = random.choice(FACTS)
    text = f"🛰️ *Random Star Wars Fact*\n\n{fact}"
    message = await context.bot.send_message(
        chat_id=GROUP_ID,
        message_thread_id=THREADS["general"],
        text=text,
        parse_mode="Markdown",
    )
    db.log_post_audit(
        topic="fact",
        thread_id=THREADS["general"],
        telegram_message_id=message.message_id,
        content_type="fact",
        content_id=f"fact:{db.compute_text_hash(fact)[:16]}",
        text=text,
    )


async def daily_vote_poll(context: ContextTypes.DEFAULT_TYPE):
    poll = random.choice(POLLS)
    message = await context.bot.send_poll(
        chat_id=GROUP_ID,
        message_thread_id=THREADS["general"],
        question=f"🗳️ {poll['q']}",
        options=poll["options"],
        is_anonymous=False,
    )
    raw = f"{poll['q']}|{'|'.join(poll['options'])}"
    db.log_post_audit(
        topic="poll",
        thread_id=THREADS["general"],
        telegram_message_id=message.message_id,
        content_type="poll",
        content_id=f"poll:{db.compute_text_hash(raw)[:16]}",
        text=raw,
    )