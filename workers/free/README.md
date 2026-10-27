# Cloudflare Telegram host

This is the live **sw-bot-test** Worker serving **Star Wars Test**. Its webhook is
`https://sw-bot-test.yaser3808.workers.dev/telegram`; `/healthz` reports the deployed
version. The Python bot at the repository root is a separate, older deployment.
The previously dashboard-only Worker was recovered on 2026-10-27, including its
quiz, rewards, privacy controls and durable Telegram delivery queue.

## Behavior

- Five baseline starters per Hong Kong day, with a persisted random plan between
  10:00 and 23:00. The target rises to seven or ten as recent participation grows.
  Baseline spacing is two hours, moderate engagement 90 minutes, strong engagement
  60 minutes. All starter reservations, including requested posts, share a hard
  ten-per-day ceiling. Poll follow-ups and conversational replies are separate.
- Adaptive signals look back four hours: distinct participating members, meaningful
  group messages, replies/mentions of the bot, quiz answers and actual closed-poll
  votes. At most one signal per member per five minutes counts (one point for chat,
  two for bot replies/quiz participation). Poll votes add up to ten points; the
  largest single-poll voter count also supplies a distinct-participant lower bound.
  Two participants and eight points unlock seven starters; three participants and
  twenty points unlock ten. Commands, DMs, bots and opted-out members do not boost
  the message score. Anonymous poll totals remain aggregate, without voter IDs.
- As signals age out, extra slots are cancelled, including queued retries. Unsent
  baseline slots are recovered one at a time with normal spacing, never in a burst.
  Five is the daily baseline target, not permission to override quiet hours, pauses,
  continuously busy topics or delivery failures. `/status` shows current count,
  target, spacing, participant count and score. Metadata expires after two days;
  `/forget` erases member-linked signals.
- Scheduled posts wait for ten quiet minutes in their destination topic. Busy slots
  retry every five minutes for up to one hour, then expire instead of interrupting
  a conversation. Ambient replies stop after four messages in ten minutes.
  Activity records contain only update ID, topic ID and timestamp, retained 24h.
- The first daily slot is a two-minute character-guess or quote quiz; Monday is
  weekly trivia. These replace an existing slot, preserving daily caps. Curated
  questions rotate before repeating; they do not disappear when a pool is exhausted.
  Members can also request `/guess`, `/quote`, `/weeklytrivia` (shared post cap).
- The worker closes community polls on the first cron after ten minutes, capturing final totals directly. Their actual final vote totals produce
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
  or `/post game` (one per minute, five explicit requests per day, subject to the ten-starter total cap).
- `/privacy`, `/optout`, `/optin` and `/forget` are retained. Conversation text
  expires after 24h; autonomous post history after 30 days. Group excerpts for the cantina briefing are retained for 24 hours; private
  messages never enter recaps. Ambiguous Telegram delivery is recorded for inspection
  rather than blindly retried; Telegram 429 responses use the stored payload.

## Additional topic bindings

Send each command inside its corresponding existing Telegram topic:

| Topic | Command | Automatic content |
| --- | --- | --- |
| Hong Kong / local events | `/bindtopic hongkong` | Hypothetical meetup ideas and local fan discussions |
| Global events | `/bindtopic global_events` | Fan-event wishlists and international community discussions |
| TV shows | `/bindtopic tv` | Spoiler-free show discussions and creative prompts |
| Memes | `/bindtopic memes` | Original text jokes and caption challenges |
| Wallpapers | `/bindtopic wallpapers` | Wallpaper design concepts/prompts and sharing discussions |

Aliases include `hong_kong`, `hk`, `local_events`, `tv_shows`, `television`,
`meme` and `wallpaper`. Names with spaces work too. The existing Gaming, Movies
and Lore bindings continue to work. `/topics` shows the canonical names and IDs.

Bound content categories join the existing 5–10 starter rotation; the daily cap
is shared across all topics. Categories rotate by last post/attempt so a new topic
can enter today's schedule and a failed category cannot monopolise it. Recurring
games retain the first scheduled slot. Unbound extra categories are excluded from
automatic rotation; explicit `/post tv`, `/post memes`, `/post wallpapers`,
`/post hongkong` or `/post global_events` uses the normal default if not mapped.

These event categories currently use curated planning prompts, **not live event
listings or news feeds**. Memes are text; wallpaper posts are concepts, **not
image attachments**. Adding live listings or image generation is separate work.

