# Star Wars Bot

## Quick Onboarding (Copy-Paste)

### 1) Build and run with SQLite (default)

```bash
make build
make up
make logs
```

### 2) Run with Postgres (Compose profile)

Set these in `.env` first:

```dotenv
DB_BACKEND=postgres
DATABASE_URL=postgresql://starwars:starwars@postgres:5432/starwars
```

Then run:

```bash
make up-postgres
make logs
```

### 3) One-time SQLite -> Postgres migration

```bash
make migrate
```

Or from host Python:

```bash
make migrate-local
```

### 4) Schema migrations (up/down)

```bash
make migrate-up
make migrate-down
```

### 5) Useful operations

```bash
make ps
make shell
make restart
make down
```

### Troubleshooting (Docker/Compose)

Fast health check:

```bash
docker compose ps && make logs
```

Use this quick flow:

1. `make up` fails immediately?
	- Error mentions Docker not found: install/start Docker Engine (or Docker Desktop).
	- Error mentions `docker compose` not found: install Docker Compose v2 / update Docker.
2. Container starts, then bot exits?
	- Check `.env` required keys: `BOT_TOKEN`, `GROUP_ID`, `THREAD_LORE`, `THREAD_MEMES`, `THREAD_WALLPAPERS`, `THREAD_GENERAL`.
	- Re-run: `make logs`.
3. Running Postgres mode and connection fails?
	- Verify `.env` has `DB_BACKEND=postgres` and valid `DATABASE_URL`.
	- If using compose Postgres, host must be `postgres` and you must run `make up-postgres`.
4. Migration command fails?
	- Confirm Postgres is reachable and `DATABASE_URL` credentials are correct.
	- Retry with `make migrate-local` if compose networking is restricted.
5. SQLite write errors (`starwars.db` permission denied)?
	- Ensure your user can read/write project files and `starwars.db`.

## Preview

![Sium8 Preview](sium8_1.png)

## Event Ingestion Enhancements

The events pipeline now supports richer multi-source ingestion for Hong Kong and global coverage:

- RSS and official feeds
- JSON API sources (public endpoints)
- Structured scrape extraction from HTML (JSON-LD Event + anchor candidate fallback)

### Source Config Format

`HK_SOURCE_CONFIG` and `GLOBAL_SOURCE_CONFIG` accept entries in this format:

`tier|kind|name|url|k=v,k=v`

- The metadata section is optional.
- Backward compatibility is preserved with `tier|kind|name|url`.

Example:

`scrape|event|StarWars.com Events Category|https://www.starwars.com/news/category/events|parser=starwars_tag,locale=en`

Recommended parser values:

- `parser=starwars_tag` for StarWars.com tag/event pages
- `parser=fandom` for fandom/wookieepedia style wiki pages
- `parser=generic` for default fallback extraction

### New Ingestion Controls

- `INGEST_FEED_LIMIT` max feed entries per source
- `INGEST_API_LIMIT` max API records per source
- `INGEST_SCRAPE_LIMIT` max extracted scrape candidates per source
- `HK_ENABLE_ZH` include/exclude Chinese-locale HK sources

### Notes

- Scrape mode still obeys source compliance controls (`SCRAPE_SOURCE_ALLOWLIST`, robots, and TOS allowlists when enabled).
- URL canonicalization now strips common tracking params to reduce duplicate event rows across source tiers.
- `/source_status` now includes tier, parser strategy, extraction health, and save ratio per source.
- `StarWars.com News` feed now falls back to structured extraction from `https://www.starwars.com/news` when feed parsing returns empty.

## Event Metadata Schema

Migration `000003_event_metadata` adds enrichment fields to `events`:

- `canonical_url`
- `dedupe_key`
- `location_text`
- `language`
- `raw_event_type`
- `source_meta`

It also creates indexes for faster filtering and diagnostics on event status/region/date and dedupe lookups.
