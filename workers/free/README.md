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
- Scheduled posts wait for ten quiet minutes in their destination topic. Busy slots
  retry every five minutes for up to one hour, then expire instead of interrupting
  a conversation. Ambient replies stop after four messages in ten minutes.
  Activity records contain only update ID, topic ID and timestamp, retained 24h.
- The first daily slot is a two-minute character-guess or quote quiz; Monday is
  weekly trivia. These replace an existing slot, preserving daily caps. Curated
  questions rotate before repeating; they do not disappear when a pool is exhausted.
  Members can also request `/guess`, `/quote`, `/weeklytrivia` (shared post cap).
- Community polls close after ten minutes. Their actual final vote totals produce
  one follow-up in the original topic, discussing the winner and inviting a
  counterargument. Ties and zero votes are explicit. Follow-ups wait for quiet and
  active hours for at most 24h, then expire. They are separate from starter slots.
  If Telegram cannot provide final totals, the bot does not guess.
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
- `/preferences on` explicitly opts into saved preferences; `/era prequels`
  (or `any`, `original`, `sequels`, `high-republic`, `old-republic`, `legends`)
  and `/spoilers avoid|allow` update them. Preferences are not inferred silently.
  `/preferences off` and `/forget` delete them. Public replies stay spoiler-free
  unless the requester allows spoilers and no saved preference says avoid; even
  then spoilers require an explicit request. Autonomous posts remain spoiler-free.
- The cantina-droid personality favors specific opinions, gentle wit, concise
  answers and honest uncertainty. It has recurring tastes with concrete reasons,
  and can make playful callbacks to actual recent conversation. It mirrors the
  member's language.
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
npx wrangler d1 execute sw-bot-test --remote --file migrations/0003_community.sql
npx wrangler deploy
```

For a fresh database, apply `schema.sql` before both additive migrations. Do not
point a fresh deployment at the existing webhook without configuring it first.

The live bindings are `DB` (D1), `AI` (Workers AI), `BOT_TOKEN` and
`WEBHOOK_SECRET` (secrets), plus these variables:

- `GROUP_ID`, `BOT_USERNAME`, `ADMIN_USER_IDS`, `ALLOWED_THREAD_IDS`
- `AI_MODEL` = `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- `AI_DAILY_CAP` = `60` (reply budget; five additional proactive generations/day,
  plus one generation per voted poll follow-up)
- `PROACTIVE_ENABLED` = `true`; set `false` to stop proactive posts
- Optional `PROACTIVE_THREAD_ID` (defaults to first allowlisted topic or General)
- Optional `PRIVATE_THREAD_ID` for private-request output; defaults to
  `PROACTIVE_THREAD_ID`, then the first allowlisted topic, then General. A value
  outside the topic allowlist fails closed. The live deployment currently uses
  General until a named map is configured. Ordinary group replies preserve the
  incoming topic. Scheduled gaming content uses Gaming, film cards use Movies,
  and debates/games use Lore. Admins bind existing topics with `/bindtopic gaming`,
  `/bindtopic movies`, `/bindtopic lore` inside each topic. `/topics` shows the map.
  Matching topic creation/rename service messages are learned automatically.
  Telegram has no Bot API endpoint to enumerate existing topics, so unmapped
  categories fall back to the configured default; IDs are never guessed.
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

After deploying this version, an operator can enqueue `{"internal_configure":true}`
using the same internal queue. It preserves the existing webhook URL and secret,
subscribes to `message`, `poll`, and `poll_answer`, and keeps pending updates.
This is needed for final poll totals after Telegram's automatic closure. Confirm
`settings.diagnostics.getWebhookInfo.allowed_updates` includes `poll`.

Rollback using the previous Worker version in Cloudflare. The additive table and
indexes can remain in place; the old Worker ignores them. No Python service or
Telegram polling process is needed for this deployment.
