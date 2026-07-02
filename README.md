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

## Admin Control Center (Web UI)

The bot now includes a secure admin web console for:

- Editing datasets (`data/facts.json`, `data/quotes.json`, `data/polls.json`, `data/trivia.json`)
- Editing datasets (`data/facts.json`, `data/quotes.json`, `data/polls.json`, `data/trivia.json`, `data/discussions.json`)
- Reviewing pending events (approve/reject)
- Triggering ingestion manually
- Managing runtime setting overrides stored in DB
- Managing source overrides for HK/global ingestion
- Reviewing admin audit activity

### Enable admin UI

Add these keys to `.env`:

```dotenv
ADMIN_UI_ENABLED=true
ADMIN_UI_HOST=0.0.0.0
ADMIN_UI_PORT=8088
ADMIN_UI_ACCESS_TOKEN=<strong-random-token>
ADMIN_UI_SECRET_KEY=<long-random-secret>
ADMIN_UI_SESSION_HOURS=12
ADMIN_UI_COOKIE_SECURE=true
ADMIN_UI_ALLOWED_HOSTS=admin.example.com
ADMIN_UI_IP_ALLOWLIST=
ADMIN_UI_MAX_LOGIN_ATTEMPTS=5
ADMIN_UI_LOGIN_WINDOW_MINUTES=10
ADMIN_UI_LOGIN_LOCKOUT_MINUTES=20
ADMIN_UI_BIND_SESSION_IP=false
```

Ensure your Telegram ID is listed in:

```dotenv
ADMIN_USER_IDS=123456789
```

Then run the bot and open:

`http://localhost:8088/admin`

### Security notes

- For internet-facing deployments, run behind HTTPS reverse proxy (Nginx/Caddy).
- Use strong random values for `ADMIN_UI_ACCESS_TOKEN` and `ADMIN_UI_SECRET_KEY`.
- Keep `ADMIN_USER_IDS` tightly scoped.
- Rotate access token periodically.
- Set `ADMIN_UI_COOKIE_SECURE=true` when served over HTTPS.
- Use `ADMIN_UI_ALLOWED_HOSTS` and optional `ADMIN_UI_IP_ALLOWLIST` for perimeter hardening.
- Failed login attempts are rate-limited and temporarily locked out.

## Autonomous LLM Replies (Telegram)

The bot can now auto-reply with short clever thread responses and meme reactions.

Behavior summary:

- Responds only in configured thread IDs (`LLM_ALLOWED_THREAD_NAMES` mapping).
- Uses trigger scoring + random chance for natural pacing.
- Enforces daily caps, per-thread caps, cooldown, and duplicate suppression.
- Falls back to safe canned lines if provider/API is unavailable.
- Writes full action telemetry to `llm_action_audit` for monitoring.

Required/important `.env` keys:

```dotenv
LLM_ENABLED=true
LLM_PROVIDER=openrouter
LLM_MODEL=meta-llama/llama-3.1-8b-instruct:free
LLM_API_KEY=<provider-api-key>
LLM_AUTONOMOUS_MODE=true
LLM_REPLY_DAILY_CAP=40
LLM_REPLY_THREAD_DAILY_CAP=12
LLM_REPLY_COOLDOWN_SECONDS=180
LLM_RANDOM_REPLY_CHANCE=0.12
LLM_MIN_TRIGGER_SCORE=0.65
LLM_ALLOWED_THREAD_NAMES=general,memes,lore,movie,show
```

Runtime tuning:

- Use Admin UI `Runtime Settings` to tune limits live (`enable_llm_autonomy`, caps, cooldown, trigger score).

## Reddit Ingest Cache + Relay

The bot now supports Reddit ingestion for both posts and comments, stores metadata in local DB, dedupes by stable keys, and can relay cached items into Telegram threads.

Behavior summary:

- Fetches from `REDDIT_SUBREDDITS` using score thresholds.
- Stores post/comment cache rows in `reddit_ingest_cache`.
- Supports periodic relay of unrelayed items to a configured Telegram thread.
- Includes admin commands:
	- `/reddit_ingest_now` to run one-shot ingest.
	- `/reddit_digest [limit]` to preview queued cache items.

Key `.env` settings:

```dotenv
REDDIT_INGEST_ENABLED=true
REDDIT_RELAY_ENABLED=true
REDDIT_SUBREDDITS=StarWars,StarWarsMemes,PrequelMemes,sequelmemes
REDDIT_POST_LIMIT=20
REDDIT_COMMENTS_PER_POST=2
REDDIT_MIN_POST_SCORE=30
REDDIT_MIN_COMMENT_SCORE=8
REDDIT_INGEST_INTERVAL_MINUTES=30
REDDIT_RELAY_INTERVAL_MINUTES=45
REDDIT_RELAY_BATCH_SIZE=4
REDDIT_RELAY_THREAD=memes
REDDIT_BANNED_SUBREDDITS=
REDDIT_BANNED_WORDS=
```

Admin Console additions:

