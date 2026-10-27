# Moving SIU-M8 to the real group

## Prepared resources

- Existing Worker: `sw-bot-test`, serving `https://sw-bot-test.yaser3808.workers.dev`.
- Test database: `sw-bot-test` (`fc9c66e4-71bb-4e78-9d34-ec665fd313b4`).
- Separate production database: `sw-bot-production` (`dea947f5-8a8f-4e52-971f-31a07620af84`).
- Production configuration: `wrangler.production.jsonc`. It intentionally targets the existing Worker to preserve its secrets and Telegram webhook. The Worker name does not affect the group destination.
- Production starts disabled and its database starts paused. No test messages, topic IDs, memory, preferences, scores, polls, jobs or member records are copied.

A database identity binds one database to one group and environment. Missing or mismatched identity blocks webhook intake, cron processing and outbound delivery. Never edit the test identity to make it match the real group. Preserve the test database for rollback.

## Inputs still needed

1. Real forum supergroup's numeric `-100…` ID.
2. Final bot administrator allowlist. The prepared value contains the existing owner, `1678078373`; confirm that owner is an administrator of the real group and add any other authorised admins.
3. Actual approved group rules and welcome guidance. Do not treat the suggested text below as approved policy.
4. Topic bindings in the real group. `REQUIRED_TOPICS` defaults to gaming,movies,lore; add hongkong,global_events,tv,memes,wallpapers if these must be configured before launch.

## Cutover procedure (not performed during preparation)

1. Add @SIU_M8_bot to the real group as administrator. For approved moderation it needs Delete messages and Restrict members. Topic management is only needed if it will manage topics; binding existing topics does not require creating them. Do not grant Add admins.
2. In Star Wars Test run `/pause`. Record the old Worker variables, database binding and deployed version, without exporting secrets. Preserve the current webhook URL and secret. Ensure no legacy Python process is polling this same bot token; the old GCP GitHub workflow is now manual-only.
3. Verify the production database is fresh and has `schema.sql` and migrations 0002–0005. These are already provisioned for this preparation. Inspect counts for `members`, `context`, `club_messages`, `club_jobs`, `updates`, `topic_map`, and `club_memory`; all should be empty before first cutover.
4. Generate the identity SQL with `node scripts/production-identity.mjs -100REALGROUPID` from this directory. Inspect it, execute it only against the production database, and confirm the returned group/environment. It never overwrites an existing identity.
5. Set the real `GROUP_ID` and final `ADMIN_USER_IDS` in `wrangler.production.jsonc`. Keep General routing (`PRIVATE_THREAD_ID=0`, `PROACTIVE_THREAD_ID=0`) until topics are bound. Set `DEPLOYMENT_ENABLED=true` only for the actual cutover. Verify `EXPECTED_WEBHOOK_URL` matches the current Telegram webhook.
6. Deploy using that explicit production configuration and preserve `BOT_TOKEN` and `WEBHOOK_SECRET`; do not replace them with values from the old root `.env`. This changes the existing Worker's DB binding, not its webhook endpoint. Production remains paused in D1 while configured admins perform setup. Use the Cloudflare API deployment workflow or, with the Wrangler skill loaded, `npx wrangler deploy --config wrangler.production.jsonc`.
7. In each real topic run `/bindtopic gaming`, `/bindtopic movies`, `/bindtopic lore`, etc. Check `/topics` and `/whereami`. Never copy test topic IDs.
8. Add actual rules using `/remember rule | Group rules | Approved text`, inspect `/pending` and `/memory show ID`, then `/approve memory ID`. Welcomes automatically include approved rules and the topic map. Add FAQs/decisions only when genuinely agreed.
9. Run `/readiness`. It checks identity, required mappings, approved rules, bot identity, forum group, deletion/restriction rights, actual administrator status of every allowlisted admin, webhook URL and subscriptions. Reports appear in the group. Fix every issue; `/resume` refuses production activation if these checks fail.
10. Publish the reviewed member notice below. Run `/resume`, then the acceptance checks below with real volunteers. Use `/pause` immediately if delivery or privacy behavior is wrong. General hosting will use the existing 5–10 starter policy and the new overall 20 automated-send budget per Hong Kong day.

