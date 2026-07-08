from telegram import Update
from telegram.ext import ContextTypes, MessageHandler, CommandHandler, filters
import db
from telemetry import instrument_command_handler

RANKS = [
    (0, "Youngling"), (100, "Padawan"), (500, "Jedi Knight"),
    (1500, "Jedi Master"), (4000, "Grand Master"),
]

def rank_for(xp):
    title = RANKS[0][1]
    for threshold, name in RANKS:
        if xp >= threshold:
            title = name
    return title

async def track_xp(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    if user and not user.is_bot:
        db.add_xp(user.id, user.username or user.first_name, 1)

async def rank_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    u = db.get_user(update.effective_user.id)
    if not u:
        await update.message.reply_text("No XP yet. Start chatting! 🌌")
        return
    await update.message.reply_text(
        f"🪐 {u['username']}\nRank: {rank_for(u['xp'])}\nXP: {u['xp']}"
    )

async def leaderboard_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    rows = db.top_users(10)
    medals = ["🥇", "🥈", "🥉"] + ["▫️"] * 7
    text = "🏆 *Galactic Leaderboard*\n\n"
    for i, r in enumerate(rows):
        text += f"{medals[i]} {r['username']} — {r['score']} XP\n"
    await update.message.reply_text(text, parse_mode="Markdown")

def register(app):
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, track_xp))
    app.add_handler(CommandHandler("rank", instrument_command_handler("rank", rank_cmd)))
    app.add_handler(CommandHandler("leaderboard", instrument_command_handler("leaderboard", leaderboard_cmd)))