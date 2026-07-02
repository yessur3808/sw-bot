"""Simple up/down schema migration runner for sqlite and postgres.

Usage:
  python3 scripts/db/migrate_schema.py up
  python3 scripts/db/migrate_schema.py down

Config via env:
  DB_BACKEND=sqlite|postgres
  DB_PATH=starwars.db
  DATABASE_URL=postgresql://...
"""

import os
import sqlite3
import sys
from pathlib import Path

try:
    import psycopg
except Exception:  # pragma: no cover
    psycopg = None


ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = ROOT / "migrations"
DB_BACKEND = os.getenv("DB_BACKEND", "sqlite").strip().lower()
DB_PATH = os.getenv("DB_PATH", str(ROOT / "starwars.db")).strip()
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()


def _is_postgres():
    return DB_BACKEND in ("postgres", "postgresql")


def _connect():
    if _is_postgres():
        if psycopg is None:
            raise RuntimeError("psycopg is required for postgres backend")
        if not DATABASE_URL:
            raise RuntimeError("DATABASE_URL is required for postgres backend")
        return psycopg.connect(DATABASE_URL)

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _create_migration_table(conn):
    if _is_postgres():
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version TEXT PRIMARY KEY,
                applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    else:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version TEXT PRIMARY KEY,
                applied_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
            """
        )


def _applied_versions(conn):
    rows = conn.execute("SELECT version FROM schema_migrations ORDER BY version").fetchall()
    versions = []
    for row in rows:
        if hasattr(row, "keys"):
            versions.append(row["version"])
        else:
            versions.append(row[0])
    return set(versions)


def _migration_files(direction):
    suffix = "postgres" if _is_postgres() else "sqlite"
    pattern = f"*.{suffix}.{direction}.sql"
    return sorted(MIGRATIONS_DIR.glob(pattern))


def migrate_up(conn):
    _create_migration_table(conn)
    applied = _applied_versions(conn)
    files = _migration_files("up")

    applied_now = 0
    for file_path in files:
        version = file_path.name.split(".")[0]
        if version in applied:
            continue

        sql = file_path.read_text(encoding="utf-8")
        if _is_postgres():
            conn.execute(sql)
        else:
            conn.executescript(sql)

        conn.execute("INSERT INTO schema_migrations(version) VALUES (%s)" if _is_postgres() else "INSERT INTO schema_migrations(version) VALUES (?)", (version,))
        applied_now += 1
        print(f"Applied migration: {file_path.name}")

    return applied_now


def migrate_down(conn):
    _create_migration_table(conn)
    rows = conn.execute(
        "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1"
    ).fetchall()
    if not rows:
        print("No applied migrations found.")
        return 0

    row = rows[0]
    version = row["version"] if hasattr(row, "keys") else row[0]
    suffix = "postgres" if _is_postgres() else "sqlite"
    file_path = MIGRATIONS_DIR / f"{version}_init_schema.{suffix}.down.sql"

    # Fallback for custom naming patterns: match by version prefix.
    if not file_path.exists():
        matches = sorted(MIGRATIONS_DIR.glob(f"{version}*.{suffix}.down.sql"))
        if not matches:
            raise RuntimeError(f"Down migration file not found for version {version}")
        file_path = matches[0]

    sql = file_path.read_text(encoding="utf-8")
    if _is_postgres():
        conn.execute(sql)
    else:
        conn.executescript(sql)

    conn.execute(
        "DELETE FROM schema_migrations WHERE version=%s" if _is_postgres() else "DELETE FROM schema_migrations WHERE version=?",
        (version,),
    )
    print(f"Rolled back migration: {file_path.name}")
    return 1


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("up", "down"):
        print("Usage: python3 scripts/db/migrate_schema.py [up|down]")
        raise SystemExit(1)

    action = sys.argv[1]
    conn = _connect()
    try:
        if action == "up":
            count = migrate_up(conn)
            conn.commit()
            print(f"Migrations applied: {count}")
        else:
            count = migrate_down(conn)
            conn.commit()
            print(f"Migrations rolled back: {count}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
