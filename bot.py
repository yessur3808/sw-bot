from datetime import datetime, timedelta, time, timezone
import math
import random
from telegram import BotCommand
from telegram.error import Conflict
from telegram.ext import Application, CommandHandler
import config, db
from admin import runtime_settings
from admin.server import start_admin_ui
from handlers import xp, trivia, memes, wallpapers, content, events, auto_engage, reddit_ingest, dataset_collectors, holidays
from telemetry import instrument_command_handler, mark_scheduler_execution_outcome, scheduler_execution_logged


_conflict_shutdown_requested = False

SCHEDULED_TOPIC_MISFIRE_GRACE_SECONDS = 30 * 60

TOPIC_BASE_WEIGHTS = {
    "meme": 1.0,
    "wallpaper": 0.94,
    "trivia": 0.9,
    "quote": 0.82,
    "fact": 0.9,
    "poll": 0.78,
    "discussion": 0.8,
}

TOPIC_CONTENT_TYPES = {
    "meme": "meme",
    "wallpaper": "wallpaper",
    "trivia": "trivia",
    "quote": "quote",
    "fact": "fact",
    "poll": "poll",
    "discussion": "discussion",
}


def _runtime_int(setting_key, fallback):
    try:
        return int(runtime_settings.get(setting_key))
    except Exception:
        return int(fallback)


def _runtime_bool(setting_key, fallback):
    try:
        return bool(runtime_settings.get(setting_key))
    except Exception:
        return bool(fallback)

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
        "/whats_new_today - Summary of today's posts, upcoming queue, and key events",
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
                "/sync_holidays - Refresh Hong Kong public holidays from official source",
            ]
        )

    await update.message.reply_text("\n".join(lines))

async def weekly_leaderboard(context):
    rows = db.top_users(10, weekly=True)
    text = "🏆 *Weekly Champions*\n\n"
    for i, r in enumerate(rows, 1):
        text += f"{i}. {r['username']} — {r['score']} XP\n"
    thread_id = config.get_chat_thread_id() or config.get_thread_id("general")
    message = await context.bot.send_message(
        chat_id=config.GROUP_ID,
        message_thread_id=thread_id,
        text=text, parse_mode="Markdown",
    )
    db.log_post_audit(
        topic="leaderboard",
        thread_id=thread_id,
        telegram_message_id=message.message_id,
        content_type="leaderboard",
        content_id=f"weekly_leaderboard:{datetime.now(timezone.utc).date().isoformat()}",
        text=text,
    )
    db.reset_weekly()


async def run_scheduled_topic(context):
    topic = context.job.data.get("topic")
    scheduled_run_at = context.job.data.get("scheduled_run_at")
    if scheduled_run_at:
        try:
            scheduled_dt = datetime.fromisoformat(str(scheduled_run_at).replace("Z", "+00:00"))
            if scheduled_dt.tzinfo is None:
                scheduled_dt = scheduled_dt.replace(tzinfo=timezone.utc)
            lateness_seconds = max(0, int((datetime.now(timezone.utc) - scheduled_dt.astimezone(timezone.utc)).total_seconds()))
            if lateness_seconds > 0:
                print(
                    f"Scheduler slot late by {lateness_seconds}s: topic={topic} "
                    f"plan={context.job.data.get('plan_key')} slot={context.job.data.get('slot_index')}"
                )
        except Exception:
            pass
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
    if not producer:
        mark_scheduler_execution_outcome(context, "no_producer", error=f"No producer registered for topic={topic}")
        return

    try:
        await producer(context)
    except Exception as exc:
        mark_scheduler_execution_outcome(context, "failed", error=f"{type(exc).__name__}: {exc}")
        raise

    if not scheduler_execution_logged(context):
        mark_scheduler_execution_outcome(context, "no_content", error=f"Producer returned without posting for topic={topic}")

async def retry_scheduled_topic(context):
    topic = context.job.data.get("topic")
    if not topic:
        return

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
    if not producer:
        return

    retry_state = context.job.data.get("retry_state") or {}
    retry_state["attempts"] = int(retry_state.get("attempts", 0)) + 1
    context.job.data["retry_state"] = retry_state

    try:
        await producer(context)
    except Exception as exc:
        mark_scheduler_execution_outcome(context, "failed", error=f"retry:{type(exc).__name__}: {exc}")
        return

    if not scheduler_execution_logged(context):
        mark_scheduler_execution_outcome(context, "no_content", error=f"Retry producer returned without posting for topic={topic}")


