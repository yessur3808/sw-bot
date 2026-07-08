CREATE TABLE IF NOT EXISTS scheduler_decisions (
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

CREATE TABLE IF NOT EXISTS command_usage_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command_name TEXT NOT NULL,
    status TEXT NOT NULL,
    user_id INTEGER,
    chat_id INTEGER,
    thread_id INTEGER,
    args_text TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER,
    error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_plan_slot ON scheduler_decisions(plan_key, slot_index, selected);
CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_created ON scheduler_decisions(created_at);
CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_run_at ON scheduler_decisions(run_at);
CREATE INDEX IF NOT EXISTS idx_scheduler_decisions_exec_status ON scheduler_decisions(execution_status, executed_at);
CREATE INDEX IF NOT EXISTS idx_command_usage_created ON command_usage_audit(created_at);
CREATE INDEX IF NOT EXISTS idx_command_usage_name_created ON command_usage_audit(command_name, created_at);
