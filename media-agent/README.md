# Public YouTube trailer monitoring

The server's `sw-bot-media.timer` checks the official Star Wars and EA Star Wars
YouTube video tabs every 15 minutes (up to 30 seconds of jitter). Their channel
IDs and official identity evidence are in `workers/free/youtube.mjs`. No YouTube
API key, paid API, account cookies or login is used. This is bounded discovery of
the latest 40 video-tab uploads per channel, not a complete YouTube archive,
Shorts/Community feed, or a promise of uninterrupted public access.

The first successful scan per channel records a baseline and publishes nothing.
Subsequent new trailers/teasers need an individual watch-page channel match, a
publication timestamp within seven days, and a duration of 5–600 seconds. Known
titles and explicit movie/series/game language route them to Movies, TV or Gaming.
Conflicting or unknown destinations wait in `review`; reactions, concept trailers
and anniversary re-releases cannot auto-publish. The portal shows held items with
their source links; they are not automatically approved by a model. An administrator
can create a normal portal link post for a held item after reviewing its destination.

The companion downloads a complete progressive MP4 with audio, up to 480p and
45,000,000 bytes, then converts it to H.264/AAC with fast-start metadata. The result
must also fit that cap. It never truncates a trailer to fit. Temporary files are
deleted after each attempt. Unsupported formats, oversized files and download
failures are held and displayed in the portal; they are not silently replaced by
an upload claimed to have succeeded. Login/rate-limit blocks stop the platform
attempt without cookies, proxies or alternate-account retries.

The companion has a random scoped `MEDIA_AGENT_SECRET`, not the Telegram bot token.
The private config lives at `~/.config/sw-bot-media/config.json` (mode 0600), outside
Git. Its shape is `{"url":"https://WORKER.workers.dev","secret":"<64 hex characters>"}`.
Keep the same secret in the target Worker's secret binding. `/media/*` requires it;
the endpoint accepts only configured channels and computes the group/topic itself.
No client can supply a Telegram destination. Requests cannot redirect credentials.

The Worker streams multipart uploads to Telegram instead of buffering video files.
It checks deployment identity, 08:00–00:00 HKT, pause/quiet settings, ten quiet
minutes in the destination, a shared daily automation budget and one trailer per
hour. It rechecks the topic after claiming the send. Missing topics never fall back
to General. Videos carry source attribution, the original YouTube URL and Telegram
spoiler protection. Uploads stop at 45 MB, below Telegram's documented 50 MB limit.

Unique video IDs prevent reuploads of the same video. This does not identify
different uploads/edits of the same trailer across channels. A 429 response defers
delivery. Lost responses, server errors or interrupted sends are held as uncertain
and never blindly retried. Inspect Telegram before manually resolving any such
record. No debug/status messages are posted to the group.

Deployment:

1. Apply `workers/free/migrations/0009_youtube.sql` to the matching D1 database.
2. Deploy the Worker modules with `MEDIA_AGENT_SECRET` set privately.
3. Create a venv at `~/.local/share/sw-bot-media/venv`, install `requirements.txt`,
   and provide Node.js on PATH for yt-dlp's JavaScript runtime.
4. Install the included service/timer in `~/.config/systemd/user/`, then run
   `systemctl --user daemon-reload` and `systemctl --user enable --now sw-bot-media.timer`.
5. Check `journalctl --user -u sw-bot-media.service` and portal Settings → YouTube
   trailers. A successful check older than 45 minutes is shown as stale.

The timer runs on this server, so the server must stay online; Cloudflare keeps
handling Telegram even when this companion is offline. Stop the timer to stop
YouTube discovery; `/pause` also stops video delivery. No additional hosting or
paid API subscription was provisioned. Future dependency updates are explicit.

Tests: `node --test tests/*.test.mjs` in `workers/free`; run `python -m unittest`
in this directory with the media venv. Live upload evidence is recorded separately
so fixture tests are not mistaken for real Telegram delivery.