def _build_topics_for_day():
    now_utc = datetime.now(timezone.utc)
    min_posts_setting = max(1, _runtime_int("daily_min_posts", config.DAILY_MIN_POSTS))
    max_posts_setting = max(1, _runtime_int("daily_max_posts", config.DAILY_MAX_POSTS))
    min_posts = min(min_posts_setting, max_posts_setting)
    max_posts = max(min_posts_setting, max_posts_setting)
    target_count = random.randint(min_posts, max_posts)

    boosted = False
    day_multiplier = 1.0
    if config.POST_BOOST_ENABLED:
        boosted, day_multiplier = _day_boost_profile(now_utc)
        if boosted:
            target_count = int(math.ceil(target_count * max(1.0, day_multiplier)))

    per_topic_cap = max(1, _runtime_int("max_per_topic_per_day", config.MAX_PER_TOPIC_PER_DAY))
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

    recent_counts = db.recent_post_counts_by_content_type(
        hours=72,
        content_types=tuple(sorted(set(TOPIC_CONTENT_TYPES.values()))),
    )
    simulated_counts = {
        content_type: int(recent_counts.get(content_type, 0))
        for content_type in set(TOPIC_CONTENT_TYPES.values())
    }
    topics = []
    decision_rows = []
    plan_key = f"daily-plan:{now_utc.date().isoformat()}:{int(now_utc.timestamp())}"

    while len(topics) < target_count:
        eligible = [k for k, v in caps.items() if v > 0]
        if not eligible:
            break
        slot_index = len(topics)
        slot_scores = []
        for topic in eligible:
            content_type = TOPIC_CONTENT_TYPES.get(topic, topic)
            recent_count = int(simulated_counts.get(content_type, 0))
            base_weight = float(TOPIC_BASE_WEIGHTS.get(topic, 0.75))
            diversity_bonus = 0.24 if recent_count == 0 else max(0.0, 0.12 - (recent_count * 0.02))
            saturation_penalty = recent_count * 0.18
            seasonal_bonus = 0.0
            if boosted:
                if topic in ("meme", "wallpaper"):
                    seasonal_bonus += (day_multiplier - 1.0) * 0.16
                elif topic in ("trivia", "discussion", "poll"):
                    seasonal_bonus += (day_multiplier - 1.0) * 0.10
            jitter = random.random() * 0.08
            score = max(0.01, base_weight + diversity_bonus + seasonal_bonus + jitter - saturation_penalty)
            slot_scores.append(
                {
                    "plan_key": plan_key,
                    "slot_index": slot_index,
                    "topic": topic,
                    "score": round(score, 4),
                    "selected": False,
                    "reason": "candidate",
                    "score_factors": {
                        "base_weight": round(base_weight, 4),
                        "recent_count_72h": recent_count,
                        "diversity_bonus": round(diversity_bonus, 4),
                        "seasonal_bonus": round(seasonal_bonus, 4),
                        "saturation_penalty": round(saturation_penalty, 4),
                        "jitter": round(jitter, 4),
                        "boosted": boosted,
                        "day_multiplier": round(day_multiplier, 4),
                    },
                }
            )

        picked_row = max(slot_scores, key=lambda item: (item["score"], item["topic"]))
        picked = picked_row["topic"]
        for row in slot_scores:
            if row["topic"] == picked:
                row["selected"] = True
                row["reason"] = "selected-highest-score"
        decision_rows.extend(slot_scores)
        topics.append(picked)
        caps[picked] -= 1
        picked_content_type = TOPIC_CONTENT_TYPES.get(picked, picked)
        simulated_counts[picked_content_type] = int(simulated_counts.get(picked_content_type, 0)) + 1

    return {
        "plan_key": plan_key,
        "topics": topics,
        "decision_rows": decision_rows,
        "boosted": boosted,
        "day_multiplier": day_multiplier,
    }


