.PHONY: help build up up-postgres run down restart rebuild logs ps shell migrate migrate-local migrate-up migrate-down

PYTHON := /home/curlycoffee3808/Desktop/server/bots/starwars-bot/venv/bin/python
WITH_ENV := set -a; . ./.env; set +a

help:
	@echo "Targets:"
	@echo "  build         Build bot image"
	@echo "  up            Start bot in background"
	@echo "  up-postgres   Start bot + postgres profile in background"
	@echo "  run           Run bot in foreground"
	@echo "  down          Stop and remove containers"
	@echo "  restart       Restart bot container"
	@echo "  rebuild       Rebuild image and restart bot"
	@echo "  logs          Follow bot logs"
	@echo "  ps            Show compose services"
	@echo "  shell         Open shell in bot container"
	@echo "  migrate-up    Apply schema migrations for current DB backend"
	@echo "  migrate-down  Roll back latest schema migration"
	@echo "  migrate       Run sqlite->postgres data migration inside bot container"
	@echo "  migrate-local Run sqlite->postgres migration from host python"

build:
	docker compose build

up:
	docker compose up -d bot

up-postgres:
	docker compose --profile postgres up -d

run:
	docker compose up bot

down:
	docker compose down

restart:
	docker compose restart bot

rebuild:
	docker compose up -d --build bot

logs:
	docker compose logs -f bot

ps:
	docker compose ps

shell:
	docker compose exec bot sh

migrate:
	docker compose run --rm bot python scripts/db/migrate_sqlite_to_postgres.py

migrate-local:
	$(WITH_ENV); $(PYTHON) scripts/db/migrate_sqlite_to_postgres.py

migrate-up:
	$(WITH_ENV); $(PYTHON) scripts/db/migrate_schema.py up

migrate-down:
	$(WITH_ENV); $(PYTHON) scripts/db/migrate_schema.py down
