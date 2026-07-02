"""Compatibility wrapper.

Use `scripts/db/migrate_sqlite_to_postgres.py` as the canonical path.
"""

from scripts.db.migrate_sqlite_to_postgres import main


if __name__ == "__main__":
    main()
