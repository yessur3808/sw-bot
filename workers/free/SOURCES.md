# Official news, events and release knowledge

`source-catalog.mjs` supplies eight official discovery sources and thirteen initial
release/event records, researched on 29 October 2026. The evidence manifest is
`data/source-research-2026-10-29.json`. This is bounded coverage, not an exhaustive
search of the web or a promise that every new title is automatically catalogued.

The minutely cron refreshes at most two due pages: news hubs about every six hours,
release evidence daily. Initial refresh therefore fills gradually. Requests use
an eight-second timeout, HTTPS allowlists, rejected redirects and a streaming
two-MiB limit. Source snapshots/status live under `source-feed:` in D1 `settings`;
no member data is sent to these sources. Failed checks back off and preserve the
last successful timestamp. HTML navigation, category hubs and non-Star-Wars local
listings are excluded. News results are headline discovery with source links,
not claims that the entire article or event details were independently verified.

Catalogue facts include announced/released status, date precision, market,
platforms, access method and official source/availability links. Rechecking a
page does not automatically infer new facts: all stored evidence markers must
still appear on every required page before the recorded claims are renewed.
Changed/missing evidence needs editorial review. An announcement date passing
never proves a release happened. Unknown dates/platforms remain unknown.
Adding newly announced titles or changing structured claims requires a reviewed
catalogue update; news discovery can surface their official headlines meanwhile.

Availability-sensitive entries expire after 48 hours without successful evidence
rechecks; other catalogue snapshots expire after 30 days. Stale/review-needed
records can be shown as dated references but cannot drive proactive posts.
Global release dates do not establish Hong Kong release dates. Only explicit
Hong Kong provider evidence permits a local availability claim. Availability
and prices can change; linked providers remain authoritative.

Commands:

- `/news` — official headlines; `/news hongkong` filters local discoveries.
- `/releases movies`, `/releases shows`, `/releases games` — dates and access.
- `/releases events hongkong` — catalogue entries for local events.
- `/releases Maul` — search a title.
- `/sources` — private source diagnostics for the configured administrator.

The portal's **Settings & topics** displays source status, last successful checks
and review flags. Source-backed proactive posts share all existing posting and
approval controls; a fetch never publishes directly. If no fresh source is usable,
event starters fall back to clearly labelled community planning ideas.

Known collection limits at initial verification: Hong Kong Tourism Board pages
were browser-readable but returned HTTP 403 to automated fetching. Hong Kong
Disneyland returned a JavaScript shell; the cinema hub had no matching Star Wars
items. These are recorded as errors/no matches, not proof that no local events
exist. Celebration's marketing hub is not used as a news feed; its reviewed event
and ticket information remain in the catalogue. No authenticated/subscription-only
content or access-control bypass is used.
