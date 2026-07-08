DROP INDEX IF EXISTS idx_command_usage_name_created;
DROP INDEX IF EXISTS idx_command_usage_created;
DROP INDEX IF EXISTS idx_scheduler_decisions_exec_status;
DROP INDEX IF EXISTS idx_scheduler_decisions_run_at;
DROP INDEX IF EXISTS idx_scheduler_decisions_created;
DROP INDEX IF EXISTS idx_scheduler_decisions_plan_slot;

DROP TABLE IF EXISTS command_usage_audit;
DROP TABLE IF EXISTS scheduler_decisions;
