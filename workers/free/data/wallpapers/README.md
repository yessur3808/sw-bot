# Star Wars wallpapers

30 distinct wallpapers from the owner-selected public board https://www.pinterest.com/yaser3808/star-wars-wallpaper/.
Imported from the local download on 31 October 2026. Five lower-resolution copies of repeated artwork and the tiny preview were excluded. Source resolution varies; images were not upscaled or cropped. JPEG bytes are unchanged; one TIFF was converted to PNG with identical decoded RGB pixels. Existing artwork and marks are preserved.

Provenance stays in `roster.json`. Telegram posts contain only the photo: no caption, source text, buttons or companion message. This is a fixed roster, not an account connection or automatic Pinterest sync.

Apply migration `0012_wallpaper_roster.sql` and then `seed.sql`. Reimports preserve disabled entries, cached Telegram file IDs and rotation history. Disable an item with `UPDATE wallpaper_roster SET active=0 WHERE id=...`; queued retries recheck it before delivery.
