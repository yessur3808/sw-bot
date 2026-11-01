# YouTube trailer verification — 29 October 2026

- Anonymous channel-tab reads succeeded for official Star Wars
  (`UCZGYJFUizSax-yElQaFDp5Q`) and EA Star Wars (`UCOsVSkmXD1tc6uiJ2hc0wYQ`).
  Official site links and resolved channel IDs were checked. RSS checks earlier
  returned a 404/empty response; the deployed collector uses the video tabs.
- Downloaded official Galactic Racer launch trailer `pR-V3j-sc7s`, originally
  published 6 October, without a login/API key. Original MP4: 10,717,401 bytes.
  Prepared H.264/AAC MP4: 8,689,444 bytes, 640×360, 30 fps, 133.91 seconds.
- A deliberately labelled delivery fixture was inserted only into the test D1
  database. Its eligibility timestamp was set to test time to exercise delivery
  of this older trailer; production discovery rules were not relaxed.
- Telegram accepted `sendVideo` to Star Wars Test's Gaming topic 128, message 146:
  https://t.me/c/4441702993/128/146 . Resubmitting returned `sent` with no reupload.
  The test message contains the original source URL and spoiler protection.
- The old test Worker Telegram credential returned 401. A temporary authenticated
  production route used the current credential with a fixed test-group identity
  and test D1 binding. That route and binding were removed after success. The
  `/media-test/media/monitor` path returns 404. No production destination was used
  for this test. Test `DEPLOYMENT_ENABLED=false`, D1 `paused=1`, no media timer or
  new webhook was configured for test, and the temporary test secret was removed.
- Production health reports `youtube-trailers-2026-10-29`. The first real timer
  run succeeded for both channels, recorded 80 baseline uploads and queued no
  historical posts. The media endpoint rejects unauthenticated requests (401).
- 346 Node/SQLite tests and four Python tests pass. Checks cover baseline,
  source identity, ambiguity, freshness, pause/waking hours, topic mapping changes
  during send, shared daily budget, concurrent upload claims, size rejection,
  rate limits and uncertain delivery. Secret scans found no credentials in the
  changed Worker or media-agent directories; config remains outside the repo.

This establishes a real MP4 upload and live discovery. A future naturally arriving
trailer has not yet exercised the entire automatic sequence. Public YouTube access
can change; failures and stale collection are exposed in portal Settings. The
old test bot credential remains invalid and would need attention before any future
test-group reactivation. No member content or approvals were copied between D1s.
