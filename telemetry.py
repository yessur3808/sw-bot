import time
from datetime import datetime, timezone

import db


def instrument_command_handler(command_name, handler):
    async def wrapped(update, context):
        started = time.perf_counter()
        status = "ok"
        error_text = None
        try:
            return await handler(update, context)
        except Exception as exc:
            status = "error"
            error_text = f"{type(exc).__name__}: {exc}"[:500]
            raise
        finally:
            latency_ms = int((time.perf_counter() - started) * 1000)
            user = getattr(update, "effective_user", None)
            chat = getattr(update, "effective_chat", None)
            message = getattr(update, "effective_message", None)
            thread_id = getattr(message, "message_thread_id", None) if message else None
            args = getattr(context, "args", None) or []
            args_text = " ".join(str(value).strip() for value in args if str(value).strip())[:500] or None
            is_admin = bool(user and db.is_admin_user(user.id))
            db.log_command_usage(
                command_name=command_name,
                status=status,
                user_id=(user.id if user else None),
                chat_id=(chat.id if chat else None),
                thread_id=thread_id,
                args_text=args_text,
                is_admin=is_admin,
                latency_ms=latency_ms,
                error=error_text,
            )

    wrapped.__name__ = getattr(handler, "__name__", "wrapped_command")
    wrapped.__doc__ = getattr(handler, "__doc__", None)
    return wrapped


def _scheduler_job_payload(context):
    job = getattr(context, "job", None)
    if not job:
        return None
    data = getattr(job, "data", None)
    return data if isinstance(data, dict) else None


def scheduler_execution_logged(context):
    data = _scheduler_job_payload(context)
    if not data:
        return False
    return bool(data.get("_scheduler_execution_logged"))


def mark_scheduler_execution_outcome(
    context,
    status,
    message_id=None,
    content_type=None,
    content_id=None,
    error=None,
):
    data = _scheduler_job_payload(context)
    if not data:
        return False
    plan_key = data.get("plan_key")
    slot_index = data.get("slot_index")
    scheduled_run_at = data.get("scheduled_run_at")
    if plan_key is None or slot_index is None:
        return False
    latency_ms = None
    if scheduled_run_at:
        try:
            scheduled_dt = datetime.fromisoformat(str(scheduled_run_at).replace("Z", "+00:00"))
            if scheduled_dt.tzinfo is None:
                scheduled_dt = scheduled_dt.replace(tzinfo=timezone.utc)
            latency_ms = max(0, int((datetime.now(timezone.utc) - scheduled_dt.astimezone(timezone.utc)).total_seconds() * 1000))
        except Exception:
            latency_ms = None
    db.mark_scheduler_execution(
        plan_key=plan_key,
        slot_index=slot_index,
        execution_status=str(status),
        execution_error=(str(error)[:500] if error else None),
        executed_message_id=message_id,
        executed_content_type=content_type,
        executed_content_id=content_id,
        execution_latency_ms=latency_ms,
    )
    data["_scheduler_execution_logged"] = True
    data["_scheduler_execution_status"] = str(status)
    return True