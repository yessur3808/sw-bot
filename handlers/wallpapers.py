import requests, random
from telegram.ext import ContextTypes
from config import GROUP_ID, THREADS
import db

API = "https://wallhaven.cc/api/v1/search"

async def daily_wallpaper(context: ContextTypes.DEFAULT_TYPE):
    params = {
        "q": "star wars",
        "categories": "010",   # general
        "purity": "100",       # SFW only
        "ratios": "9x16",      # phone-friendly
        "sorting": "random",
    }
    r = requests.get(API, params=params, timeout=15).json()
    for wp in r.get("data", []):
        if not db.already_posted("wallpaper", wp["id"]):
            caption = f"📱 Wallpaper of the day\nFull res: {wp['path']}"
            message = await context.bot.send_photo(
                chat_id=GROUP_ID,
                message_thread_id=THREADS["wallpapers"],
                photo=wp["thumbs"]["large"],
                caption=caption,
            )
            db.log_post_audit(
                topic="wallpaper",
                thread_id=THREADS["wallpapers"],
                telegram_message_id=message.message_id,
                content_type="wallpaper",
                content_id=f"wallpaper:{wp['id']}",
                text=caption,
            )
            return