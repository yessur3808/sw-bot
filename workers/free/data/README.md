# Supplied reference knowledge

`star-wars-reference-2026-10-28.json` preserves the 85 entries supplied by the
owner on 28 October 2026, including the original category, source title/type,
text and topic array. These are user-supplied observations and interpretations,
not independently verified source citations. Some contain plot spoilers. The
original source attributions are retained rather than silently corrected.

The import uses the existing `club_memory` store. Categories become `kind`;
readable bodies retain source metadata and topics, with a provenance/spoiler
notice. The owner requested this batch be added, so it is approved reference
knowledge. It is not a batch of approved Telegram posts and contains no rules.

Generate a parameterized D1 API query (this command does not connect or write):

```sh
node workers/free/scripts/reference-import.mjs \
  workers/free/data/star-wars-reference-2026-10-28.json \
  -1004441702993 test 1678078373 approved > /tmp/sw-reference-query.json
```

Execute the resulting `{sql, params}` only against the intended D1 database.
The SQL checks the configured group/environment identity before inserting.
Verify the inserted count and read back the rows. Repeating the same batch skips
existing entries, including entries an admin has subsequently removed; it does
not alter approval state. Use `pending` for future batches awaiting approval.

Imported knowledge is visible in the portal's **Group knowledge**, retrievable
via `/memory <query>`, and available to relevant AI replies. Existing retrieval
considers the latest 100 approved records and returns up to five matches. This
batch does not change proactive templates, train the model, publish messages or
enable production. Group spoiler preferences still govern AI replies; direct
knowledge lookup displays reference text, which can contain spoilers.

Verified test import: 85 rows inserted, IDs 1–85, with exact read-back matches
for title, body, category, approval and empty Telegram source linkage. Category
counts: 57 lore, 12 movie, 7 TV, 4 Legends, 4 game and 1 comic. No Worker
redeployment or database schema migration was needed.
