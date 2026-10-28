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
via `/memory <query>`, and available to relevant AI replies. Retrieval
ranks all approved records and returns up to five matches. The portal shows
100 entries per page with Previous/Next controls. This
batch does not change proactive templates, train the model, publish messages or
enable production. Group spoiler preferences still govern AI replies; direct
knowledge lookup displays reference text, which can contain spoilers.

Verified test import: 85 rows inserted, IDs 1–85, with exact read-back matches
for title, body, category, approval and empty Telegram source linkage. Category
counts: 57 lore, 12 movie, 7 TV, 4 Legends, 4 game and 1 comic. No Worker
redeployment or database schema migration was needed.


## Quote batch

`star-wars-quotes-2026-10-28.json` is a byte-for-byte copy of the owner attachment
`pasted-text.txt`: 126 unique quotes (112 movie, 14 TV series), each retaining its
speaker, source, category and topics. Import accepts both the original `text`
format and the `quote`/`speaker` format; ambiguous mixtures are rejected. The
same identity guard, explicit approval and duplicate/removal protections apply.
The source attributions have not been independently fact-checked.

Use the same command above with the quote filename. The helper now accepts up to
1,000 entries per request. This batch brings test knowledge to 211 entries. The
retrieval/pagination release prevents newly imported records from hiding older
knowledge; it does not publish posts or change automatic-posting policy.

Test verification: 126 inserts and 126 exact read-back matches, 211 total records;
295 tests passed. Desktop/mobile pagination reached all three pages. Live D1
retrieval found both an older Ben Burtt reference and the new General Dodonna
quote. Test release `knowledge-quotes-2026-10-28`, deployment
`253cd2927e504dd5b5ce44c659a6a0b0`, reports healthy/configured. Production
knowledge remains empty, paused and unassigned.