def _day_boost_profile(now_utc):
    try:
        from zoneinfo import ZoneInfo

        local_dt = now_utc.astimezone(ZoneInfo(config.RELEASE_TIMEZONE))
    except Exception:
        local_dt = now_utc

    weekday = local_dt.weekday()  # Monday=0
    local_date = local_dt.date().isoformat()
    boosted = False
    multiplier = 1.0

    if weekday in (5, 6):
        boosted = True
    if weekday == 5:
        multiplier = max(multiplier, float(config.SATURDAY_POST_MULTIPLIER))
    if local_dt.month == 5 and local_dt.day == 4:
        boosted = True
        multiplier = max(multiplier, float(config.STAR_WARS_DAY_POST_MULTIPLIER))

    if multiplier > 1.0:
        boosted = True
    return boosted, multiplier


def _minute_of_day(hour_value, minute_value):
    hour = int(hour_value) % 24
    minute = int(minute_value) % 60
    return (hour * 60) + minute


def _is_minute_in_window(minute_of_day, start_minute, end_minute):
    if start_minute == end_minute:
        return True
    if start_minute < end_minute:
        return start_minute <= minute_of_day < end_minute
    return minute_of_day >= start_minute or minute_of_day < end_minute


def _allowed_offsets_for_window(start_dt, window_start_minute, window_end_minute):
    try:
        from zoneinfo import ZoneInfo

        tz = ZoneInfo(config.POSTING_WINDOW_TIMEZONE)
    except Exception:
        tz = timezone.utc

    offsets = []
    for offset in range(2, (24 * 60) - 19):
        run_at_utc = start_dt + timedelta(minutes=offset)
        run_local = run_at_utc.astimezone(tz)
        minute_of_day = (run_local.hour * 60) + run_local.minute
        if _is_minute_in_window(minute_of_day, window_start_minute, window_end_minute):
            offsets.append(offset)
    return offsets


def _pick_offset_with_gap(allowed_offsets, used_offsets, min_gap, attempts=60):
    if not allowed_offsets:
        return None
    for _ in range(max(1, int(attempts))):
        offset = random.choice(allowed_offsets)
        if all(abs(offset - existing) >= min_gap for existing in used_offsets):
            return offset
    for offset in sorted(allowed_offsets):
        if all(abs(offset - existing) >= min_gap for existing in used_offsets):
            return offset
    return None


