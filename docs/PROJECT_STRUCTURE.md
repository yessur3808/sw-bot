# Project Structure

This repository uses a pragmatic layout optimized for operations and readability.

## Top-level

- `bot.py` - app bootstrap, scheduler wiring, command registration.
- `config.py` - environment-driven runtime settings.
- `db.py` - database adapter (sqlite default, optional postgres).
- `handlers/` - Telegram command and scheduled content handlers.
- `data/` - static datasets (facts, polls, quotes, trivia).
- `migrations/` - versioned schema migrations with `up/down` scripts for sqlite and postgres.
- `scripts/db/` - database utility scripts:
  - `migrate_schema.py` for `up/down` schema changes.
  - `migrate_sqlite_to_postgres.py` for one-time data copy.
- `docker-compose.yml` + `Dockerfile` + `Makefile` - local runtime and task automation.

## Migration workflow

1. Apply schema migration:
   - `make migrate-up`
2. Roll back latest migration:
   - `make migrate-down`
3. One-time sqlite -> postgres data copy:
   - `make migrate-local`
