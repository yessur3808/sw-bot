from datetime import datetime, timedelta, time, timezone
import random
from telegram import BotCommand
from telegram.ext import Application, CommandHandler
import config, db
from handlers import xp, trivia, memes, wallpapers, content, events

async def start(update, context):
    await update.message.reply_text("May the Force be with you! 🌌")


async def help_cmd(update, context):
    user = update.effective_user
    is_admin = bool(user and user.id in config.ADMIN_USER_IDS)

    lines = [
        "Star Wars Bot Commands",
        "",
        "User commands:",
        "/start - Start and verify bot is alive",
        "/help - Show command list",
        "/rank - Show your XP and rank",
        "/leaderboard - Show top XP users",
        "/events [hk|global|all] [limit] [days] [page=N] - Upcoming approved events",
        "/events_detail <id> - Rich details for a specific event",
        "/release_calendar [hk|global|all] [limit] [days] [page=N] - Upcoming games/TV/movies",
    ]

    if is_admin:
        lines.extend(
            [
                "",
                "Admin commands:",
                "/review_events - Show pending review queue",
                "/approve <event_id> - Approve queued item",
                "/reject <event_id> - Reject queued item",
                "/ingest_now [all|hk|global] - Trigger one-shot ingestion",
                "/source_status [limit] - Show latest source run health",
            ]
        )

    await update.message.reply_text("\n".join(lines))

async def weekly_leaderboard(context):
    rows = db.top_users(10, weekly=True)
    text = "🏆 *Weekly Champions*\n\n"
    for i, r in enumerate(rows, 1):
        text += f"{i}. {r['username']} — {r['score']} XP\n"
    message = await context.bot.send_message(
        chat_id=config.GROUP_ID,
        message_thread_id=config.THREADS["general"],
        text=text, parse_mode="Markdown",
    )
    db.log_post_audit(
        topic="leaderboard",
        thread_id=config.THREADS["general"],
        telegram_message_id=message.message_id,
        content_type="leaderboard",
        content_id=f"weekly_leaderboard:{datetime.now(timezone.utc).date().isoformat()}",
        text=text,
    )
    db.reset_weekly()


async def run_scheduled_topic(context):
    topic = context.job.data.get("topic")
    producer_map = {
        "meme": memes.daily_meme,
        "wallpaper": wallpapers.daily_wallpaper,
        "trivia": trivia.daily_trivia,
        "quote": content.daily_quote,
        "fact": content.daily_fact,
        "poll": content.daily_vote_poll,
    }
    producer = producer_map.get(topic)
    if producer:
        await producer(context)


def _build_topics_for_day():
    min_posts = min(config.DAILY_MIN_POSTS, config.DAILY_MAX_POSTS)
    max_posts = max(config.DAILY_MIN_POSTS, config.DAILY_MAX_POSTS)
    target_count = random.randint(min_posts, max_posts)

    caps = {
        "meme": config.MAX_PER_TOPIC_PER_DAY,
        "wallpaper": config.MAX_PER_TOPIC_PER_DAY,
        "trivia": config.MAX_PER_TOPIC_PER_DAY,
        "quote": config.MAX_PER_TOPIC_PER_DAY,
        "fact": config.MAX_PER_TOPIC_PER_DAY,
        "poll": config.MAX_PER_TOPIC_PER_DAY,
    }
    topics = []
    while len(topics) < target_count:
        eligible = [k for k, v in caps.items() if v > 0]
        if not eligible:
            break
        picked = random.choice(eligible)
        topics.append(picked)
        caps[picked] -= 1
    random.shuffle(topics)
    return topics


def schedule_day_posts(job_queue, start_dt):
    topics = _build_topics_for_day()
    if not topics:
        return

    used_offsets = set()
    min_gap = max(5, config.MIN_GAP_MINUTES)
    for topic in topics:
        for _ in range(30):
            offset_min = random.randint(20, (24 * 60) - 20)
            if all(abs(offset_min - x) >= min_gap for x in used_offsets):
                used_offsets.add(offset_min)
                break
        else:
            offset_min = (len(used_offsets) + 1) * min_gap
            used_offsets.add(offset_min)

        run_at = start_dt + timedelta(minutes=offset_min)
        delay = max(1.0, (run_at - datetime.now(timezone.utc)).total_seconds())
        job_queue.run_once(run_scheduled_topic, when=delay, data={"topic": topic})


async def plan_today_posts(context):
    schedule_day_posts(context.job_queue, datetime.now(timezone.utc))


async def startup_recovery_post(context):
    if not config.STARTUP_RECOVERY_ENABLED:
        return
    if db.has_recent_post(hours=config.STARTUP_RECOVERY_HOURS):
        return

    producers = [
        content.daily_fact,
        content.daily_quote,
        content.daily_vote_poll,
        trivia.daily_trivia,
        wallpapers.daily_wallpaper,
        memes.daily_meme,
    ]
    random.shuffle(producers)

    for producer in producers:
        try:
            await producer(context)
        except Exception:
            continue
        if db.has_recent_post(hours=0.25):
            return


async def post_init(app: Application):
    commands = [
        BotCommand("start", "Start and verify bot is alive"),
        BotCommand("help", "Show command list"),
        BotCommand("rank", "Show your XP and rank"),
        BotCommand("leaderboard", "Show top XP users"),
        BotCommand("events", "Upcoming approved events"),
        BotCommand("events_detail", "Show details for an event ID"),
        BotCommand("release_calendar", "Upcoming games/TV/movies"),
    ]
    await app.bot.set_my_commands(commands)

def main():
    db.init_db()
    app = Application.builder().token(config.BOT_TOKEN).post_init(post_init).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_cmd))
    xp.register(app)
    events.register(app)

    jq = app.job_queue
    # Build and schedule today's randomized posting plan immediately.
    schedule_day_posts(jq, datetime.now(timezone.utc))
    # Rebuild plan every day near HKT midnight (UTC 16:05).
    jq.run_daily(plan_today_posts, time(hour=16, minute=5))
    jq.run_daily(weekly_leaderboard, time(hour=12, minute=0), days=(6,)) # Sun 20:00
    if config.ENABLE_EVENT_INGESTION:
        jq.run_repeating(events.ingest_events_job, interval=config.EVENT_INGEST_HOURS * 3600, first=5)
        jq.run_repeating(events.publish_auto_approved, interval=1800, first=30)
        jq.run_daily(
            events.daily_event_digest,
            time(
                hour=config.DAILY_EVENT_DIGEST_UTC_HOUR,
                minute=config.DAILY_EVENT_DIGEST_UTC_MINUTE,
            ),
        )
    jq.run_once(startup_recovery_post, when=10)

    print("Bot running...")
    app.run_polling()

if __name__ == "__main__":
    main()