def _pick_spread_offsets(allowed_offsets, count, min_gap):
    ordered = sorted({int(value) for value in allowed_offsets})
    if not ordered or count <= 0:
        return []

    min_gap = max(1, int(min_gap))
    count = min(int(count), len(ordered))

    if count == 1:
        return [ordered[len(ordered) // 2]]

    selected = []
    used = set()
    span = max(1, ordered[-1] - ordered[0])

    for slot_index in range(count):
        target = ordered[0] + (((slot_index + 0.5) / count) * span)
        candidates = [
            offset for offset in ordered
            if offset not in used and all(abs(offset - existing) >= min_gap for existing in selected)
        ]
        if not candidates:
            break
        chosen = min(candidates, key=lambda offset: (abs(offset - target), offset))
        selected.append(chosen)
        used.add(chosen)

    if len(selected) < count:
        for offset in ordered:
            if offset in used:
                continue
            if all(abs(offset - existing) >= min_gap for existing in selected):
                selected.append(offset)
                used.add(offset)
            if len(selected) >= count:
                break

    return sorted(selected)


def _max_slots_with_gap(allowed_offsets, min_gap):
    ordered = sorted({int(value) for value in allowed_offsets})
    if not ordered:
        return 0
    min_gap = max(1, int(min_gap))
    count = 0
    last_offset = None
    for offset in ordered:
        if last_offset is None or (offset - last_offset) >= min_gap:
            count += 1
            last_offset = offset
    return count


def schedule_day_posts(job_queue, start_dt):
    plan = _build_topics_for_day()
    topics = plan.get("topics") or []
    if not topics:
        return

    min_gap = max(5, _runtime_int("min_gap_minutes", config.MIN_GAP_MINUTES))
    window_start = 2
    window_end = (24 * 60) - 20

    active_start = _minute_of_day(
        _runtime_int("posting_window_start_hour", config.POSTING_WINDOW_START_HOUR),
        _runtime_int("posting_window_start_minute", config.POSTING_WINDOW_START_MINUTE),
    )
    active_end = _minute_of_day(
        _runtime_int("posting_window_end_hour", config.POSTING_WINDOW_END_HOUR),
        _runtime_int("posting_window_end_minute", config.POSTING_WINDOW_END_MINUTE),
    )
    posting_window_enabled = _runtime_bool("posting_window_enabled", config.POSTING_WINDOW_ENABLED)
    if posting_window_enabled:
        allowed_offsets = _allowed_offsets_for_window(start_dt, active_start, active_end)
    else:
        allowed_offsets = list(range(window_start, window_end + 1))

    if not allowed_offsets:
        print(
            "Scheduler posting window produced zero eligible slots in the next 24h. "
            "Falling back to full-day scheduling window."
        )
        allowed_offsets = list(range(window_start, window_end + 1))

    max_slots_by_gap = max(1, _max_slots_with_gap(allowed_offsets, min_gap))
    if len(topics) > max_slots_by_gap:
        print(
            "Scheduler cap applied: configured daily volume exceeds feasible slots for "
            f"MIN_GAP_MINUTES={min_gap}. Scheduling {max_slots_by_gap} of {len(topics)} planned posts."
        )
    topics = topics[:max_slots_by_gap]

    run_times_by_slot = {}
    selected_offsets = _pick_spread_offsets(allowed_offsets, len(topics), min_gap)
    if len(selected_offsets) < len(topics):
        topics = topics[:len(selected_offsets)]

    for slot_index, (topic, offset_min) in enumerate(zip(topics, selected_offsets)):
        run_at = start_dt + timedelta(minutes=offset_min)
        run_times_by_slot[slot_index] = run_at
        delay = max(1.0, (run_at - datetime.now(timezone.utc)).total_seconds())
        job_queue.run_once(
            run_scheduled_topic,
            when=delay,
            data={
                "topic": topic,
                "plan_key": plan.get("plan_key"),
                "slot_index": slot_index,
                "scheduled_run_at": run_at.isoformat(),
            },
            job_kwargs={
                "misfire_grace_time": SCHEDULED_TOPIC_MISFIRE_GRACE_SECONDS,
            },
        )

        retry_delay = max(delay + 1800, delay + 600)
        retry_run_at = run_at + timedelta(minutes=30)
        if retry_run_at.date() == start_dt.date() or posting_window_enabled:
            job_queue.run_once(
                retry_scheduled_topic,
                when=max(1.0, (retry_run_at - datetime.now(timezone.utc)).total_seconds()),
                data={
                    "topic": topic,
                    "plan_key": plan.get("plan_key"),
                    "slot_index": slot_index,
                    "scheduled_run_at": retry_run_at.isoformat(),
                    "retry_state": {"attempts": 0, "source_slot_index": slot_index},
                },
                job_kwargs={
                    "misfire_grace_time": SCHEDULED_TOPIC_MISFIRE_GRACE_SECONDS,
                },
            )

    scheduled_for_date = start_dt.date().isoformat()
    for row in plan.get("decision_rows") or []:
        slot_index = int(row.get("slot_index", 0))
        originally_selected = bool(row.get("selected"))
        selected = originally_selected and slot_index in run_times_by_slot
        run_at = run_times_by_slot.get(slot_index) if selected else None
        reason = row.get("reason") or ("selected" if selected else "candidate")
        if originally_selected and not selected:
            reason = "deferred-gap-cap"
        db.log_scheduler_decision(
            plan_key=row.get("plan_key") or plan.get("plan_key"),
            slot_index=slot_index,
            topic=row.get("topic"),
            score=float(row.get("score") or 0.0),
            selected=selected,
            scheduled_for_date=scheduled_for_date,
            run_at=(run_at.isoformat() if run_at else None),
            score_factors=row.get("score_factors") or {},
            reason=reason,
        )


async def plan_today_posts(context):
    schedule_day_posts(context.job_queue, datetime.now(timezone.utc))


async def whats_new_today_cmd(update, context):
    today_rows = db.posted_today_by_content_type()
    upcoming_rows = db.upcoming_scheduler_decisions(limit=6)
    upcoming_events = []
    today = events._today_in_release_timezone()
    for row in db.list_approved_events(limit=18, region="all", days=14):
        event_date = row.get("event_date") if hasattr(row, "get") else row["event_date"]
        if events._is_incoming_event_date(event_date, today=today, max_days=14):
            upcoming_events.append(row)
        if len(upcoming_events) >= 3:
            break
    releases = db.list_upcoming_releases(limit=3, region="all", days=60)

    lines = ["*What's New Today*", ""]

    if today_rows:
        summary_bits = [f"{row['content_type']} x{row['cnt']}" for row in today_rows]
        lines.append(f"Posted today: {', '.join(summary_bits)}")
    else:
        lines.append("Posted today: nothing has gone out yet.")

    if upcoming_rows:
        lines.append("")
        lines.append("Still queued:")
        for row in upcoming_rows[:4]:
            run_at = row.get("run_at") if hasattr(row, "get") else row[7]
            stamp = str(run_at or "").replace("T", " ")[:16] if run_at else "later"
            lines.append(f"- {row['topic']} at {stamp} UTC")

    if upcoming_events:
        lines.append("")
        lines.append("Upcoming events:")
        for row in upcoming_events:
            lines.append(f"- {row['event_date']} | {row['title']}")

    if releases:
        lines.append("")
        lines.append("Upcoming releases:")
        for row in releases:
            lines.append(f"- {row['event_date']} | [{row['category'].upper()}] {row['title']}")

    await update.message.reply_text("\n".join(lines), parse_mode="Markdown", disable_web_page_preview=True)


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


async def first_run_introduction(context):
    # Send one intro message only when the bot has never posted before.
    if db.has_any_post_audit():
        return

    thread_id = config.get_chat_thread_id() or config.get_thread_id("general")
    text = (
        "Hi, I am SIU-M8, your Star Wars assistant bot.\n\n"
        "I post lore, trivia, memes, wallpapers, and verified event updates. "
        "May the Force be with you all."
    )
    message = await context.bot.send_message(
        chat_id=config.GROUP_ID,
        message_thread_id=thread_id,
        text=text,
    )
    db.log_post_audit(
        topic="intro",
        thread_id=thread_id,
        telegram_message_id=message.message_id,
        content_type="intro",
        content_id="intro:siu-m8:v1",
        text=text,
    )


async def post_init(app: Application):
    commands = [
        BotCommand("start", "Start and verify bot is alive"),
        BotCommand("help", "Show command list"),
        BotCommand("whereami", "Show current chat/thread IDs"),
        BotCommand("whats_new_today", "Summary of today's posts and queued updates"),
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


async def telegram_error_handler(update, context):
    global _conflict_shutdown_requested
    err = context.error
    if isinstance(err, Conflict):
        print(
            "TELEGRAM CONFLICT: another process is calling getUpdates with this BOT_TOKEN. "
            "Ensure exactly one running bot instance across Railway/local machines."
        )
        if config.EXIT_ON_TELEGRAM_CONFLICT and not _conflict_shutdown_requested:
            _conflict_shutdown_requested = True
            print("TELEGRAM CONFLICT: exiting this instance to avoid repeated polling conflicts.")
            app = getattr(context, "application", None)
            if app and hasattr(app, "stop_running"):
                app.stop_running()
        return
    print(f"Unhandled Telegram error: {err}")


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
    seeded_datasets = db.seed_dataset_items_from_files()
    if seeded_datasets:
        print(f"Seeded dataset_store from JSON files: {', '.join(seeded_datasets)}")
    db.ensure_admin_profiles(config.ADMIN_USER_IDS)
    previous_heartbeat = db.get_bot_health_state("bot_heartbeat_at")
    check_bot_downtime_alert(previous_heartbeat)
    record_bot_heartbeat()
    start_admin_ui()
    app = Application.builder().token(config.BOT_TOKEN).post_init(post_init).build()

    app.add_handler(CommandHandler("start", instrument_command_handler("start", start)))
    app.add_handler(CommandHandler("help", instrument_command_handler("help", help_cmd)))
    app.add_handler(CommandHandler("whereami", instrument_command_handler("whereami", whereami_cmd)))
    app.add_handler(CommandHandler("whats_new_today", instrument_command_handler("whats_new_today", whats_new_today_cmd)))
    app.add_handler(CommandHandler("thread_map", instrument_command_handler("thread_map", thread_map_cmd)))
    app.add_error_handler(telegram_error_handler)
    xp.register(app)
    auto_engage.register(app)
    events.register(app)
    reddit_ingest.register(app)
    dataset_collectors.register(app)
    holidays.register(app)

    try:
        holidays.sync_hk_public_holidays()
    except Exception as exc:
        print(f"WARNING: public holiday startup sync failed: {type(exc).__name__}: {exc}")

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
    jq.run_repeating(holidays.sync_holidays_job, interval=24 * 3600, first=90)
    jq.run_once(first_run_introduction, when=8)
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