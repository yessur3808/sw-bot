import json, random
from datetime import datetime, timezone
from telegram.ext import ContextTypes
from config import GROUP_ID, THREADS, get_thread_id, RELEASE_TIMEZONE, HK_PUBLIC_HOLIDAYS
import db
from telemetry import mark_scheduler_execution_outcome

try:
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover
    ZoneInfo = None

with open("data/quotes.json", encoding="utf-8") as f:
    QUOTES = json.load(f)

with open("data/facts.json", encoding="utf-8") as f:
    FACTS = json.load(f)

with open("data/polls.json", encoding="utf-8") as f:
    POLLS = json.load(f)

try:
    with open("data/discussions.json", encoding="utf-8") as f:
        DISCUSSIONS = json.load(f)
except FileNotFoundError:
    DISCUSSIONS = []


MOVIE_KEYWORDS = (
    "movie",
    "film",
    "cinema",
    "box office",
    "episode i",
    "episode ii",
    "episode iii",
    "episode iv",
    "episode v",
    "episode vi",
    "episode vii",
    "episode viii",
    "episode ix",
    "the phantom menace",
    "attack of the clones",
    "revenge of the sith",
    "a new hope",
    "the empire strikes back",
    "return of the jedi",
    "the force awakens",
    "the last jedi",
    "the rise of skywalker",
    "rogue one",
    "solo",
)

SHOW_KEYWORDS = (
    "series",
    "show",
    "season",
    "episode",
    "streaming",
    "disney+",
    "the mandalorian",
    "ahsoka",
    "andor",
    "the acolyte",
    "skeleton crew",
    "obi-wan kenobi",
    "the book of boba fett",
    "clone wars",
    "bad batch",
    "rebels",
    "visions",
)

GENERAL_KEYWORDS = (
    "happy friday",
    "weekend",
    "community",
    "favorite",
    "favourite",
    "fun fact",
)

MAY_THE_FOURTH_GREETINGS = [
    "May the Fourth be with you, always. 🌟",
    "Happy Star Wars Day. May the Fourth be with you. ✨",
    "May the Fourth be with you. Time for a galactic rewatch. 🎬",
]

FRIDAY_GREETINGS = [
    "Happy Friday, troopers. You made it. 🎉",
    "TGI Friday. May the Force carry you into the weekend. 🌌",
    "Friday mode: lightsabers up, stress down. ⚔️",
]

HK_HOLIDAY_GREETINGS = [
    "Happy Hong Kong public holiday. Enjoy the break and may the Force be with you. 🎊",
    "Holiday vibes in Hong Kong today. Keep it fun, keep it Star Wars. 🌠",
    "Public holiday in Hong Kong today. Wishing everyone a relaxing day. 🛰️",
]


def _classify_fact_topic(fact_text):
    low = (fact_text or "").lower()
    if any(token in low for token in SHOW_KEYWORDS):
        return "show"
    if any(token in low for token in MOVIE_KEYWORDS):
        return "movie"
    if any(token in low for token in GENERAL_KEYWORDS):
        return "general"
    return "lore"


def _pick_text(item, keys):
    if isinstance(item, str):
        return item.strip()
    if isinstance(item, dict):
        for key in keys:
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return ""


def _source_line(item):
    if not isinstance(item, dict):
        return ""
    src = item.get("source")
    if not isinstance(src, dict):
        return ""
    source_type = str(src.get("type") or "").strip()
    title = str(src.get("title") or src.get("work") or "").strip()
    detail = str(src.get("detail") or src.get("reference") or "").strip()
    bits = [v for v in (source_type, title, detail) if v]
    if not bits:
        return ""
    return " | ".join(bits)


def _render_tag_line(item):
    if not isinstance(item, dict):
        return ""
    category = str(item.get("category") or "").strip()
    topics = item.get("topics")
    topic_line = ""
    if isinstance(topics, list):
        clean = [str(v).strip() for v in topics if str(v).strip()]
        if clean:
            topic_line = ", ".join(clean[:6])
    elif isinstance(item.get("topic"), str) and item.get("topic").strip():
        topic_line = item.get("topic").strip()

    parts = []
    if category:
        parts.append(f"type={category}")
    if topic_line:
        parts.append(f"topics={topic_line}")
    return " | ".join(parts)