Admins can also `/bindtopic collectibles` (or another name up to 40 characters).
Custom names are stored and displayed as mapped-only; they do not automatically
create a new content generator. Matching topic service messages use the same
normalisation. Binding is admin-only and must happen in the group, not a DM.

## Test and deploy

Tests use Node 24's SQLite with real SQL, a mocked Telegram transport and mocked AI:

```sh
node --test workers/free/tests/*.test.mjs
```

From this directory, with Wrangler authenticated to the existing account:

```sh
npx wrangler d1 execute sw-bot-test --remote --file migrations/0002_engagement.sql
npx wrangler d1 execute sw-bot-test --remote --file migrations/0003_community.sql
npx wrangler d1 execute sw-bot-test --remote --file migrations/0004_cantina.sql
npx wrangler deploy
```

For a fresh database, apply `schema.sql` before the additive migrations. Do not
point a fresh deployment at the existing webhook without configuring it first.

The live bindings are `DB` (D1), `AI` (Workers AI), `BOT_TOKEN` and
`WEBHOOK_SECRET` (secrets), plus these variables:

- `GROUP_ID`, `BOT_USERNAME`, `ADMIN_USER_IDS`, `ALLOWED_THREAD_IDS`
- `AI_MODEL` = `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- `AI_DAILY_CAP` = `60` (reply budget; ten additional proactive generations/day,
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
The `settings` table holds `adaptive-plan:YYYY-MM-DD`, the latest `posting_policy`, source snapshots, diagnostic results
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
This supports vote updates and externally stopped polls. The worker calls stopPoll to capture final totals; it does not depend on Telegram emitting an automatic-close update. Confirm
`settings.diagnostics.getWebhookInfo.allowed_updates` includes `poll`.

Rollback using the previous Worker version in Cloudflare. The additive table and
indexes can remain in place; the old Worker ignores them. No Python service or
Telegram polling process is needed for this deployment.

## Cantina community and admin features

Apply `migrations/0004_cantina.sql` before deploying this version, then enqueue
`{"internal_configure":true}` to enable Telegram `message_reaction` updates.
The bot needs to remain a group administrator to see group messages/reactions.
Its existing delete/restrict permissions determine which approved moderation
operations Telegram will accept. No action is taken just because a heuristic flags
something; current Telegram administrators and configured admins are protected.

### Daily briefings and conversation hosting

- Daily briefing at 21:00 Hong Kong time, deferred during active conversation until
  23:00. `/briefing` requests one (two per member/day). It includes sourced discussion
  summaries, questions with no recorded reply, actual closed-poll results and
  admin-confirmed future activities. Source links use the Telegram group/topic IDs.
- Up to 1,500 non-command group excerpts/day, each at most 600 characters, are
  retained for 24 hours. Private conversations never enter recaps. The privacy
  command and onboarding explain this retention; opt-out removes stored excerpts.
- One hosting nudge per day at most, after two hours without a recorded reply.
  Positive reactions from at least two other members can qualify a suggestion.
  The same author gets at most one nudge/week. `/prompts off` disables their nudges;
  replying `/resolved` to their question marks it resolved. The bot's own replies
  count as recorded answers. Missing replies are not proof that a question is
  unresolved; prompts and briefings say "no recorded reply" explicitly.

### Events and opt-in reminders

- `/event plan Watch party` creates a non-anonymous weekend availability poll in
  the Hong Kong topic (or the configured fallback). A group message asking
  "anyone free this weekend?" can start the same flow. Two proposals/member/day.
  Date votes are availability preferences, not RSVPs or automatic confirmation.
- `/event create Watch party|2026-11-07 18:00|Community room|hongkong|https://source`
  saves a draft. Times are parsed strictly as Hong Kong time; the source URL is
  optional. No URL is fetched or treated as independently verified.
- `/event show ID` shows dates, availability votes, RSVP totals and supplied source.
  `/event list` shows activities. An admin explicitly confirms details with
  `/event confirm ID` or `/event confirm ID | YYYY-MM-DD HH:mm | Location | URL`.
  "Admin-confirmed" means that admin checked the details, not independent bot
  verification. Only confirmed activities enter briefings and announcements.
