DROP INDEX IF EXISTS idx_admin_audit_created;
DROP INDEX IF EXISTS idx_source_overrides_rt_enabled_pos;
DROP INDEX IF EXISTS idx_admin_sessions_expires;

DROP TABLE IF EXISTS admin_audit;
DROP TABLE IF EXISTS admin_sessions;
DROP TABLE IF EXISTS source_overrides;
DROP TABLE IF EXISTS runtime_settings;
