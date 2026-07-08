import json
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, abort, jsonify, redirect, render_template, request, send_file, session, url_for

import config
import db
from admin import runtime_settings
from handlers import events as events_handler
from handlers import reddit_ingest as reddit_ingest_handler
from handlers import dataset_collectors as dataset_collectors_handler


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DATASET_FILES = {
    "facts": DATA_DIR / "facts.json",
    "quotes": DATA_DIR / "quotes.json",
    "polls": DATA_DIR / "polls.json",
    "trivia": DATA_DIR / "trivia.json",
    "discussions": DATA_DIR / "discussions.json",
}

_LOGIN_ATTEMPTS = {}
_BOOT_TS = time.time()


def _schema_status_payload():
    suffix = "postgres" if config.DB_BACKEND in ("postgres", "postgresql") else "sqlite"
    migration_files = sorted(ROOT.joinpath("migrations").glob(f"*.{suffix}.up.sql"))
    available_versions = [path.name.split(".")[0] for path in migration_files]
    applied_rows = db.schema_migration_versions()
    applied_versions = [str(row.get("version") or "") for row in applied_rows if row.get("version")]
    applied_set = set(applied_versions)
    pending_versions = [version for version in available_versions if version not in applied_set]
    if suffix == "postgres":
        command = "DB_BACKEND=postgres DATABASE_URL='<database-url>' ./venv/bin/python scripts/db/migrate_schema.py up"
    else:
        command = "DB_BACKEND=sqlite ./venv/bin/python scripts/db/migrate_schema.py up"
    return {
        "backend": suffix,
        "available_versions": available_versions,
        "applied_versions": applied_versions,
        "pending_versions": pending_versions,
        "current_version": applied_versions[-1] if applied_versions else None,
        "latest_available_version": available_versions[-1] if available_versions else None,
        "is_up_to_date": len(pending_versions) == 0,
        "migration_command": command,
    }


def _system_metrics_snapshot():
    cpu_count = max(1, (os.cpu_count() or 1))
    try:
        load1, load5, load15 = os.getloadavg()
    except Exception:
        load1, load5, load15 = (0.0, 0.0, 0.0)

    load_percent = min(100.0, max(0.0, (load1 / cpu_count) * 100.0))

    total_mem_mb = None
    available_mem_mb = None
    used_mem_mb = None
    mem_percent = None
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as handle:
            mem_lines = handle.read().splitlines()
        values = {}
        for line in mem_lines:
            if ":" not in line:
                continue
            key, rest = line.split(":", 1)
            parts = rest.strip().split()
            if not parts:
                continue
            try:
                values[key.strip()] = int(parts[0])
            except Exception:
                continue

        total_kb = values.get("MemTotal")
        avail_kb = values.get("MemAvailable")
        if total_kb:
            total_mem_mb = round(total_kb / 1024.0, 2)
            if avail_kb is not None:
                available_mem_mb = round(avail_kb / 1024.0, 2)
                used_mem_mb = round(total_mem_mb - available_mem_mb, 2)
                mem_percent = round(max(0.0, min(100.0, (used_mem_mb / total_mem_mb) * 100.0)), 2)
    except Exception:
        pass

    process_rss_mb = None
    try:
        with open("/proc/self/status", "r", encoding="utf-8") as handle:
            status_lines = handle.read().splitlines()
        for line in status_lines:
            if line.startswith("VmRSS:"):
                parts = line.split()
                if len(parts) >= 2:
                    process_rss_mb = round(int(parts[1]) / 1024.0, 2)
                break
    except Exception:
        pass

    uptime_seconds = max(0, int(time.time() - _BOOT_TS))
    return {
        "timestamp": int(time.time()),
        "cpu_count": cpu_count,
        "load_avg": [round(load1, 3), round(load5, 3), round(load15, 3)],
        "cpu_percent_est": round(load_percent, 2),
        "memory_total_mb": total_mem_mb,
        "memory_available_mb": available_mem_mb,
        "memory_used_mb": used_mem_mb,
        "memory_percent": mem_percent,
        "process_rss_mb": process_rss_mb,
        "uptime_seconds": uptime_seconds,
    }


