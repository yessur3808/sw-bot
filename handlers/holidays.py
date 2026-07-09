from datetime import datetime, timezone

import requests
from telegram import Update
from telegram.ext import CommandHandler, ContextTypes

import config
import db
from telemetry import instrument_command_handler


HK_HOLIDAY_SOURCE_NAME = "1823.gov.hk Hong Kong Public Holidays"
HK_HOLIDAY_SOURCE_URL = "https://www.1823.gov.hk/common/ical/en.json"


def _is_admin(update: Update):
    user = update.effective_user
    return bool(user and db.is_admin_user(user.id))


def _date_token_to_iso(value):
    raw = str(value or "").strip()
    if len(raw) != 8 or not raw.isdigit():
        return ""
    return f"{raw[:4]}-{raw[4:6]}-{raw[6:8]}"


def _extract_dtstart_token(raw_dtstart):
    if isinstance(raw_dtstart, list) and raw_dtstart:
        return raw_dtstart[0]
    return raw_dtstart


def fetch_hk_public_holidays(source_url=HK_HOLIDAY_SOURCE_URL, timeout=15):
    response = requests.get(source_url, timeout=timeout, headers={"User-Agent": "sw-bot-holidays/1.0"})
    response.raise_for_status()
    payload = response.json()

    calendars = payload.get("vcalendar") if isinstance(payload, dict) else None
    if not isinstance(calendars, list) or not calendars:
        return []

    calendar = calendars[0] if isinstance(calendars[0], dict) else {}
    events = calendar.get("vevent") if isinstance(calendar, dict) else None
    if not isinstance(events, list):
        return []

    today_year = datetime.now(timezone.utc).year
    min_year = today_year - 1
    max_year = today_year + 3

    dedupe = {}
    for event in events:
        if not isinstance(event, dict):
            continue
        dtstart_token = _extract_dtstart_token(event.get("dtstart"))
        date_iso = _date_token_to_iso(dtstart_token)
        if not date_iso:
            continue

        try:
            year_value = int(date_iso[:4])
        except Exception:
            continue
        if year_value < min_year or year_value > max_year:
            continue

        holiday_name = str(event.get("summary") or "").strip()
        if not holiday_name:
            continue

        dedupe[date_iso] = {
            "holiday_date": date_iso,
            "holiday_name": holiday_name,
            "source_name": HK_HOLIDAY_SOURCE_NAME,
            "source_url": source_url,
            "source_meta": {
                "uid": str(event.get("uid") or "").strip(),
                "dtstamp": str(event.get("dtstamp") or "").strip(),
            },
        }

    return [dedupe[key] for key in sorted(dedupe.keys())]


def sync_hk_public_holidays(source_url=HK_HOLIDAY_SOURCE_URL):
    rows = fetch_hk_public_holidays(source_url=source_url)
    if not rows:
        return {
            "ok": False,
            "reason": "no-holidays-fetched",
            "source_url": source_url,
            "saved": 0,
            "fetched": 0,
        }

    saved = db.replace_public_holidays("hk", rows)
    return {
        "ok": True,
        "source_url": source_url,
        "saved": int(saved),
        "fetched": len(rows),
        "start_date": rows[0].get("holiday_date"),
        "end_date": rows[-1].get("holiday_date"),
    }


async def sync_holidays_job(context: ContextTypes.DEFAULT_TYPE):
    try:
        sync_hk_public_holidays()
    except Exception:
        return


async def sync_holidays_now_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not _is_admin(update):
        await update.message.reply_text("Admin only command.")
        return

    try:
        summary = sync_hk_public_holidays()
        if not summary.get("ok"):
            await update.message.reply_text(
                f"Holiday sync did not update data: {summary.get('reason') or 'unknown'}"
            )
            return

        await update.message.reply_text(
            "\n".join(
                [
                    "Hong Kong public holiday sync completed:",
                    f"- fetched={summary.get('fetched', 0)}",
                    f"- saved={summary.get('saved', 0)}",
                    f"- range={summary.get('start_date')}..{summary.get('end_date')}",
                ]
            )
        )
    except Exception as exc:
        await update.message.reply_text(f"Holiday sync failed: {type(exc).__name__}: {exc}")


def register(app):
    app.add_handler(CommandHandler("sync_holidays", instrument_command_handler("sync_holidays", sync_holidays_now_cmd)))
