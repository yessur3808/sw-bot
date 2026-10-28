# Production-readiness audit — 28 October 2026

Status: **keep production disabled**. The reviewed fixes are deployed to test;
launch also requires approved rules, Telegram permissions and real-group setup.

## Reproduced issues and fixes

- A Telegram 429 followed by a failed database claim-release write could lose an
  approved portal post. Only a leased retry with a recorded definite rate-limit
  response can now recover its claim. Ambiguous sends remain ineligible for replay.
- An overdue scheduler snapshot could expire or cancel a newer approved revision.
  Those updates now check the selected revision, schedule and approver.
- Event/moderation approval could persist without its delivery job after an insert
  failure. Approval and conditional job insertion now share a transaction; stale
  approvals and duplicate jobs are rejected.
- A game-closing summary could name a player who withdrew during final queue
  preparation. Closing results exclude opted-out participants and are checked
  again before delivery; changed results defer and rebuild.
- Portal login/logout success is silent. Admin operational receipts are private,
  including retries; failed private delivery never falls back to the group.
  Approved moderation completion is recorded without a group status message.
- Games now use readable titles and short commands in the active topic or replies:
  `/answer Yoda`, `/caption My caption`, `/game show`, `/vote 1`. Legacy commands
  remain compatible. Caption bonuses use the confirmed result snapshot; scoring
  recovers after a bookkeeping failure without resending the closing message.
  `/forget` removes the retained winner reference.
- Deployment instructions omitted the portal migration. Both deployment and
  cutover instructions now require migration 0007.

## Verification

- Baseline: 157 tests. Expanded suite: 289 passing Node/SQLite tests, including
  database fault injection, stale revisions, concurrent approval/cancellation,
  lost responses, 429 recovery and final-delivery consent withdrawal.
- Isolated desktop/mobile browser flows: sign-in, literal text/XSS handling,
  drafting, approval, Hong Kong scheduling, edit revocation, publishing, knowledge
  approval, event creation/confirmation/RSVP details and posting-policy controls passed without page errors.
- Hosted browser: all portal sections loaded; native poll publication and quiz
  scheduling passed; mobile layout had no horizontal overflow.
- Live API rejected missing CSRF (403), invalid topics/options (400), and stale
  publication approval (409). Hosted AI generated a draft; that draft was edited
  and cancelled, never published.
- A real Telegram `session.approve` audit entry was observed on 28 October. The
  operator used a separate temporary session for this audit, not the member's
  browser session or a fabricated Telegram login.
- Telegram delivery evidence:
  - Lore poll: https://t.me/c/4441702993/6/131
  - Scheduled Movies quiz: https://t.me/c/4441702993/4/132
  - Gaming text: https://t.me/c/4441702993/128/133
  - Poll closed after ten minutes with zero real votes; its follow-up delivered
    without inventing a winner: https://t.me/c/4441702993/6/134
- The bot delivered five automatic starters during the current Hong Kong day,
  with at least two hours between them. Ten automated sends were reserved against
  the overall cap of twenty at the audit check. Automatic posting remains enabled.
- An isolated D1 drill verified `changes()` gating, duplicate suppression and
  rollback after an intentional unique-constraint failure. Its two temporary
  audit tables were removed. This agrees with Cloudflare's documented
  [batch transaction behavior](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
- No stranded approved moderation action or confirmed event lacking a job was
  found in the test database. One older failed update remains as historical
  evidence; it was not replayed or hidden.

## Test release

- Worker: `sw-bot-test`; portal: https://sw-bot-test.yaser3808.workers.dev/admin
- Version: `readiness-hardening-2026-10-28`
- Deployment: `12799b28c440402fb853b6f34c5cf91a`
- Clean character-game clue 1 delivered to Lore after this deployment:
  https://t.me/c/4441702993/6/135. Confirmed delivery advanced the game to step 0;
  subsequent clues retain normal spacing and stop if a member solves the game.
- Both temporary operator sessions were revoked/removed; the user session was
  untouched. The local fixture server was stopped.
- Post-deployment health reports configured/ok; authenticated readiness and
  settings APIs passed. Posting policy remains automatic.
- Final independent review found no material issues in the diff and reran all
  289 tests successfully. That review used local fixtures, not live Telegram.
- Gitleaks found no leaks in the tracked-file snapshot plus new tests.

## Remaining launch requirements

The fresh live readiness check after deployment at 14:06 UTC reports:

1. Add and approve the actual group rules.
2. Grant the bot Delete messages permission if approved deletion is required.

Gaming is now bound to topic 128; Movies is 4 and Lore is 6. These are **test-group
IDs** and must not be copied to the real group.

Production has no group identity, remains paused and is disabled in configuration.
Its empty database now includes migration 0007. The real numeric group ID, final
admin membership, real-group topic bindings and explicit cutover authorization are
still required. Follow `PRODUCTION.md`; do not activate merely because tests pass.

Live member voting, RSVP/reminder participation, opt-out/forget interaction, and
multi-turn conversation acceptance still need real volunteer inputs. Those paths
have fixture coverage; no member messages/votes or destructive moderation were
fabricated for this audit. T3 browser startup remains blocked by host AppArmor;
portal browser tests used an isolated Playwright fallback.
