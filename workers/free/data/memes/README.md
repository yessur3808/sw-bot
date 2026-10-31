# Reddit Star Wars meme roster

120 distinct public fan memes, visually reviewed on 2026-10-31 from 294 downloaded candidates. The active selection replaces the earlier Imgflip roster. Sources include r/PrequelMemes, r/OTMemes, r/starwarsmemes and r/SequelMemes. Reddit top-post RSS listings provided most candidates; a small set came from cached public Reddit post metadata supplied by meme-api.com. Listing ranks and any recorded scores are discovery snapshots, not current ratings.

Selection favours clear Star Wars jokes, readable text, scene-based humour, gaming references and varied formats. Excluded repeated images/jokes, unreadable long strips, promotional posts, explicit sexual material, slurs, real-world political disputes, fake news claims, major plot reveals and posts needing subreddit-specific context. Familiar scenes, character traits and occasional profanity remain. Humour is subjective; these are editorial selections rather than an automated quality score.

Original JPEG/PNG bytes, creator credits and watermarks are preserved. `roster.json` records Reddit permalinks, submitting accounts (not necessarily original creators), community, image URLs, dimensions and SHA-256. These are third-party fan works, not official Star Wars images or bot-owned artwork.

`seed.sql` imports the reviewed roster and disables previous Imgflip entries. Reimports preserve cached Telegram file IDs, rotation history and manual removals. The runtime sends the original image without a caption. Source links and attribution remain in the internal roster. Disable any item with `UPDATE meme_roster SET active=0 WHERE id=...`; pending photo retries recheck active status. Production downloads commit-pinned copies rather than depending on Reddit at posting time.
