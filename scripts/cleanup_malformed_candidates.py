import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import db
from handlers import dataset_collectors


def main():
    parser = argparse.ArgumentParser(description="Mark malformed dataset candidates as rejected")
    parser.add_argument("--apply", action="store_true", help="Apply changes (default is dry-run)")
    parser.add_argument("--limit", type=int, default=5000, help="Maximum candidate rows to scan")
    args = parser.parse_args()

    db.init_db()
    summary = dataset_collectors.cleanup_malformed_candidates(
        dry_run=not args.apply,
        limit=args.limit,
    )
    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