def _coerce_datetime(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        raw = str(value).strip().replace(" ", "T")
        if not raw:
            return None
        try:
            dt = datetime.fromisoformat(raw)
        except Exception:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _seconds_since(value):
    dt = _coerce_datetime(value)
    if not dt:
        return None
    return max(0, int((datetime.now(timezone.utc) - dt).total_seconds()))


def _expected_interval_seconds(name):
    mapping = {
        "posts": int(max(1, config.MIN_GAP_MINUTES) * 60),
        "events": int(max(1, config.EVENT_INGEST_HOURS) * 3600),
        "reddit_ingest": int(max(1, config.REDDIT_INGEST_INTERVAL_MINUTES) * 60),
        "reddit_relay": int(max(1, config.REDDIT_RELAY_INTERVAL_MINUTES) * 60),
        "dataset": int(max(1, config.DATASET_COLLECTOR_INTERVAL_MINUTES) * 60),
        "heartbeat": int(max(1, config.ADMIN_EMERGENCY_ALERT_HOURS) * 3600),
    }
    return mapping.get(name)


def _operational_summary(hours, run_type):
    heartbeat_at = db.get_bot_health_state("bot_heartbeat_at")
    latest_post_row = db.topic_thread_usage(limit=1)
    latest_post_at = latest_post_row[0].get("latest_posted_at") if latest_post_row else None
    latest_event_success = db.latest_successful_ingestion_at(run_type=run_type)
    latest_reddit_activity = db.latest_reddit_cache_activity_at()
    latest_dataset_activity = db.latest_dataset_candidate_activity_at(status="candidate")

    pending_events = db.count_events_by_status("pending_review")
    reddit_total = db.reddit_cache_count(relayed=False, blocked=False)
    reddit_blocked = db.reddit_cache_count(blocked=True)
    dataset_candidates = db.dataset_candidates_count(status="candidate")
    top_commands = db.top_commands(hours=hours, limit=5)
    upcoming_schedule = db.upcoming_scheduler_decisions(limit=6)

    return {
        "hours": int(hours),
        "run_type": run_type,
        "posts": {
            "last_at": latest_post_at,
            "seconds_since_last": _seconds_since(latest_post_at),
            "expected_interval_seconds": _expected_interval_seconds("posts"),
        },
        "heartbeat": {
            "last_at": heartbeat_at,
            "seconds_since_last": _seconds_since(heartbeat_at),
            "expected_interval_seconds": _expected_interval_seconds("heartbeat"),
        },
        "events": {
            "last_success_at": latest_event_success,
            "seconds_since_success": _seconds_since(latest_event_success),
            "expected_interval_seconds": _expected_interval_seconds("events"),
            "pending_review": pending_events,
        },
        "reddit": {
            "last_activity_at": latest_reddit_activity,
            "seconds_since_activity": _seconds_since(latest_reddit_activity),
            "expected_ingest_seconds": _expected_interval_seconds("reddit_ingest"),
            "expected_relay_seconds": _expected_interval_seconds("reddit_relay"),
            "queue_open": reddit_total,
            "blocked": reddit_blocked,
        },
        "datasets": {
            "last_candidate_at": latest_dataset_activity,
            "seconds_since_candidate": _seconds_since(latest_dataset_activity),
            "expected_interval_seconds": _expected_interval_seconds("dataset"),
            "candidate_queue": dataset_candidates,
        },
        "scheduler": {
            "upcoming_count": len(upcoming_schedule),
            "upcoming": [dict(row) for row in upcoming_schedule],
            "outcomes": db.scheduler_outcome_counts(hours=hours),
        },
        "commands": {
            "top": top_commands,
            "total_24h": sum(int(row.get("cnt") or 0) for row in top_commands),
            "error_rates": db.command_error_rates(hours=hours, limit=8),
        },
    }


def _build_operational_alerts(summary):
    alerts = []

    def add_alert(level, key, title, detail):
        alerts.append({
            "level": level,
            "key": key,
            "title": title,
            "detail": detail,
        })

    heartbeat = summary.get("heartbeat") or {}
    heartbeat_age = heartbeat.get("seconds_since_last")
    heartbeat_expected = heartbeat.get("expected_interval_seconds") or 0
    if heartbeat_age is None:
        add_alert("warn", "heartbeat-missing", "Heartbeat missing", "No bot heartbeat has been recorded yet.")
    elif heartbeat_age > heartbeat_expected:
        add_alert("critical", "heartbeat-stale", "Heartbeat stale", f"Last heartbeat is older than the {int(heartbeat_expected / 3600)}h downtime threshold.")

    posts = summary.get("posts") or {}
    post_age = posts.get("seconds_since_last")
    post_expected = int((posts.get("expected_interval_seconds") or 0) * 2)
    if post_age is None:
        add_alert("warn", "posts-missing", "No posts recorded", "The post audit table has no recent post entries.")
    elif post_expected and post_age > post_expected:
        add_alert("warn", "posts-stale", "Posting cadence stale", "No recent post landed within twice the configured minimum gap window.")

    events = summary.get("events") or {}
    event_age = events.get("seconds_since_success")
    event_expected = int((events.get("expected_interval_seconds") or 0) * 2)
    if event_age is None:
        add_alert("warn", "events-never-succeeded", "No successful event ingest", "No successful event ingestion run is recorded for the current scope.")
    elif event_expected and event_age > event_expected:
        add_alert("warn", "events-stale", "Event ingestion stale", "Successful event ingestion is older than twice the configured interval.")
    if int(events.get("pending_review") or 0) >= 10:
        add_alert("warn", "events-backlog", "Event review backlog", f"There are {int(events.get('pending_review') or 0)} events waiting for review.")

    reddit = summary.get("reddit") or {}
    reddit_age = reddit.get("seconds_since_activity")
    reddit_expected = int((reddit.get("expected_ingest_seconds") or 0) * 2)
    if reddit_age is None:
        add_alert("warn", "reddit-idle", "Reddit cache idle", "No Reddit cache activity has been recorded yet.")
    elif reddit_expected and reddit_age > reddit_expected:
        add_alert("warn", "reddit-stale", "Reddit ingest stale", "Reddit cache activity is older than twice the configured ingest interval.")
    if int(reddit.get("queue_open") or 0) >= 20:
        add_alert("info", "reddit-queue", "Reddit relay queue growing", f"There are {int(reddit.get('queue_open') or 0)} unrelayed Reddit items queued.")
    if int(reddit.get("blocked") or 0) >= 5:
        add_alert("warn", "reddit-blocked", "Blocked Reddit items accumulating", f"There are {int(reddit.get('blocked') or 0)} blocked Reddit items requiring review.")

    datasets = summary.get("datasets") or {}
    if int(datasets.get("candidate_queue") or 0) >= 20:
        add_alert("info", "dataset-backlog", "Dataset candidate backlog", f"There are {int(datasets.get('candidate_queue') or 0)} dataset candidates pending action.")

    if not alerts:
        add_alert("ok", "all-clear", "All clear", "No operational alert thresholds are currently breached.")
    return alerts


def _scheduler_trend_points(rows):
    points = {}
    for row in rows or []:
        status = str(row.get("execution_status") or "pending")
        points[status] = points.get(status, 0) + 1
    return [{"status": key, "cnt": value} for key, value in sorted(points.items(), key=lambda item: item[0])]


def _attach_post_audit(rows):
    out = []
    for row in rows or []:
        payload = dict(row)
        payload["post_audit"] = db.latest_post_audit_for_delivery(
            telegram_message_id=payload.get("executed_message_id"),
            content_type=payload.get("executed_content_type"),
            content_id=payload.get("executed_content_id"),
        )
        out.append(payload)
    return out


def _session_expired(row):
    expires_at = row.get("expires_at") if hasattr(row, "get") else row[5]
    dt = _coerce_datetime(expires_at)
    if not dt:
        return True
    return dt <= datetime.now(timezone.utc)


def _client_ip():
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or "unknown"


def _host_allowed():
    if not config.ADMIN_UI_ALLOWED_HOSTS:
        return True
    host = (request.headers.get("Host") or "").split(":", 1)[0].strip().lower()
    if not host:
        return False
    if "*" in config.ADMIN_UI_ALLOWED_HOSTS:
        return True
    if host in config.ADMIN_UI_ALLOWED_HOSTS:
        return True
    for pattern in config.ADMIN_UI_ALLOWED_HOSTS:
        candidate = pattern.strip().lower()
        if candidate.startswith("*.") and host.endswith(candidate[1:]):
            return True
    return False


def _ip_allowed():
    if not config.ADMIN_UI_IP_ALLOWLIST:
        return True
    return _client_ip() in config.ADMIN_UI_IP_ALLOWLIST


def _login_attempt_key(user_id_raw):
    return f"{_client_ip()}::{str(user_id_raw or '').strip()}"


def _locked_until(attempt):
    value = (attempt or {}).get("locked_until")
    if not value:
        return None
    return _coerce_datetime(value)


def _attempt_blocked(user_id_raw):
    now = datetime.now(timezone.utc)
    keys = (_login_attempt_key(user_id_raw), _client_ip())
    for key in keys:
        item = _LOGIN_ATTEMPTS.get(key) or {}
        locked = _locked_until(item)
        if locked and locked > now:
            return True, int((locked - now).total_seconds())
    return False, 0


def _record_login_failure(user_id_raw):
    now = datetime.now(timezone.utc)
    window = timedelta(minutes=max(1, config.ADMIN_UI_LOGIN_WINDOW_MINUTES))
    lockout = timedelta(minutes=max(1, config.ADMIN_UI_LOGIN_LOCKOUT_MINUTES))
    for key in (_login_attempt_key(user_id_raw), _client_ip()):
        item = _LOGIN_ATTEMPTS.get(key)
        if not item:
            item = {"count": 0, "first_seen": now.isoformat(), "locked_until": None}
        first_seen = _coerce_datetime(item.get("first_seen")) or now
        if (now - first_seen) > window:
            item = {"count": 0, "first_seen": now.isoformat(), "locked_until": None}
        item["count"] = int(item.get("count", 0)) + 1
        if item["count"] >= max(1, config.ADMIN_UI_MAX_LOGIN_ATTEMPTS):
            item["locked_until"] = (now + lockout).isoformat()
        _LOGIN_ATTEMPTS[key] = item


def _clear_login_failure_state(user_id_raw):
    _LOGIN_ATTEMPTS.pop(_login_attempt_key(user_id_raw), None)
    _LOGIN_ATTEMPTS.pop(_client_ip(), None)


def _valid_source_row(source):
    if not isinstance(source, dict):
        return False, "source must be object"
    tier = str(source.get("tier") or "").strip().lower()
    kind = str(source.get("kind") or "").strip().lower()
    name = str(source.get("name") or "").strip()
    url = str(source.get("url") or "").strip()
    if tier not in ("official", "rss", "api", "scrape"):
        return False, "invalid tier"
    if kind not in ("event", "news"):
        return False, "invalid kind"
    if not name:
        return False, "missing name"
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return False, "invalid url"
    if source.get("meta") is not None and not isinstance(source.get("meta"), dict):
        return False, "meta must be object"
    return True, None


def _require_csrf():
    expected = session.get("csrf_token")
    supplied = request.headers.get("X-CSRF-Token", "")
    if not expected or not secrets.compare_digest(expected, supplied):
        abort(403, description="invalid-csrf")


def _load_dataset(dataset_name):
    path = DATASET_FILES.get(dataset_name)
    if not path:
        abort(404, description="unknown-dataset")
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _save_dataset(dataset_name, payload):
    path = DATASET_FILES.get(dataset_name)
    if not path:
        abort(404, description="unknown-dataset")
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def _validate_dataset(dataset_name, payload):
    def _non_empty_str(value):
        return isinstance(value, str) and bool(value.strip())

    def _optional_str(value):
        return value is None or isinstance(value, str)

    def _valid_topics(value):
        if value is None:
            return True
        if isinstance(value, str):
            return bool(value.strip())
        if not isinstance(value, list):
            return False
        return all(_non_empty_str(v) for v in value)

    def _valid_source(value):
        if value is None:
            return True
        if not isinstance(value, dict):
            return False
        for key in ("type", "title", "work", "detail", "reference", "url"):
            if key in value and not _optional_str(value.get(key)):
                return False
        return True

    def _text_from_item(item, keys):
        if isinstance(item, str):
            return item
        if isinstance(item, dict):
            for key in keys:
                value = item.get(key)
                if _non_empty_str(value):
                    return value
        return None

    def _valid_options(value):
        return isinstance(value, list) and len(value) >= 2 and all(_non_empty_str(v) for v in value)

    if not isinstance(payload, list):
        return False, "payload must be a list"

    if dataset_name in ("facts", "quotes"):
        for idx, item in enumerate(payload):
            text = _text_from_item(item, ("text", "fact", "quote", "q"))
            if not _non_empty_str(text):
                return False, f"index {idx}: expected non-empty text"
            if isinstance(item, dict):
                if not _optional_str(item.get("category")):
                    return False, f"index {idx}: category must be string"
                if not _valid_topics(item.get("topics", item.get("topic"))):
                    return False, f"index {idx}: topics must be string or list of strings"
                if not _valid_source(item.get("source")):
                    return False, f"index {idx}: source must be object"
        return True, None

    if dataset_name == "polls":
        for idx, item in enumerate(payload):
            if not isinstance(item, dict):
                return False, f"index {idx}: expected object"
            q = str(item.get("q") or item.get("question") or item.get("prompt") or "").strip()
            options = item.get("options")
            if not q:
                return False, f"index {idx}: missing q"
            if not _valid_options(options):
                return False, f"index {idx}: options must be list with >= 2"
            if not _optional_str(item.get("category")):
                return False, f"index {idx}: category must be string"
            if not _valid_topics(item.get("topics", item.get("topic"))):
                return False, f"index {idx}: topics must be string or list of strings"
            if not _valid_source(item.get("source")):
                return False, f"index {idx}: source must be object"
        return True, None

    if dataset_name == "trivia":
        for idx, item in enumerate(payload):
            if not isinstance(item, dict):
                return False, f"index {idx}: expected object"
            q = str(item.get("q") or item.get("question") or item.get("prompt") or "").strip()
            options = item.get("options")
            correct = item.get("correct")
            if not q:
                return False, f"index {idx}: missing q"
            if not _valid_options(options):
                return False, f"index {idx}: options must be list with >= 2"
            if not isinstance(correct, int) or correct < 0 or correct >= len(options):
                return False, f"index {idx}: correct index is invalid"
            if not _optional_str(item.get("category")):
                return False, f"index {idx}: category must be string"
            if not _valid_topics(item.get("topics", item.get("topic"))):
                return False, f"index {idx}: topics must be string or list of strings"
            if not _valid_source(item.get("source")):
                return False, f"index {idx}: source must be object"
        return True, None

    if dataset_name == "discussions":
        for idx, item in enumerate(payload):
            prompt = _text_from_item(item, ("prompt", "question", "text", "q"))
            if not _non_empty_str(prompt):
                return False, f"index {idx}: missing prompt"
            if isinstance(item, dict):
                stance_options = item.get("stance_options", item.get("options"))
                if stance_options is not None and not _valid_options(stance_options):
                    return False, f"index {idx}: stance_options must be list with >= 2"
                if not _optional_str(item.get("category")):
                    return False, f"index {idx}: category must be string"
                if not _valid_topics(item.get("topics", item.get("topic"))):
                    return False, f"index {idx}: topics must be string or list of strings"
                if not _valid_source(item.get("source")):
                    return False, f"index {idx}: source must be object"
        return True, None

    return False, "unsupported dataset"


def create_admin_app():
    app = Flask(__name__, template_folder="templates", static_folder="static")
    app.config["SECRET_KEY"] = config.ADMIN_UI_SECRET_KEY
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SECURE"] = bool(config.ADMIN_UI_COOKIE_SECURE)
    app.config["SESSION_COOKIE_SAMESITE"] = "Strict"
    app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(hours=max(1, config.ADMIN_UI_SESSION_HOURS))
    db.ensure_admin_profiles(config.ADMIN_USER_IDS)

    def _ai_config_payload():
        return {
            "enabled": bool(config.LLM_ENABLED),
            "provider": config.LLM_PROVIDER,
            "model": config.LLM_MODEL,
            "api_base_url": config.LLM_API_BASE_URL,
            "timeout_seconds": config.LLM_TIMEOUT_SECONDS,
            "max_tokens": config.LLM_MAX_TOKENS,
            "temperature": config.LLM_TEMPERATURE,
            "autonomous_mode": bool(config.LLM_AUTONOMOUS_MODE),
            "reply_daily_cap": config.LLM_REPLY_DAILY_CAP,
            "reply_thread_daily_cap": config.LLM_REPLY_THREAD_DAILY_CAP,
            "reply_cooldown_seconds": config.LLM_REPLY_COOLDOWN_SECONDS,
            "random_reply_chance": config.LLM_RANDOM_REPLY_CHANCE,
            "min_trigger_score": config.LLM_MIN_TRIGGER_SCORE,
            "max_input_chars": config.LLM_MAX_INPUT_CHARS,
            "available_integrations": [
                {"name": "OpenRouter", "url": "https://openrouter.ai/models"},
                {"name": "OpenAI", "url": "https://platform.openai.com/docs/models"},
                {"name": "Anthropic", "url": "https://docs.anthropic.com/claude/docs/models-overview"},
                {"name": "Google Gemini", "url": "https://ai.google.dev/gemini-api/docs/models/gemini"},
            ],
        }

    def current_admin_user_id():
        token = session.get("admin_session_token")
        if not token:
            return None
        row = db.get_admin_session(token)
        if not row:
            return None
        if _session_expired(row):
            db.revoke_admin_session(token)
            return None
        saved_agent = (row.get("user_agent") if hasattr(row, "get") else row[3]) or ""
        current_agent = request.headers.get("User-Agent", "")
        if saved_agent and current_agent and saved_agent != current_agent:
            db.revoke_admin_session(token)
            return None
        if config.ADMIN_UI_BIND_SESSION_IP:
            saved_ip = (row.get("ip_address") if hasattr(row, "get") else row[2]) or ""
            if saved_ip and saved_ip != _client_ip():
                db.revoke_admin_session(token)
                return None
        db.touch_admin_session(token)
        return int(row.get("user_id") if hasattr(row, "get") else row[1])

    def require_admin():
        user_id = current_admin_user_id()
        if not user_id:
            abort(401, description="not-authenticated")
        return user_id

    @app.before_request
    def _cleanup():
        db.clear_expired_admin_sessions()
        if not _host_allowed():
            abort(403, description="host-not-allowed")
        if not _ip_allowed():
            abort(403, description="ip-not-allowlisted")

    @app.after_request
    def _headers(response):
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Permissions-Policy"] = "geolocation=(), camera=(), microphone=()"
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.route("/admin")
    def admin_home():
        user_id = current_admin_user_id()
        return render_template(
            "admin.html",
            user_id=user_id,
            csrf_token=session.get("csrf_token", ""),
            admin_enabled=config.ADMIN_UI_ENABLED,
        )

    @app.get("/admin/assets/sium8-avatar")
    def admin_avatar_asset():
        avatar_path = ROOT / "sium8_1.png"
        if not avatar_path.exists():
            abort(404, description="avatar-not-found")
        return send_file(avatar_path)

    @app.post("/admin/login")
    def admin_login():
        user_id_raw = str(request.form.get("user_id") or "").strip()
        access_token = str(request.form.get("access_token") or "")

        blocked, wait_seconds = _attempt_blocked(user_id_raw)
        if blocked:
            return redirect(url_for("admin_home") + f"?error=auth-failed&wait={wait_seconds}")

        if not config.ADMIN_UI_ACCESS_TOKEN:
            return redirect(url_for("admin_home") + "?error=token-not-configured")
        if not user_id_raw.lstrip("-").isdigit():
            _record_login_failure(user_id_raw)
            return redirect(url_for("admin_home") + "?error=auth-failed")

        user_id = int(user_id_raw)
        allowed_user = db.is_admin_user(user_id)
        valid_token = bool(config.ADMIN_UI_ACCESS_TOKEN) and secrets.compare_digest(access_token, config.ADMIN_UI_ACCESS_TOKEN)
        if not (allowed_user and valid_token):
            _record_login_failure(user_id_raw)
            db.add_admin_audit("admin.login.failed", actor_user_id=user_id, actor_label="web", details=json.dumps({"ip": _client_ip()}))
            return redirect(url_for("admin_home") + "?error=auth-failed")

        token = secrets.token_urlsafe(40)
        expires_at = datetime.now(timezone.utc) + timedelta(hours=config.ADMIN_UI_SESSION_HOURS)
        db.create_admin_session(
            token=token,
            user_id=user_id,
            expires_at=expires_at.isoformat(),
            ip_address=_client_ip(),
            user_agent=request.headers.get("User-Agent"),
        )
        db.add_admin_audit("admin.login", actor_user_id=user_id, actor_label="web", details="{}")

        _clear_login_failure_state(user_id_raw)
        session.clear()
        session.permanent = True
        session["admin_session_token"] = token
        session["csrf_token"] = secrets.token_urlsafe(24)
        return redirect(url_for("admin_home"))

    @app.post("/admin/logout")
    def admin_logout():
        token = session.get("admin_session_token")
        user_id = current_admin_user_id()
        if token:
            db.revoke_admin_session(token)
        if user_id:
            db.add_admin_audit("admin.logout", actor_user_id=user_id, actor_label="web", details="{}")
        session.clear()
        return redirect(url_for("admin_home"))

    @app.get("/admin/api/bootstrap")
    def api_bootstrap():
        user_id = require_admin()
        pending = db.list_events_by_status("pending_review", limit=40)
        current_profile = db.get_admin_profile(user_id)
        sources = {
            "hk": runtime_settings.source_overrides_for_ui("hk"),
            "global": runtime_settings.source_overrides_for_ui("global"),
        }
        payload = {
            "user_id": user_id,
            "csrf_token": session.get("csrf_token"),
            "schema_status": _schema_status_payload(),
            "settings": runtime_settings.export_runtime_settings(),
            "sources": sources,
            "pending_events": [dict(row) for row in pending],
            "source_status": [dict(row) for row in db.latest_ingestion_run_per_source(limit=30)],
            "recent_runs": [dict(row) for row in db.latest_ingestion_runs(limit=80)],
            "audit": [dict(row) for row in db.list_admin_audit(limit=40)],
            "llm_status_counts": db.llm_status_counts(hours=24),
            "llm_skip_reasons": db.llm_skip_reason_counts(hours=24, limit=10),
            "reddit_cache_stats": db.reddit_cache_stats(hours=24),
            "reddit_subreddit_counts": db.reddit_subreddit_counts(hours=24),
            "reddit_cache_rows": [dict(row) for row in db.list_reddit_cache(limit=30, offset=0)],
            "system_metrics": _system_metrics_snapshot(),
            "ai_config": _ai_config_payload(),
            "admin_profiles": [dict(row) for row in db.list_admin_profiles()],
            "current_admin_profile": dict(current_profile) if current_profile else None,
        }
        return jsonify(payload)

    @app.get("/admin/api/admin-profiles")
    def api_admin_profiles():
        require_admin()
        return jsonify({"rows": [dict(row) for row in db.list_admin_profiles()]})

    @app.post("/admin/api/admin-profiles")
    def api_upsert_admin_profile():
        actor_user_id = require_admin()
        _require_csrf()
        payload = request.get_json(silent=True) or {}
        user_id_raw = str(payload.get("user_id") or "").strip()
        if not user_id_raw:
            return jsonify({"ok": False, "error": "user_id is required"}), 400
        try:
            user_id = int(user_id_raw)
        except Exception:
            return jsonify({"ok": False, "error": "invalid user_id"}), 400
        display_name = str(payload.get("display_name") or "").strip()
        username = str(payload.get("username") or "").strip()
        email = str(payload.get("email") or "").strip()
        role = str(payload.get("role") or "admin").strip().lower() or "admin"
        is_active = bool(payload.get("is_active", True))
        is_primary = bool(payload.get("is_primary", False))
        notes = str(payload.get("notes") or "").strip()
        db.upsert_admin_profile(
            user_id=user_id,
            display_name=display_name,
            username=username,
            email=email,
            role=role,
            is_active=is_active,
            is_primary=is_primary,
            notes=notes,
        )
        db.add_admin_audit(
            "admin.profile.update",
            actor_user_id=actor_user_id,
            actor_label="web",
            details=json.dumps({"user_id": user_id, "email": email, "is_active": is_active, "is_primary": is_primary}),
        )
        profile = db.get_admin_profile(user_id)
        return jsonify({"ok": True, "profile": dict(profile) if profile else None})

    @app.delete("/admin/api/admin-profiles/<int:user_id>")
    def api_delete_admin_profile(user_id):
        actor_user_id = require_admin()
        _require_csrf()
        if user_id in config.ADMIN_USER_IDS:
            return jsonify({"ok": False, "error": "cannot-delete-seeded-admin"}), 400
        db.delete_admin_profile(user_id)
        db.add_admin_audit(
            "admin.profile.delete",
            actor_user_id=actor_user_id,
            actor_label="web",
            details=json.dumps({"user_id": user_id}),
        )
        return jsonify({"ok": True})

    @app.get("/admin/api/ai-config")
    def api_ai_config():
        require_admin()
        return jsonify(_ai_config_payload())

    @app.get("/admin/api/system-metrics")
    def api_system_metrics():
        require_admin()
        return jsonify(_system_metrics_snapshot())

    @app.get("/admin/api/telemetry")
    def api_telemetry():
        require_admin()
        hours_raw = request.args.get("hours", "24")
        run_type = str(request.args.get("run_type", "all")).strip().lower()
        if run_type not in ("all", "hk", "global"):
            run_type = "all"
        try:
            hours = max(1, min(168, int(hours_raw)))
        except Exception:
            hours = 24

        summary = _operational_summary(hours=hours, run_type=run_type)
        scheduler_breakdown = _attach_post_audit(db.scheduler_selected_breakdown(hours=hours, limit=24))
        payload = {
            "hours": hours,
            "run_type": run_type,
            "llm_status_counts": db.llm_status_counts(hours=hours),
            "llm_skip_reasons": db.llm_skip_reason_counts(hours=hours, limit=12),
            "reddit_cache_stats": db.reddit_cache_stats(hours=hours),
            "reddit_subreddit_counts": db.reddit_subreddit_counts(hours=hours),
            "recent_runs": db.ingestion_runs_window(hours=hours, run_type=run_type),
            "command_usage_counts": db.command_usage_counts(hours=hours, limit=30),
            "top_commands": db.top_commands(hours=hours, limit=8),
            "command_error_rates": db.command_error_rates(hours=hours, limit=12),
            "scheduler_topics": db.scheduler_topic_counts(hours=hours, selected_only=True),
            "scheduler_outcomes": db.scheduler_outcome_counts(hours=hours),
            "scheduler_breakdown": scheduler_breakdown,
            "scheduler_trends": _scheduler_trend_points(scheduler_breakdown),
            "scheduler_outcome_timeseries": db.scheduler_outcome_timeseries(hours=hours, bucket_minutes=60),
            "scheduled_upcoming": [dict(row) for row in db.upcoming_scheduler_decisions(limit=10)],
            "command_failure_timeseries": db.command_failure_timeseries(hours=hours, bucket_minutes=60),
            "summary": summary,
            "alerts": _build_operational_alerts(summary),
        }
        return jsonify(payload)

    @app.get("/admin/api/scheduler-plan/<path:plan_key>")
    def api_scheduler_plan_detail(plan_key):
        require_admin()
        rows = _attach_post_audit(db.scheduler_plan_detail(plan_key))
        if not rows:
            return jsonify({"plan_key": plan_key, "rows": [], "summary": {"selected": 0, "sent": 0, "failed": 0}})
        selected = [row for row in rows if int(row.get("selected") or 0) == 1]
        sent = sum(1 for row in selected if str(row.get("execution_status") or "") == "sent")
        failed = sum(1 for row in selected if str(row.get("execution_status") or "") == "failed")
        return jsonify({
            "plan_key": plan_key,
            "rows": rows,
            "summary": {
                "selected": len(selected),
                "sent": sent,
                "failed": failed,
            },
        })

    @app.get("/admin/api/datasets/<dataset_name>")
    def api_get_dataset(dataset_name):
        require_admin()
        return jsonify({"name": dataset_name, "data": _load_dataset(dataset_name)})

    @app.post("/admin/api/datasets/<dataset_name>")
    def api_save_dataset(dataset_name):
        user_id = require_admin()
        _require_csrf()
        payload = request.get_json(silent=True) or {}
        data = payload.get("data")
        valid, err = _validate_dataset(dataset_name, data)
        if not valid:
            return jsonify({"ok": False, "error": err}), 400
        _save_dataset(dataset_name, data)
        db.add_admin_audit(
            "dataset.update",
            actor_user_id=user_id,
            actor_label="web",
            details=json.dumps({"dataset": dataset_name, "items": len(data)}),
        )
        return jsonify({"ok": True, "size": len(data)})

    @app.post("/admin/api/settings")
    def api_save_settings():
        user_id = require_admin()
        _require_csrf()
        payload = request.get_json(silent=True) or {}
        updates = payload.get("settings") or {}
        if not isinstance(updates, dict):
            return jsonify({"ok": False, "error": "settings must be object"}), 400
        runtime_settings.set_many(updates, updated_by=user_id)
        db.add_admin_audit(
            "settings.update",
            actor_user_id=user_id,
            actor_label="web",
            details=json.dumps({"keys": sorted(updates.keys())}),
        )
        return jsonify({"ok": True, "settings": runtime_settings.export_runtime_settings()})

    @app.post("/admin/api/sources/<run_type>")
    def api_save_sources(run_type):
        user_id = require_admin()
        _require_csrf()
        if run_type not in ("hk", "global"):
            return jsonify({"ok": False, "error": "run_type must be hk or global"}), 400
        payload = request.get_json(silent=True) or {}
        sources = payload.get("sources")
        if not isinstance(sources, list):
            return jsonify({"ok": False, "error": "sources must be an array"}), 400
        for source in sources:
            valid, err = _valid_source_row(source)
            if not valid:
                return jsonify({"ok": False, "error": err}), 400
        runtime_settings.set_sources(run_type, sources, updated_by=user_id)
        db.add_admin_audit(
            "sources.update",
            actor_user_id=user_id,
            actor_label="web",
            details=json.dumps({"run_type": run_type, "count": len(sources)}),
        )
        return jsonify({"ok": True, "sources": runtime_settings.source_overrides_for_ui(run_type)})

    @app.post("/admin/api/events/<int:event_id>/status")
    def api_set_event_status(event_id):
        user_id = require_admin()
        _require_csrf()
        payload = request.get_json(silent=True) or {}
        status = str(payload.get("status") or "").strip().lower()
        if status not in ("approved", "rejected", "pending_review"):
            return jsonify({"ok": False, "error": "invalid status"}), 400
        db.set_event_status(event_id, status)
        db.add_admin_audit(
            "events.status",
            actor_user_id=user_id,
            actor_label="web",
            details=json.dumps({"event_id": event_id, "status": status}),
        )
        return jsonify({"ok": True})

    @app.post("/admin/api/ingest-now")
    def api_ingest_now():
        user_id = require_admin()
        _require_csrf()
        payload = request.get_json(silent=True) or {}
        run_type = str(payload.get("run_type") or "all").strip().lower()
        if run_type not in ("all", "hk", "global"):
            return jsonify({"ok": False, "error": "invalid run_type"}), 400
        summary = events_handler.ingest_now(run_type)
        db.add_admin_audit(
            "ingest.manual",
            actor_user_id=user_id,
            actor_label="web",
            details=json.dumps({"run_type": run_type, "summary": summary}),
        )
        return jsonify({"ok": True, "summary": summary})

    @app.post("/admin/api/dataset-ingest-now")
    def api_dataset_ingest_now():
        user_id = require_admin()
        _require_csrf()
        summary = dataset_collectors_handler.ingest_dataset_sources()
        db.add_admin_audit(
            "dataset_ingest.manual",
            actor_user_id=user_id,
            actor_label="web",
            details=json.dumps({"summary": summary}),
        )
        return jsonify({"ok": True, "summary": summary})

    @app.get("/admin/api/dataset-candidates")
    def api_dataset_candidates():
        require_admin()
        dataset_name = str(request.args.get("dataset", "")).strip().lower() or None
        status = str(request.args.get("status", "candidate")).strip().lower() or None
        limit_raw = request.args.get("limit", "40")
        offset_raw = request.args.get("offset", "0")
        try:
            limit = max(1, min(300, int(limit_raw)))
        except Exception:
            limit = 40
        try:
            offset = max(0, int(offset_raw))
        except Exception:
            offset = 0
        rows = db.list_dataset_candidates(dataset_name=dataset_name, status=status, limit=limit, offset=offset)
        total = db.dataset_candidates_count(dataset_name=dataset_name, status=status)
        return jsonify({
            "rows": [dict(row) for row in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
            "dataset": dataset_name,
            "status": status,
        })

    @app.post("/admin/api/dataset-candidates/<int:candidate_id>/approve")
    def api_dataset_candidate_approve(candidate_id):
        user_id = require_admin()
        _require_csrf()
        result = dataset_collectors_handler.approve_candidate(candidate_id)
        db.add_admin_audit(
            "dataset_candidate.approve",
            actor_user_id=user_id,
            actor_label="web",
            details=json.dumps({"candidate_id": candidate_id, "result": result}),
        )
        status = 200 if result.get("ok") else 400
        return jsonify(result), status

    @app.post("/admin/api/dataset-candidates/<int:candidate_id>/reject")
    def api_dataset_candidate_reject(candidate_id):
        user_id = require_admin()
        _require_csrf()
        result = dataset_collectors_handler.reject_candidate(candidate_id)
        db.add_admin_audit(
            "dataset_candidate.reject",
            actor_user_id=user_id,
            actor_label="web",
            details=json.dumps({"candidate_id": candidate_id, "result": result}),
        )
        status = 200 if result.get("ok") else 400
        return jsonify(result), status

    @app.post("/admin/api/dataset-candidates/bulk-approve")
    def api_dataset_candidates_bulk_approve():
        user_id = require_admin()
        _require_csrf()
        payload = request.get_json(silent=True) or {}
        raw_ids = payload.get("ids")
        if not isinstance(raw_ids, list) or not raw_ids:
            return jsonify({"ok": False, "error": "ids must be a non-empty array"}), 400

        ids = []
        for value in raw_ids[:500]:
            try:
                num = int(value)
            except Exception:
                continue
            if num > 0:
                ids.append(num)
        if not ids:
            return jsonify({"ok": False, "error": "no valid candidate ids"}), 400

        approved = 0
        failed = 0
        failures = []
        for candidate_id in ids:
            row = db.get_dataset_candidate(candidate_id)
            if not row:
                failed += 1
                failures.append({"id": candidate_id, "reason": "not-found"})
                continue
            current_status = str(row.get("status") if hasattr(row, "get") else row[11]).strip().lower()
            if current_status != "candidate":
                failed += 1
                failures.append({"id": candidate_id, "reason": f"not-candidate:{current_status}"})
                continue
            result = dataset_collectors_handler.approve_candidate(candidate_id)
            if result.get("ok"):
                approved += 1
            else:
                failed += 1
                failures.append({"id": candidate_id, "reason": result.get("reason") or "unknown"})

        summary = {"ok": True, "approved": approved, "failed": failed, "failures": failures[:20], "requested": len(ids)}
        db.add_admin_audit(
            "dataset_candidate.bulk_approve",
            actor_user_id=user_id,
            actor_label="web",
            details=json.dumps(summary),
        )
        return jsonify(summary)

    @app.post("/admin/api/dataset-candidates/bulk-reject")
    def api_dataset_candidates_bulk_reject():
        user_id = require_admin()
        _require_csrf()
        payload = request.get_json(silent=True) or {}
        raw_ids = payload.get("ids")
        if not isinstance(raw_ids, list) or not raw_ids:
            return jsonify({"ok": False, "error": "ids must be a non-empty array"}), 400

        ids = []
        for value in raw_ids[:500]:
            try:
                num = int(value)
            except Exception:
                continue
            if num > 0:
                ids.append(num)
        if not ids:
            return jsonify({"ok": False, "error": "no valid candidate ids"}), 400

        rejected = 0
        failed = 0
        failures = []
        for candidate_id in ids:
            row = db.get_dataset_candidate(candidate_id)
            if not row:
                failed += 1
                failures.append({"id": candidate_id, "reason": "not-found"})
                continue
            current_status = str(row.get("status") if hasattr(row, "get") else row[11]).strip().lower()
            if current_status != "candidate":
                failed += 1
                failures.append({"id": candidate_id, "reason": f"not-candidate:{current_status}"})
                continue
            result = dataset_collectors_handler.reject_candidate(candidate_id)
            if result.get("ok"):
                rejected += 1
            else:
                failed += 1
                failures.append({"id": candidate_id, "reason": result.get("reason") or "unknown"})

        summary = {"ok": True, "rejected": rejected, "failed": failed, "failures": failures[:20], "requested": len(ids)}
        db.add_admin_audit(
            "dataset_candidate.bulk_reject",
            actor_user_id=user_id,
            actor_label="web",
            details=json.dumps(summary),
        )
        return jsonify(summary)

    @app.get("/admin/api/source-status")
    def api_source_status():
        require_admin()
        return jsonify({"rows": [dict(row) for row in db.latest_ingestion_run_per_source(limit=50)]})

    @app.get("/admin/api/audit")
    def api_audit():
        require_admin()
        return jsonify({"rows": [dict(row) for row in db.list_admin_audit(limit=100)]})

    @app.get("/admin/api/reddit-cache")
    def api_reddit_cache():
        require_admin()
        limit_raw = request.args.get("limit", "30")
        offset_raw = request.args.get("offset", "0")
        relayed_raw = request.args.get("relayed")
        blocked_raw = request.args.get("blocked")
        subreddit = str(request.args.get("subreddit", "")).strip().lower() or None
        content_type = str(request.args.get("content_type", "")).strip().lower() or None
        query = str(request.args.get("q", "")).strip() or None
        sort_by = str(request.args.get("sort_by", "fetched_at")).strip().lower() or "fetched_at"
        sort_dir = str(request.args.get("sort_dir", "desc")).strip().lower() or "desc"

        try:
            limit = max(1, min(200, int(limit_raw)))
        except Exception:
            limit = 30
        try:
            offset = max(0, int(offset_raw))
        except Exception:
            offset = 0

        relayed = None
        blocked = None
        if relayed_raw in ("0", "1"):
            relayed = relayed_raw == "1"
        if blocked_raw in ("0", "1"):
            blocked = blocked_raw == "1"

        rows = db.list_reddit_cache(
            limit=limit,
            offset=offset,
            relayed=relayed,
            blocked=blocked,
            subreddit=subreddit,
            content_type=content_type,
            query=query,
            sort_by=sort_by,
            sort_dir=sort_dir,
        )
        total = db.reddit_cache_count(
            relayed=relayed,
            blocked=blocked,
            subreddit=subreddit,
            content_type=content_type,
            query=query,
        )
        return jsonify({
            "rows": [dict(row) for row in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
            "sort_by": sort_by,
            "sort_dir": sort_dir,
        })

    @app.post("/admin/api/reddit-cache/<int:cache_id>/relay")
    def api_force_relay_cache_item(cache_id):
        user_id = require_admin()
        _require_csrf()
        payload = request.get_json(silent=True) or {}
        force = bool(payload.get("force", True))
        result = reddit_ingest_handler.force_relay_cache_item(cache_id, force=force)
        db.add_admin_audit(
            "reddit.force_relay",
            actor_user_id=user_id,
            actor_label="web",
            details=json.dumps({"cache_id": cache_id, "force": force, "result": result}),
        )
        status = 200 if result.get("ok") else 400
        return jsonify(result), status

    @app.post("/admin/api/reddit-cache/<int:cache_id>/unblock")
    def api_unblock_cache_item(cache_id):
        user_id = require_admin()
        _require_csrf()
        db.clear_reddit_blocked(cache_id)
        db.add_admin_audit(
            "reddit.unblock",
            actor_user_id=user_id,
            actor_label="web",
            details=json.dumps({"cache_id": cache_id}),
        )
        return jsonify({"ok": True})

    return app
