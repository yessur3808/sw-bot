from datetime import datetime, timedelta, time, timezone
import math
import random
from telegram import BotCommand
from telegram.ext import Application, CommandHandler
import config, db
from admin import runtime_settings
from admin.server import start_admin_ui
from handlers import xp, trivia, memes, wallpapers, content, events, auto_engage, reddit_ingest, dataset_collectors

async def start(update, context):
    await update.message.reply_text("May the Force be with you! 🌌")


async def help_cmd(update, context):
    user = update.effective_user
    is_admin = bool(user and db.is_admin_user(user.id))

    lines = [
        "Star Wars Bot Commands",
        "",
        "User commands:",
        "/start - Start and verify bot is alive",
        "/help - Show command list",
        "/rank - Show your XP and rank",
        "/leaderboard - Show top XP users",
        "/whereami - Show current chat/thread IDs",
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
                "/thread_map - Show configured topic routing and duplicate IDs",
                "/reddit_ingest_now - Trigger one-shot Reddit cache ingest",
                "/reddit_digest [limit] - Preview unrelayed Reddit cache items",
                "/dataset_ingest_now - Trigger one-shot original-source dataset collection",
                "/dataset_candidates [dataset] [limit] - Preview collected dataset candidates",
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
        "discussion": content.daily_discussion_topic,
    }
    producer = producer_map.get(topic)
    if producer:
        await producer(context)


def _build_topics_for_day():
    min_posts = min(config.DAILY_MIN_POSTS, config.DAILY_MAX_POSTS)
    max_posts = max(config.DAILY_MIN_POSTS, config.DAILY_MAX_POSTS)
    target_count = random.randint(min_posts, max_posts)

    boosted = False
    boost_extra = 0
    if config.POST_BOOST_ENABLED:
        boosted, boost_extra = _day_boost_profile(datetime.now(timezone.utc))
        if boosted:
            target_count = int(math.ceil(target_count * max(1.0, config.POST_BOOST_MULTIPLIER)))
        target_count += boost_extra

    per_topic_cap = config.MAX_PER_TOPIC_PER_DAY
    if boosted:
        per_topic_cap = int(math.ceil(per_topic_cap * max(1.0, config.POST_BOOST_TOPIC_CAP_MULTIPLIER)))
    per_topic_cap = max(1, per_topic_cap)

    caps = {
        "meme": per_topic_cap,
        "wallpaper": per_topic_cap,
        "trivia": per_topic_cap,
        "quote": per_topic_cap,
        "fact": per_topic_cap,
        "poll": per_topic_cap,
        "discussion": per_topic_cap,
    }
    target_count = max(1, min(target_count, sum(caps.values())))
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


def _day_boost_profile(now_utc):
    try:
        from zoneinfo import ZoneInfo

        local_dt = now_utc.astimezone(ZoneInfo(config.RELEASE_TIMEZONE))
    except Exception:
        local_dt = now_utc

    weekday = local_dt.weekday()  # Monday=0
    local_date = local_dt.date().isoformat()
    boosted = False

    extra = 0
    if weekday == 4 and local_dt.hour >= 18:
        boosted = True
        extra += max(0, config.BOOST_FRIDAY_EVENING_EXTRA)
    if weekday in (5, 6):
        boosted = True
        extra += max(0, config.BOOST_WEEKEND_EXTRA)
    if local_date in config.HK_PUBLIC_HOLIDAYS:
        boosted = True
        extra += max(0, config.BOOST_HOLIDAY_EXTRA)
    if local_dt.month == 5 and local_dt.day == 4:
        boosted = True
        extra += max(0, config.BOOST_STAR_WARS_DAY_EXTRA)

    return boosted, extra


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
        content.daily_discussion_topic,
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
        BotCommand("whereami", "Show current chat/thread IDs"),
        BotCommand("rank", "Show your XP and rank"),
        BotCommand("leaderboard", "Show top XP users"),
        BotCommand("events", "Upcoming approved events"),
        BotCommand("events_detail", "Show details for an event ID"),
        BotCommand("release_calendar", "Upcoming games/TV/movies"),
    ]
    await app.bot.set_my_commands(commands)