- `Reddit Cache` tab to browse cached rows with filters (`type`, `relayed`, `blocked`, `subreddit`, search).
- Manual relay actions per row:
	- `Relay (Safe)` applies safety filters.
	- `Force Relay` bypasses safety filters for admin override.
	- `Unblock` clears blocked state.

Relay safety behavior:

- If subreddit is in `REDDIT_BANNED_SUBREDDITS`, row is blocked before relay.
- If title/body includes any token in `REDDIT_BANNED_WORDS`, row is blocked before relay.
- Blocked rows are excluded from automatic relay queue until unblocked or force-relayed.

## Automatic Original-Source Dataset Collectors

The bot now supports scheduled ingestion jobs that collect candidate entries for:

- facts
- quotes
- trivia
- polls
- controversial discussion topics

These collectors read from selected canonical source endpoints, extract candidate items, and store them with source attribution in DB table `dataset_ingest_candidates`.

Behavior summary:

- Runs on a repeating scheduler (similar to event/reddit ingestion).
- Keeps source attribution per candidate (`source_name`, `source_url`, `source_tier`, `source_meta`).
- Uses dedupe keys to avoid duplicate candidate spam.
- Includes an approval queue: approved candidates are appended directly into dataset JSON files.
- Does not auto-publish candidates into Telegram threads.

Key `.env` settings:

```dotenv
DATASET_COLLECTORS_ENABLED=true
DATASET_COLLECTOR_INTERVAL_MINUTES=180
DATASET_COLLECTOR_SOURCE_LIMIT=20

# Format: dataset|tier|name|url|k=v,k=v;...
DATASET_SOURCE_CONFIG=facts|rss|StarWars News Feed Facts|https://www.starwars.com/news/feed|locale=en;quotes|scrape|StarWars Quote Sources|https://www.starwars.com/news|locale=en,parser=starwars_news_quotes;trivia|scrape|StarWars Databank Trivia|https://www.starwars.com/databank|locale=en,parser=starwars_databank;polls|rss|StarWars News Poll Prompts|https://www.starwars.com/news/feed|locale=en;discussions|rss|StarWars News Discussion Prompts|https://www.starwars.com/news/feed|locale=en
```

Admin UI additions:

- `Dataset Candidates` tab with dataset/status filters.
- `Run Dataset Collectors Now` one-click ingest trigger.
- Multi-select controls for bulk candidate processing.
- `Approve` action: appends normalized candidate into `data/*.json` target dataset.
- `Reject` action: marks candidate rejected without file changes.
- `Bulk Approve` and `Bulk Reject` process selected rows in one action.

Admin commands:

- `/dataset_ingest_now` run one-shot dataset collection now.
- `/dataset_candidates [dataset] [limit]` preview latest candidate queue items.

Admin API:

- `POST /admin/api/dataset-ingest-now`
- `GET /admin/api/dataset-candidates?dataset=facts&status=candidate&limit=40&offset=0`
- `POST /admin/api/dataset-candidates/<id>/approve`
- `POST /admin/api/dataset-candidates/<id>/reject`
- `POST /admin/api/dataset-candidates/bulk-approve` with body `{ "ids": [1,2,3] }`
- `POST /admin/api/dataset-candidates/bulk-reject` with body `{ "ids": [1,2,3] }`

## Admin Dashboard Telemetry

Dashboard now includes:

- LLM actions over last 24h (sent/skipped/error)
- Top LLM skip reasons
- Reddit cache stats over last 24h (cached, relayed, queued, by content type)
- Interactive telemetry filters (time window + ingestion scope) and subreddit distribution chart

## Seasonal and Holiday Greetings

The bot now posts a daily greeting in the general thread for special dates:

- May the 4th (Star Wars Day)
- Fridays (Happy Friday / TGI Friday variants)
- Hong Kong public holidays listed in `HK_PUBLIC_HOLIDAYS`

Configure schedule and behavior in `.env`:

```dotenv
GREETING_ENABLED=true
GREETING_UTC_HOUR=1
GREETING_UTC_MINUTE=30
HK_PUBLIC_HOLIDAYS=2026-01-01,2026-07-01
```

Notes:

- Greeting posting is deduplicated per date/kind, so restarts do not repost the same greeting.
- May the 4th has highest priority over Friday/holiday greetings.

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
	- Optional routing keys: `THREAD_MOVIE`, `THREAD_SHOW` for movie/show fact routing.
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

- `EVENT_INGEST_HOURS` scheduler frequency in hours (set to `12` for twice-daily crawling/scraping)
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

## Event Crawl/Scrape Audits

Migration `000004_event_audit_veracity` adds:

- `event_crawl_audit`: audit rows for official/rss/api source runs
- `event_scrape_audit`: audit rows for scrape source runs
- `events.source_veracity`: source trust tag (`confirmed` or `rumor`)

Each audit row stores source/tier, parser strategy, fetched/saved counts, extraction health, ratio, status, and error text for deeper monitoring.