- `/rsvp ID yes remind` opts into a group reminder about 30 minutes beforehand.
  `/rsvp ID yes silent`, `maybe`, or `no` disables reminders. Reminders never go to
  DMs; up to 30 opted-in attendees are mentioned in the group. Opt-out and event
  cancellation are rechecked before every delivery/retry. `/event cancel ID`
  is admin-only. A quiet/paused bot may miss a reminder; late reminders are skipped.

### Rules, memory, onboarding and controls

- `/remember rule|Title|Details` proposes an entry; kinds are `rule`, `faq`,
  `recommendation`, `decision`. `/memory show ID` lets admins inspect the full
  proposal and its source before `/approve memory ID` or `/dismiss memory ID`.
  Unapproved entries never enter AI answers. `/memory remove ID` retracts an entry.
- `/rules` and `/memory watch party` retrieve approved entries. Relevant approved
  entries and source links also inform normal answers. Shared approved memory is
  retained until removed; it does not silently infer personal preferences.
- Real `new_chat_members` updates trigger a welcome with topics, approved rules,
  privacy information and optional `/preferences on`, `/era`, `/spoilers`, and
  `/interests gaming,movies,lore`. `/preferences off` deletes interests too.
- `/pending` shows possible moderation issues, pending memory and event drafts.
  `/settings` shows topic configuration, schedules, pending jobs and posting policy.
  `/quiet 60` suppresses automatic participation temporarily; `/quiet off` ends it.
  Direct commands remain usable. `/pause` retains its broader stop behavior.
- All responses, including admin reports requested privately, remain public in the
  configured group. `/pending` is admin-only but **not an admin-private inbox**.

### Moderation review

Bounded heuristics flag link-heavy/repeated promotion, certain abusive phrases and
possible unhidden spoilers. They are suggestions requiring context, not findings.
`/pending` includes reasons, original-message links and suggested actions.
`/approve ID delete`, `/approve ID mute` (one hour) or `/approve ID ban` explicitly
authorizes that exact action; `/dismiss ID` rejects a pending flag. Only configured
admins may approve. The bot rechecks the target's Telegram administrator status
before execution, records the action/result, and never automatically repeats an
ambiguous delivery. Tests exercise deletion/restriction/ban transports with mocks;
no real member is moderated merely to test the feature.

### Games with continuity

- Mondays 19:00 HKT: three-round team trivia; Wednesdays: progressive character
  clues; Fridays: a 24-hour caption contest. Scheduled starts wait for quiet.
  These sessions, round updates, briefing, reminders and hosting nudges are separate
  from the 5–10 general starter budget. `/game trivia|character|caption` requests a
  session (two per member/day); an existing open session is reused.
- `/team rebels|empire|scoundrels` explicitly joins a team; `/team off` leaves.
  Trivia awards 3 points for the first correct answer or 1 for participation.
  Subsequent answer changes do not earn additional points. Team membership at
  award time is retained with the score; changing teams does not move old points.
- `/answer ID Character` solves a progressive clue game; the first solver gets 5
  points. Unsolved games reveal the answer. Solved games stop issuing clues.
- `/caption ID Original caption` submits one entry (12 entries/contest maximum).
  `/game show ID` lists entries, then `/vote ID <entry number>` casts one peer vote.
  Self-votes are rejected. An entry earns 1 point, each peer vote 1 point, and the
  winner(s), including ties, receive 5 bonus points. No votes means no winner.
- `/season` shows individual/team scores for the Hong Kong calendar month. Rewards
  are capped at 20 points/member per rolling 24 hours. Ordinary message volume no
  longer earns participation XP; the legacy `/rank` history remains available.

### Retention and operations

`club_jobs` contains durable one-effect jobs; negative queue IDs map to those jobs.
Stored approvals are distinct from executable actions. Event/reminder cancellation,
opt-outs, pause/quiet controls and moderator protections are rechecked on retries.
Uncertain operations are recorded for inspection and not retried automatically.

Discussion excerpts/reactions expire in 24h, events/attendance and game content in
30 days, moderation reviews in 30 days, and seasonal points in 120 days. Preferences
and team membership persist until removed. `/forget` deletes personal preferences,
attendance, scores, entries, votes, controls, pending proposals and review records.
Confirmed public activities remain community records with the member linkage
removed; approved shared memory remains until an admin removes it. Telegram posts
and data already processed by the AI provider cannot be recalled by `/forget`.
