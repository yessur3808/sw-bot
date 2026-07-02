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