def _thread_collision_map():
    by_id = {}
    for name, thread_id in config.THREADS.items():
        if int(thread_id) <= 0:
            continue
        by_id.setdefault(thread_id, []).append(name)
    return {tid: names for tid, names in by_id.items() if len(names) > 1}


def _thread_map_lines():
    lines = ["Thread routing map:"]
    for name in sorted(config.THREADS.keys()):
        lines.append(f"- {name}: {config.THREADS[name]}")

    collisions = _thread_collision_map()
    if collisions:
        lines.append("")
        lines.append("Warnings: duplicate thread IDs detected")
        for thread_id, names in sorted(collisions.items(), key=lambda item: item[0]):
            lines.append(f"- thread {thread_id} is shared by: {', '.join(names)}")
    else:
        lines.append("")
        lines.append("No duplicate thread IDs detected.")

    lines.append("")
    lines.append("Tip: run /whereami inside each Telegram topic and update .env thread values.")

    usage_rows = db.topic_thread_usage(limit=50)
    if usage_rows:
        lines.append("")
        lines.append("Observed routing from post audit:")
        for row in usage_rows:
            topic = row.get("topic") if hasattr(row, "get") else row[0]
            thread_id = row.get("thread_id") if hasattr(row, "get") else row[1]
            post_count = row.get("post_count") if hasattr(row, "get") else row[2]
            latest = row.get("latest_posted_at") if hasattr(row, "get") else row[3]
            lines.append(f"- topic={topic} -> thread={thread_id} posts={post_count} latest={latest}")
    return lines


async def whereami_cmd(update, context):
    chat = update.effective_chat
    message = update.effective_message
    thread_id = message.message_thread_id if message else None
    lines = [
        "Current location:",
        f"- chat_id: {chat.id if chat else 'unknown'}",
        f"- message_thread_id: {thread_id if thread_id is not None else 'none'}",
    ]
    await update.message.reply_text("\n".join(lines))


async def thread_map_cmd(update, context):
    user = update.effective_user
    if not (user and db.is_admin_user(user.id)):
        await update.message.reply_text("Admin only command.")
        return
    await update.message.reply_text("\n".join(_thread_map_lines()))


def record_bot_heartbeat():
    db.set_bot_health_state("bot_heartbeat_at", datetime.now(timezone.utc).isoformat())


def _parse_utc(value):
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _send_emergency_email(recipients, subject, body):
    if not (config.SMTP_HOST and config.SMTP_FROM_EMAIL and recipients):
        return False
    from email.message import EmailMessage
    import smtplib

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = f"{config.SMTP_FROM_NAME} <{config.SMTP_FROM_EMAIL}>" if config.SMTP_FROM_NAME else config.SMTP_FROM_EMAIL
    message["To"] = ", ".join(recipients)
    message.set_content(body)

    with smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=15) as client:
        if config.SMTP_USE_TLS:
            client.starttls()
        if config.SMTP_USERNAME:
            client.login(config.SMTP_USERNAME, config.SMTP_PASSWORD)
        client.send_message(message)
    return True


def check_bot_downtime_alert(heartbeat_value=None):
    heartbeat = _parse_utc(heartbeat_value if heartbeat_value is not None else db.get_bot_health_state("bot_heartbeat_at"))
    now = datetime.now(timezone.utc)
    threshold = timedelta(hours=max(1, config.ADMIN_EMERGENCY_ALERT_HOURS))
    last_alert = _parse_utc(db.get_bot_health_state("bot_downtime_alert_at"))
    if heartbeat and (now - heartbeat) < threshold:
        return
    if last_alert and heartbeat and last_alert >= heartbeat:
        return

    recipients = db.list_active_admin_emails()
    if not recipients:
        return
    subject = "Star Wars Bot downtime alert"
    body = (
        f"The bot heartbeat has been stale for at least {config.ADMIN_EMERGENCY_ALERT_HOURS} hours.\n\n"
        f"Last heartbeat: {heartbeat.isoformat() if heartbeat else 'unknown'}\n"
        f"Check the bot and admin console immediately."
    )
    if _send_emergency_email(recipients, subject, body):
        db.set_bot_health_state("bot_downtime_alert_at", now.isoformat())

