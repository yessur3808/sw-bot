CREATE TABLE IF NOT EXISTS deployment_identity (
 id INTEGER PRIMARY KEY CHECK(id=1),
 group_id TEXT NOT NULL,
 environment TEXT NOT NULL CHECK(environment IN ('test','production'))
);
CREATE TABLE IF NOT EXISTS automated_budget (
 day TEXT NOT NULL,
 update_id INTEGER NOT NULL,
 PRIMARY KEY(day,update_id)
);
-- Identity must be inserted explicitly after verifying the database and group.
-- Do not automatically derive it from Worker environment variables.
