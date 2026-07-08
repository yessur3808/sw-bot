CREATE TABLE IF NOT EXISTS scheduler_decisions_backup_000007 AS
SELECT
    id,
    plan_key,
    slot_index,
    topic,
    score,
    selected,
    scheduled_for_date,
    run_at,
    score_factors,
    reason,
    execution_status,
    executed_at,
    execution_error,
    executed_message_id,
    executed_content_type,
    executed_content_id,
    created_at
FROM scheduler_decisions;

DROP TABLE IF EXISTS scheduler_decisions;

CREATE TABLE scheduler_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_key TEXT NOT NULL,
    slot_index INTEGER NOT NULL,
    topic TEXT NOT NULL,
    score REAL NOT NULL DEFAULT 0,
    selected INTEGER NOT NULL DEFAULT 0,
    scheduled_for_date TEXT,
    run_at TEXT,
    score_factors TEXT,
    reason TEXT,
    execution_status TEXT,
    executed_at TEXT,
    execution_error TEXT,
    executed_message_id INTEGER,
    executed_content_type TEXT,
    executed_content_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO scheduler_decisions (
    id,
    plan_key,
    slot_index,
    topic,
    score,
    selected,
    scheduled_for_date,
    run_at,
    score_factors,
    reason,
    execution_status,
    executed_at,
    execution_error,
    executed_message_id,
    executed_content_type,
    executed_content_id,
    created_at
)
SELECT
    id,
    plan_key,
    slot_index,
    topic,
    score,
    selected,
    scheduled_for_date,
    run_at,
    score_factors,
    reason,
    execution_status,
    executed_at,
    execution_error,
    executed_message_id,
    executed_content_type,
    executed_content_id,
    created_at
FROM scheduler_decisions_backup_000007;

DROP TABLE IF EXISTS scheduler_decisions_backup_000007;

CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_plan_slot ON scheduler_decisions(plan_key, slot_index, selected);
CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_created ON scheduler_decisions(created_at);
CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_run_at ON scheduler_decisions(run_at);
CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_exec_status ON scheduler_decisions(execution_status, executed_at);