def _resolve_fact_thread(fact_text):
    topic = _classify_fact_topic(fact_text)
    lore_tid = get_thread_id("lore")
    movie_tid = get_thread_id("movie")
    show_tid = get_thread_id("show")
    chat_tid = get_thread_id("general")

    if topic == "show":
        # User rule: show goes to show thread, fallback to movie.
        return topic, (show_tid or movie_tid or lore_tid or chat_tid or get_thread_id("general"))
    if topic == "movie":
        return topic, (movie_tid)
    if topic == "general":
        return topic, (chat_tid or get_thread_id("general"))
    return topic, (lore_tid or chat_tid or get_thread_id("general"))

async def daily_quote(context: ContextTypes.DEFAULT_TYPE):
    item = random.choice(QUOTES)
    quote = _pick_text(item, ("quote", "text", "q"))
    speaker = str(item.get("speaker") or "").strip() if isinstance(item, dict) else ""
    if speaker:
        body = f"_{quote}_\n\n- {speaker}"
    else:
        body = f"_{quote}_"
    meta = _render_tag_line(item)
    src = _source_line(item)
    extra = ""
    if meta:
        extra += f"\n\n`{meta}`"
    if src:
        extra += f"\nSource: {src}"

    text = f"💬 *Quote of the Day*\n\n{body}{extra}"
    thread_id = get_thread_id("chat") or get_thread_id("lore") or get_thread_id("general")
    message = await context.bot.send_message(
        chat_id=GROUP_ID,
        message_thread_id=thread_id,
        text=text,
        parse_mode="Markdown",
    )
    raw = quote
    if speaker:
        raw = f"{quote}|{speaker}"
    db.log_post_audit(
        topic="quote",
        thread_id=thread_id,
        telegram_message_id=message.message_id,
        content_type="quote",
        content_id=f"quote:{db.compute_text_hash(raw)[:16]}",
        text=text,
    )
    mark_scheduler_execution_outcome(
        context,
        "sent",
        message_id=message.message_id,
        content_type="quote",
        content_id=f"quote:{db.compute_text_hash(raw)[:16]}",
    )


async def daily_fact(context: ContextTypes.DEFAULT_TYPE):
    item = random.choice(FACTS)
    fact = _pick_text(item, ("text", "fact", "q"))
    route_topic, thread_id = _resolve_fact_thread(fact)
    meta = _render_tag_line(item)
    src = _source_line(item)
    extra = ""
    if meta:
        extra += f"\n\n`{meta}`"
    if src:
        extra += f"\nSource: {src}"
    text = f"🛰️ *Random Star Wars Fact*\n\n{fact}{extra}"
    message = await context.bot.send_message(
        chat_id=GROUP_ID,
        message_thread_id=thread_id,
        text=text,
        parse_mode="Markdown",
    )
    db.log_post_audit(
        topic=f"fact:{route_topic}",
        thread_id=thread_id,
        telegram_message_id=message.message_id,
        content_type="fact",
        content_id=f"fact:{db.compute_text_hash(fact)[:16]}",
        text=text,
    )
    mark_scheduler_execution_outcome(
        context,
        "sent",
        message_id=message.message_id,
        content_type="fact",
        content_id=f"fact:{db.compute_text_hash(fact)[:16]}",
    )


