import json

import db
from handlers import events


def _row_to_dict(row):
    if hasattr(row, "keys"):
        return {k: row[k] for k in row.keys()}
    return {
        "id": row[0],
        "run_type": row[1],
        "source_name": row[2],
        "source_url": row[3],
        "status": row[4],
        "fetched_count": row[5],
        "saved_count": row[6],
        "error": row[7],
        "created_at": row[8],
    }


def _scalar(conn, query, args=()):
    row = conn.execute(query, args).fetchone()
    if row is None:
        return 0
    if hasattr(row, "keys"):
        first_key = next(iter(row.keys()))
        return int(row[first_key] or 0)
    return int(row[0] or 0)


def snapshot():
    with db.get_db() as conn:
        total_runs = _scalar(conn, "SELECT COUNT(*) FROM ingestion_runs")
        max_run_id = _scalar(conn, "SELECT COALESCE(MAX(id),0) FROM ingestion_runs")
        total_events = _scalar(conn, "SELECT COUNT(*) FROM events")
    return {
        "total_runs": total_runs,
        "max_run_id": max_run_id,
        "total_events": total_events,
    }


def run_and_measure(mode):
    before = snapshot()
    summaries = events.ingest_now(mode)
    after = snapshot()

    with db.get_db() as conn:
        rows = db._execute(
            conn,
            """
            SELECT id, run_type, source_name, source_url, status, fetched_count, saved_count, error, created_at
            FROM ingestion_runs
            WHERE id > ?
            ORDER BY id ASC
            """,
            (before["max_run_id"],),
        ).fetchall()

    run_rows = [_row_to_dict(r) for r in rows]
    fetched_delta = sum(int(r.get("fetched_count") or 0) for r in run_rows)
    saved_delta = sum(int(r.get("saved_count") or 0) for r in run_rows)
    blocked_delta = sum(1 for r in run_rows if str(r.get("status", "")).startswith("blocked:"))

    return {
        "mode": mode,
        "summaries": summaries,
        "delta": {
            "total_runs_added": after["total_runs"] - before["total_runs"],
            "events_table_delta": after["total_events"] - before["total_events"],
            "fetched_sum_delta": fetched_delta,
            "saved_sum_delta": saved_delta,
            "blocked_sources_delta": blocked_delta,
        },
        "new_runs": run_rows,
    }


def main():
    db.init_db()
    results = [run_and_measure("hk"), run_and_measure("global"), run_and_measure("all")]
    print(json.dumps(results, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
