# Cloudflare Telegram host

This is the live **sw-bot-test** Worker serving **Star Wars Test**. Its webhook is
`https://sw-bot-test.yaser3808.workers.dev/telegram`; `/healthz` reports the deployed
version. The Python bot at the repository root is a separate, older deployment.
The previously dashboard-only Worker was recovered on 2026-10-27, including its
quiz, rewards, privacy controls and durable Telegram delivery queue.

## Behavior

- A persisted random daily plan selects 3–5 different post categories between
  10:00 and 23:00 Hong Kong time, at least two hours apart. Missed slots are skipped,
  not replayed in a burst. Replies and explicitly requested posts are separate
  from scheduled slots; requested posts share the five-post safety cap.
- Questions, polls and creative prompts use Workers AI, with curated fallbacks.
  Recent seeds and texts prevent repeats. The bot sends native Telegram polls.
- Movie/game release cards use dated official sources, with links. The Starfighter
  page is rechecked daily. Development announcements with no announced date are
  labeled accordingly. Source snapshots expire after 30 days and past releases
  are excluded. Add newly verified announcements to `RELEASES` as needed; this is
  a bounded source list, not a general news crawler.
- Configured admins can message the bot privately in plain text or use commands.
  Every resulting response, poll and quiz is published to the group; nothing is
  sent back to a private chat. Private message IDs are never used as group reply
  targets. `/whereami` shows the configured destination and current topic.
- Private request history stays in its private conversation scope; only published
  answers enter shared group history. Private access remains admin-only.
- Mentions, `/ask`, and replies to the bot receive contextual answers. Up to ten
  recent messages from bot conversations in the same chat/topic inform responses.
- Relevant ordinary messages have a stable 12% chance of receiving a reply, with
  a 15-minute topic cooldown and six ambient replies per UTC day. The bot must be
  a group admin or have BotFather privacy disabled to receive those messages.
- The cantina-droid personality favors specific opinions, gentle wit, concise
  answers and honest uncertainty. It mirrors the member's language.
- `/pause` and `/resume` control participation. `/status` describes active limits.
  Admins can request `/post question`, `/post poll`, `/post idea`, `/post movie`,
  or `/post game` (one per minute, five per day, subject to total post cap).
- `/privacy`, `/optout`, `/optin` and `/forget` are retained. Conversation text
  expires after 24h; autonomous post history after 30 days. Nonselected ordinary
  messages are not stored. Ambiguous Telegram delivery is recorded for inspection
  rather than blindly retried; Telegram 429 responses use the stored payload.

## Test and deploy

Tests use Node 24's SQLite with real SQL, a mocked Telegram transport and mocked AI:

```sh
node --test workers/free/tests/*.test.mjs
```

From this directory, with Wrangler authenticated to the existing account:

```sh
npx wrangler d1 execute sw-bot-test --remote --file migrations/0002_engagement.sql
npx wrangler deploy
```

For a fresh database, apply `schema.sql` before the engagement migration. Do not
point a fresh deployment at the existing webhook without configuring it first.

The live bindings are `DB` (D1), `AI` (Workers AI), `BOT_TOKEN` and
`WEBHOOK_SECRET` (secrets), plus these variables:

- `GROUP_ID`, `BOT_USERNAME`, `ADMIN_USER_IDS`, `ALLOWED_THREAD_IDS`
- `AI_MODEL` = `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- `AI_DAILY_CAP` = `60` (reply budget; five additional proactive generations/day)
- `PROACTIVE_ENABLED` = `true`; set `false` to stop proactive posts
- Optional `PROACTIVE_THREAD_ID` (defaults to first allowlisted topic or General)
- Optional `PRIVATE_THREAD_ID` for private-request output; defaults to
  `PROACTIVE_THREAD_ID`, then the first allowlisted topic, then General. A value
  outside the topic allowlist fails closed. The live deployment currently uses
  General and has no named topic-to-ID map. Ordinary group replies preserve the
  incoming topic.
- Optional `AMBIENT_ENABLED` = `false` to disable occasional replies
- Optional `AMBIENT_REPLY_CHANCE` (default `0.12`, capped at `0.4`)

`keep_vars` preserves dashboard-managed variables, and deployments preserve
existing secrets. See [Cloudflare configuration docs](https://developers.cloudflare.com/workers/wrangler/configuration/).
Do not use the old root `.env` token for this Worker.

## Operations

Cron runs each minute, maintaining the plan, draining the durable queue and
expiring old context. `engagement_posts` records content, generation mode, Telegram
message ID and delivery state. `updates` contains queued/error delivery states.
The `settings` table holds `plan:YYYY-MM-DD`, source snapshots, diagnostic results
and `last_delivery` (destination, method, Telegram message ID and timestamp; no
message text or credentials).

An operator with D1 access can enqueue `{"internal_diagnostics":true}` in an
`updates` row with a unique negative ID and `created_at=unixepoch()`. The next cron
checks bot identity, target group, webhook health, bot permissions and actual
Workers AI binding output. These internal jobs cannot be submitted via the public
webhook. Diagnostics never expose Telegram tokens or the webhook secret.

Rollback using the previous Worker version in Cloudflare. The additive table and
indexes can remain in place; the old Worker ignores them. No Python service or
Telegram polling process is needed for this deployment.