async def daily_vote_poll(context: ContextTypes.DEFAULT_TYPE):
    poll = random.choice(POLLS)
    question = _pick_text(poll, ("q", "question", "prompt"))
    options = poll.get("options") if isinstance(poll, dict) else None
    if not isinstance(options, list) or len(options) < 2:
        return
    clean_options = [str(v).strip() for v in options if str(v).strip()]
    if len(clean_options) < 2:
        return

    # Community polls should target General first.
    thread_id = get_thread_id("general") or get_thread_id("chat") or get_thread_id("lore")
    message = await context.bot.send_poll(
        chat_id=GROUP_ID,
        message_thread_id=thread_id,
        question=f"🗳️ {question}",
        options=clean_options,
        is_anonymous=False,
    )
    raw = f"{question}|{'|'.join(clean_options)}"
    db.log_post_audit(
        topic="poll",
        thread_id=thread_id,
        telegram_message_id=message.message_id,
        content_type="poll",
        content_id=f"poll:{db.compute_text_hash(raw)[:16]}",
        text=raw,
    )
    mark_scheduler_execution_outcome(
        context,
        "sent",
        message_id=message.message_id,
        content_type="poll",
        content_id=f"poll:{db.compute_text_hash(raw)[:16]}",
    )


async def daily_discussion_topic(context: ContextTypes.DEFAULT_TYPE):
    if not DISCUSSIONS:
        return

    item = random.choice(DISCUSSIONS)
    prompt = _pick_text(item, ("prompt", "question", "text", "q"))
    if not prompt:
        return

    tags = _render_tag_line(item)
    src = _source_line(item)
    lines = ["🔥 *Controversial Discussion Topic*", "", prompt]
    if tags:
        lines.extend(["", f"`{tags}`"])
    if src:
        lines.append(f"Source: {src}")

    # Community discussions should target General first.
    thread_id = get_thread_id("general") or get_thread_id("chat") or get_thread_id("lore")
    text = "\n".join(lines)
    message = await context.bot.send_message(
        chat_id=GROUP_ID,
        message_thread_id=thread_id,
        text=text,
        parse_mode="Markdown",
    )
    db.log_post_audit(
        topic="discussion",
        thread_id=thread_id,
        telegram_message_id=message.message_id,
        content_type="discussion",
        content_id=f"discussion:{db.compute_text_hash(prompt)[:16]}",
        text=text,
    )
    mark_scheduler_execution_outcome(
        context,
        "sent",
        message_id=message.message_id,
        content_type="discussion",
        content_id=f"discussion:{db.compute_text_hash(prompt)[:16]}",
    )


def _local_now():
    if ZoneInfo is None:
        return datetime.now(timezone.utc)
    try:
        return datetime.now(ZoneInfo(RELEASE_TIMEZONE))
    except Exception:
        return datetime.now(timezone.utc)


def _greeting_for_today(local_dt):
    date_iso = local_dt.date().isoformat()
    weekday = local_dt.weekday()

    if local_dt.month == 5 and local_dt.day == 4:
        return "may4", random.choice(MAY_THE_FOURTH_GREETINGS)
    holiday = db.get_public_holiday("hk", date_iso)
    if holiday:
        holiday_name = str(holiday.get("holiday_name") or "").strip()
        if holiday_name:
            return "hk_holiday", f"Happy {holiday_name} in Hong Kong. May the Force be with you. 🎊"
        return "hk_holiday", random.choice(HK_HOLIDAY_GREETINGS)

    # Fallback for environments that have not synced holidays to DB yet.
    if date_iso in HK_PUBLIC_HOLIDAYS:
        return "hk_holiday", random.choice(HK_HOLIDAY_GREETINGS)
    if weekday == 4:
        return "friday", random.choice(FRIDAY_GREETINGS)
    return None, None


async def daily_greeting(context: ContextTypes.DEFAULT_TYPE):
    local_dt = _local_now()
    kind, greeting = _greeting_for_today(local_dt)
    if not kind or not greeting:
        return

    date_iso = local_dt.date().isoformat()
    content_id = f"greeting:{kind}:{date_iso}"
    if db.already_posted("greeting", content_id):
        return

    text = f"🌟 *Community Greeting*\n\n{greeting}"
    thread_id = get_thread_id("chat") or get_thread_id("lore") or get_thread_id("general")
    message = await context.bot.send_message(
        chat_id=GROUP_ID,
        message_thread_id=thread_id,
        text=text,
        parse_mode="Markdown",
    )
    db.log_post_audit(
        topic=f"greeting:{kind}",
        thread_id=thread_id,
        telegram_message_id=message.message_id,
        content_type="greeting",
        content_id=content_id,
        text=text,
    )