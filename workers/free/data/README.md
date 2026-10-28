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

## Poll batch

`star-wars-polls-2026-10-28.json` preserves the owner's `pasted-text-2.txt`
attachment byte-for-byte: 128 unique community polls. These belong in
**Posts & schedule** as native poll drafts, separate from the 211 reference
knowledge entries. Import never approves, schedules or publishes them.

Apply `migrations/0008_imported_polls.sql` once before import. It adds an immutable
import fingerprint and original metadata to `admin_posts`; it does not alter
existing post content or states. Generate the parameterized import request:

```sh
node workers/free/scripts/poll-import.mjs \
  workers/free/data/star-wars-polls-2026-10-28.json \
  -1004441702993 test 1678078373 > /tmp/sw-polls-query.json
```

The identity guard prevents importing into a mismatched group/environment.
Fingerprints make repeat imports safe even after an admin edits, approves or
cancels a draft. Original question, options, category, source and topic tags are
retained in `import_metadata`; portal cards display the original dataset details.
Edits affect the draft, not the retained original metadata.

Game polls route to Gaming; film-specific and watch-party/rewatch/music/scene
polls to Movies. Series and meme polls prefer TV/Memes when bound and otherwise
fall back to Lore, then General. Always review the displayed destination before
approval. All 128 test inserts matched their originals on read-back (IDs 6–133):
30 Movies, 93 Lore and 5 Gaming. The previous 211 knowledge records remain intact.

Posts now support pagination and filtering across the full library; overview
counts cover every page. Import required migration 0008 only on the test database;
production remains untouched and disabled. No live poll was published for this
import. Fixture checks exercise approval and native poll delivery.

Verification: 299 tests pass; desktop/mobile browser pagination, filtering and
fixture approval/publication pass without page errors. Test release
`poll-library-2026-10-28`, deployment `e70a925b53504361aa69c502ba136c4b`,
reports healthy/configured. Secret scan passed.

## Trivia batch

`star-wars-trivia-2026-10-28.json` contains the owner's original 10 questions,
unchanged, followed by 100 additional questions. Every entry has four options
and a **zero-based** `correct` index (0–3). The accompanying `.sources.json`
records answer evidence; new entries also include the official source URL in
`source.url`. Some questions reveal plot details; review them for the intended
audience before approval. Legends questions are labelled separately.

The poll importer also accepts `*_trivia` categories and creates native **quiz**
drafts, retaining the answer index in both `correct` and original import metadata.
It rejects missing/out-of-range answers and answer keys on opinion polls.
Existing opinion-poll fingerprints remain unchanged.

```sh
node workers/free/scripts/poll-import.mjs \
  workers/free/data/star-wars-trivia-2026-10-28.json \
  -1004441702993 test 1678078373 > /tmp/sw-trivia-query.json
```

These entries appear under **Posts & schedule** in the test portal. Film trivia
routes to Movies, lore to Lore, games to Gaming, and series to TV when bound
(otherwise Lore). Import never approves, schedules or publishes. After approval,
the existing publisher sends a Telegram quiz with the retained answer index.
This data import requires migration 0008 already used by the poll batch; no new
migration or Worker deployment is needed. Production remains disabled.

Verified test import: 110 exact read-back matches, IDs 134–243, all unapproved
and unscheduled drafts (55 Movies, 39 Lore, 16 Gaming). The library now has
238 imported drafts (128 polls + 110 quizzes); 211 knowledge entries are intact.
All 302 tests pass, including native quiz payloads, answer validation, repeat
import protection and compatibility with existing poll fingerprints. Secret
scan passed. None of these quizzes were published during the import.

## Topic content and editorial review

`star-wars-topic-content-2026-10-28.json` adds 24 posts: six each for wallpapers,
memes, global events and Hong Kong events. Wallpapers include official gallery
links and explicitly labelled design concepts; memes are original text jokes,
caption prompts and a poll. Twelve event posts retain official organiser links,
verification notes, and Hong Kong/local timezone information. No image attachment
or unannounced Star Wars programme is claimed. Event publication expires after
seven days from verification or the event cutoff, whichever comes first.

```sh
node workers/free/scripts/topic-content-import.mjs \
  workers/free/data/star-wars-topic-content-2026-10-28.json \
  -1004441702993 test 1678078373 > /tmp/sw-topic-query.json
```

Import creates drafts only. `required_topic` in original metadata makes the
destination explicit. Missing topic bindings block publishing rather than falling
back to General. Publishing resolves the current binding; a later mapping change
revokes approval and returns the post to draft. Delivery checks expiry again and
marks stale event content expired. Create a newly verified draft when renewing
an event; original source metadata remains immutable.

At the owner's explicit request, `star-wars-library-review-2026-10-28.json`
records accuracy/quality decisions on all 238 previously imported polls/quizzes:
227 approved and 11 rejected (cancelled in the portal), with reasons and proposed
corrections. The 63 approved entries identified as potentially spoilery gained
`[Spoilers]` warnings in their editable post text. These labels do not hide poll
questions/options; admins must still choose an appropriate audience. Source
datasets and original import metadata were preserved. Changed wording increments
the revision and the resulting revision is approved. Every live mutation checked
the original content, revision and test identity; review actions are audited.

All 24 new posts passed review and exact database read-back (IDs 244–267) and were
approved. Test now contains 251 approved imported posts and 11 rejected imported
posts; no imported post was scheduled or published by this review. Existing
published/test-cancelled posts and 211 knowledge records were retained. The four
new topic bindings remain required before their posts can publish. Production
uses a separate disabled Worker and empty paused database; test approvals and
topic IDs are not transferred automatically.

## Approved live-group rules

`starwarshk-approved-rules-2026-10-28.json` records the eight rules approved by
the owner for production group `-1002432071241`: respectful discussion, spoiler
protection, topic use, spam/scam prevention, creator credits, reliable events,
privacy and human-led moderation. They were imported as approved `rule` records
with exact read-back verification (production IDs 1–8). This approval does not
transfer any test conversations, preferences, posts or schedules.