def main():
    db.init_db()
    db.ensure_admin_profiles(config.ADMIN_USER_IDS)
    previous_heartbeat = db.get_bot_health_state("bot_heartbeat_at")
    check_bot_downtime_alert(previous_heartbeat)
    record_bot_heartbeat()
    start_admin_ui()
    app = Application.builder().token(config.BOT_TOKEN).post_init(post_init).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("help", help_cmd))
    app.add_handler(CommandHandler("whereami", whereami_cmd))
    app.add_handler(CommandHandler("thread_map", thread_map_cmd))
    xp.register(app)
    auto_engage.register(app)
    events.register(app)
    reddit_ingest.register(app)
    dataset_collectors.register(app)

    collisions = _thread_collision_map()
    if collisions:
        print("WARNING: duplicate Telegram thread IDs detected in THREAD_* config")
        for thread_id, names in sorted(collisions.items(), key=lambda item: item[0]):
            print(f"- thread {thread_id} is shared by: {', '.join(names)}")

    jq = app.job_queue
    # Build and schedule today's randomized posting plan immediately.
    schedule_day_posts(jq, datetime.now(timezone.utc))
    # Rebuild plan every day near HKT midnight (UTC 16:05).
    jq.run_daily(plan_today_posts, time(hour=16, minute=5))
    if config.GREETING_ENABLED:
        jq.run_daily(
            content.daily_greeting,
            time(
                hour=config.GREETING_UTC_HOUR,
                minute=config.GREETING_UTC_MINUTE,
            ),
        )
    jq.run_daily(weekly_leaderboard, time(hour=12, minute=0), days=(6,)) # Sun 20:00
    if runtime_settings.get("enable_event_ingestion"):
        jq.run_repeating(events.ingest_events_job, interval=runtime_settings.get("event_ingest_hours") * 3600, first=5)
        jq.run_repeating(events.publish_auto_approved, interval=1800, first=30)
        jq.run_daily(
            events.daily_event_digest,
            time(
                hour=config.DAILY_EVENT_DIGEST_UTC_HOUR,
                minute=config.DAILY_EVENT_DIGEST_UTC_MINUTE,
            ),
        )
    if runtime_settings.get("enable_reddit_ingest"):
        jq.run_repeating(
            reddit_ingest.ingest_job,
            interval=max(5, config.REDDIT_INGEST_INTERVAL_MINUTES) * 60,
            first=20,
        )
    if runtime_settings.get("enable_reddit_relay"):
        jq.run_repeating(
            reddit_ingest.relay_job,
            interval=max(5, config.REDDIT_RELAY_INTERVAL_MINUTES) * 60,
            first=45,
        )
    if runtime_settings.get("enable_dataset_collectors"):
        jq.run_repeating(
            dataset_collectors.dataset_ingest_job,
            interval=max(10, runtime_settings.get("dataset_collector_interval_minutes")) * 60,
            first=25,
        )
    jq.run_once(startup_recovery_post, when=10)
    async def heartbeat_job(context):
        record_bot_heartbeat()

    async def downtime_alert_job(context):
        check_bot_downtime_alert()

    jq.run_repeating(heartbeat_job, interval=3600, first=60)
    jq.run_repeating(downtime_alert_job, interval=3600, first=120)

    print("Bot running...")
    app.run_polling()

if __name__ == "__main__":
    main()