The same bot identity is used for this cutover. Do not run two active Workers or polling processes for it. To keep an independently usable test bot afterwards, obtain a separate BotFather bot token and configure its own Worker and test database.

## Acceptance checks

Record the actual message links and outcomes; do not manufacture member updates.

- Direct mention followed by a reply to the bot: specific, contextual answers in the same topic.
- Private admin question: answer appears in General, with no private answer or private message ID attached.
- `/topics`: every required mapping matches the topic where the bind command was sent. Request one post in each intended category.
- `/event create Title | YYYY-MM-DD HH:mm | Venue | hongkong | https://source`: draft only. Confirm after checking the source, RSVP with `yes remind`, verify one group reminder near the event. A `yes silent` or withdrawn RSVP must not be mentioned.
- `/briefing`: links resolve to actual real-group messages; no test-group discussion or private input appears.
- `/game trivia` and `/game character`: actual votes/answers advance the game and score once. `/season` shows a clean production season.
- `/preferences on`, `/era`, `/spoilers`, `/interests`, `/prompts off`, `/forget`: volunteer verifies opt-in and deletion behavior.
- Non-admin `/pending`, `/approve`, `/readiness`, `/resume`: no privileged action. Admin `/pending`: review reasons and correct message links. Destructive actions remain fixture-tested unless an admin deliberately selects a disposable test message/account.
- `/status` and `/settings`: automation usage and cap, active hours, quiet mode and configured topics. `/pause` stops autonomous activity. `/readiness` has no unresolved issues.

## Suggested member notice — review before posting

“SIU-M8 is our AI cantina host. It can run games, help plan events, answer questions and recap discussions. All bot answers, including answers to private admin requests, appear in this group. For briefings and follow-ups it keeps limited group-message excerpts for 24 hours. Preferences are optional: /preferences on; /preferences off removes them. /optout stops processing your participation; /forget removes your stored personal records and opts you out. /privacy explains retention. Moderation flags require an admin's approval before deletion, restriction or banning. Event details are admin-confirmed, not independently verified by the bot.”

## Posting budget

`AUTOMATED_DAILY_CAP=20` is shared by starters, poll follow-ups, welcomes, daily briefings, hosting nudges, all multi-round game posts, ambient replies and opt-in reminders. Explicit commands and addressed replies, explicitly requested briefings/event announcements, and approved moderation are excluded. These retain their existing quotas. The starter baseline of five is a target, not a guarantee when quiet periods, pauses or the overall cap prevent posting.

Slots are reserved atomically before Telegram sends. Rate-limit retries reuse a slot; failed or uncertain sends conservatively retain theirs. At exhaustion, the automated job is marked `budget_limited` and is not dumped into the group the next day. Games may end early and reminders may be skipped when the budget is exhausted. `/status` and `/settings` expose reserved usage. The counter resets at midnight Asia/Hong_Kong. Inspect `updates.error='automated-budget-exhausted'` for suppressed sends.

## Rollback

Pause production and set `DEPLOYMENT_ENABLED=false` before changing bindings. Restore the saved test DB binding, `GROUP_ID=-1004441702993`, `DEPLOYMENT_ENV=test`, original topic-routing variables, original admin list and `DEPLOYMENT_ENABLED=true` in one deployment. Keep the current guarded code or a compatible version. The untouched test database identity will match again; leave it paused until diagnostics pass. Do not change the production identity or replay production jobs in test. The production database remains available for investigation.

A disabled or identity-mismatched deployment intentionally returns HTTP 503 on `/healthz` and accepts no Telegram updates. Do not leave the real webhook aimed at that state after cutover. No sudo/browser setup is required for this deployment procedure.
