import { postingPolicy, starterCount, recordEngagement, starterSpacingBlocked } from './adaptive.mjs';
import { topicThread, topicSummary, topicName, TOPICS, quiet, defer, preferencesCommand, preferencePrompt, recordPoll, receivePoll, scheduleFollowups, followup } from './community.mjs';
import { VERSION, PERSONALITY, activeHours, ambientCandidate, reserveAmbient, cleanAnswer, bounded, setting, setSetting, currentRelease, refreshReleases, scheduleProactive, proactive, diagnose, KINDS } from './engagement.mjs';
// data/trivia.json
var trivia_default = [
  {
    question: "What color is Mace Windu's lightsaber?",
    options: [
      "Blue",
      "Green",
      "Purple",
      "Red"
    ],
    correct: 2,
    category: "movie_trivia",
    topics: [
      "jedi",
      "lightsaber"
    ],
    source: {
      type: "movie",
      title: "Episode II and III"
    }
  },
  {
    question: "Who built C-3PO?",
    options: [
      "Han Solo",
      "Anakin Skywalker",
      "Obi-Wan Kenobi",
      "Luke Skywalker"
    ],
    correct: 1,
    category: "movie_trivia",
    topics: [
      "droids",
      "tatooine"
    ],
    source: {
      type: "movie",
      title: "Episode I: The Phantom Menace"
    }
  },
  {
    question: "What is the name of Han Solo's ship?",
    options: [
      "Slave I",
      "Millennium Falcon",
      "Ghost",
      "Razor Crest"
    ],
    correct: 1,
    category: "movie_trivia",
    topics: [
      "ships",
      "smugglers"
    ],
    source: {
      type: "movie",
      title: "Original Trilogy"
    }
  },
  {
    question: "Who trained Obi-Wan Kenobi as a Padawan?",
    options: [
      "Yoda",
      "Mace Windu",
      "Qui-Gon Jinn",
      "Ki-Adi-Mundi"
    ],
    correct: 2,
    category: "lore_trivia",
    topics: [
      "jedi lineage",
      "prequels"
    ],
    source: {
      type: "movie",
      title: "Episode I"
    }
  },
  {
    question: "Which planet is known as the Wookiee homeworld?",
    options: [
      "Kashyyyk",
      "Corellia",
      "Mandalore",
      "Mon Cala"
    ],
    correct: 0,
    category: "lore_trivia",
    topics: [
      "planets",
      "species"
    ],
    source: {
      type: "movie",
      title: "Episode III"
    }
  },
  {
    question: "Who created the Darksaber?",
    options: [
      "Bo-Katan Kryze",
      "Tarre Vizsla",
      "Pre Vizsla",
      "Darth Maul"
    ],
    correct: 1,
    category: "lore_trivia",
    topics: [
      "mandalorian",
      "darksaber"
    ],
    source: {
      type: "series",
      title: "The Clone Wars / Rebels"
    }
  },
  {
    question: "In canon, what rank does Thrawn hold in the Empire?",
    options: [
      "Moff",
      "Grand Admiral",
      "Commander",
      "General"
    ],
    correct: 1,
    category: "series_trivia",
    topics: [
      "imperial",
      "thrawn"
    ],
    source: {
      type: "series",
      title: "Star Wars Rebels"
    }
  },
  {
    question: "Which battle station was destroyed at Yavin?",
    options: [
      "Starkiller Base",
      "Death Star I",
      "Death Star II",
      "The Supremacy"
    ],
    correct: 1,
    category: "movie_trivia",
    topics: [
      "rebellion",
      "space battles"
    ],
    source: {
      type: "movie",
      title: "Episode IV"
    }
  },
  {
    question: "Which character says 'I am one with the Force and the Force is with me'?",
    options: [
      "Baze Malbus",
      "Cassian Andor",
      "Chirrut Imwe",
      "Saw Gerrera"
    ],
    correct: 2,
    category: "movie_trivia",
    topics: [
      "rogue one",
      "quotes"
    ],
    source: {
      type: "movie",
      title: "Rogue One"
    }
  },
  {
    question: "Which game first introduced Darth Revan?",
    options: [
      "Jedi Outcast",
      "Battlefront II",
      "KOTOR",
      "The Force Unleashed"
    ],
    correct: 2,
    category: "legends_trivia",
    topics: [
      "old republic",
      "games",
      "legends"
    ],
    source: {
      type: "game",
      title: "Star Wars: Knights of the Old Republic"
    }
  }
];

// data/polls.json
var polls_default = [
  {
    question: "Which era should we spotlight this week?",
    options: [
      "Old Republic",
      "Prequel Era",
      "Original Trilogy",
      "New Republic"
    ],
    category: "era_poll",
    topics: [
      "timeline",
      "community spotlight"
    ],
    source: {
      type: "community"
    }
  },
  {
    question: "Best lightsaber style to study first?",
    options: [
      "Form II: Makashi",
      "Form III: Soresu",
      "Form V: Djem So",
      "Form VII: Juyo"
    ],
    category: "lore_poll",
    topics: [
      "lightsaber forms",
      "jedi"
    ],
    source: {
      type: "reference",
      title: "Jedi training lore"
    }
  },
  {
    question: "Pick tonight's watch vibe",
    options: [
      "Clone Wars arc",
      "Andor episode",
      "Original trilogy",
      "Rogue One"
    ],
    category: "watch_party_poll",
    topics: [
      "watchlist",
      "series",
      "movies"
    ],
    source: {
      type: "community"
    }
  },
  {
    question: "Most iconic droid companion?",
    options: [
      "R2-D2",
      "C-3PO",
      "BB-8",
      "Chopper"
    ],
    category: "character_poll",
    topics: [
      "droids",
      "iconic characters"
    ],
    source: {
      type: "community"
    }
  },
  {
    question: "Most compelling villain arc?",
    options: [
      "Anakin to Vader",
      "Kylo Ren",
      "Maul",
      "Thrawn"
    ],
    category: "character_poll",
    topics: [
      "villains",
      "character arcs"
    ],
    source: {
      type: "movie + series"
    }
  },
  {
    question: "Which faction has the best visual style?",
    options: [
      "Jedi Order",
      "Sith",
      "Mandalorians",
      "Rebel Alliance"
    ],
    category: "faction_poll",
    topics: [
      "factions",
      "design"
    ],
    source: {
      type: "community"
    }
  },
  {
    question: "Best Star Wars game campaign?",
    options: [
      "KOTOR",
      "Jedi: Fallen Order",
      "Battlefront II",
      "The Force Unleashed"
    ],
    category: "game_poll",
    topics: [
      "games",
      "story mode"
    ],
    source: {
      type: "game"
    }
  },
  {
    question: "Most impressive fleet moment?",
    options: [
      "Battle of Endor",
      "Scarif shield assault",
      "Exegol finale",
      "Mandalore siege"
    ],
    category: "battle_poll",
    topics: [
      "space battles",
      "fleet tactics"
    ],
    source: {
      type: "movie + series"
    }
  },
  {
    question: "Preferred era for new stories?",
    options: [
      "High Republic",
      "Old Republic",
      "Post-ROTJ New Republic",
      "Far future"
    ],
    category: "future_content_poll",
    topics: [
      "story development",
      "new content"
    ],
    source: {
      type: "community"
    }
  }
];

// data/discussions.json
var discussions_default = [
  {
    prompt: "Was Anakin fully responsible for his fall, or did the Jedi Council's structure make it almost inevitable?",
    stance_options: [
      "Mostly Anakin",
      "Mostly Jedi failure",
      "Palpatine tipped it",
      "Combination of all"
    ],
    category: "movie_discussion",
    topics: [
      "anakin",
      "jedi council",
      "tragedy"
    ],
    source: {
      type: "movie",
      title: "Episode I-III"
    }
  },
  {
    prompt: "Did Luke's exile in The Last Jedi deepen his character, or undermine the hopeful ending of Return of the Jedi?",
    stance_options: [
      "Deepened character",
      "Undermined ROTJ",
      "Both are true",
      "Undecided"
    ],
    category: "movie_discussion",
    topics: [
      "luke skywalker",
      "sequels",
      "character arc"
    ],
    source: {
      type: "movie",
      title: "Episode VIII"
    }
  },
  {
    prompt: "Should the franchise prioritize tightly connected canon continuity, or allow more standalone stories with loose ties?",
    stance_options: [
      "Tight canon",
      "Standalone freedom",
      "Balanced mix",
      "Depends on medium"
    ],
    category: "franchise_discussion",
    topics: [
      "canon",
      "story strategy",
      "future projects"
    ],
    source: {
      type: "franchise"
    }
  },
  {
    prompt: "Was the sequel trilogy harmed more by changing creative direction between films than by any one plot choice?",
    stance_options: [
      "Direction shifts hurt most",
      "Specific plot choices hurt most",
      "Both equally",
      "Disagree"
    ],
    category: "movie_discussion",
    topics: [
      "sequels",
      "production",
      "story planning"
    ],
    source: {
      type: "movie",
      title: "Episode VII-IX"
    }
  },
  {
    prompt: "Should Legends stories continue to be adapted into canon, or stay as a separate legacy timeline?",
    stance_options: [
      "Adapt more Legends",
      "Keep timelines separate",
      "Case-by-case",
      "No preference"
    ],
    category: "legends_discussion",
    topics: [
      "legends",
      "canon",
      "adaptation"
    ],
    source: {
      type: "publishing"
    }
  },
  {
    prompt: "Did the prequels age into classics mainly because of The Clone Wars expanding their characters and politics?",
    stance_options: [
      "Yes, mostly",
      "No, films stood alone",
      "Partly",
      "Not sure"
    ],
    category: "movie_discussion",
    topics: [
      "prequels",
      "clone wars",
      "reputation"
    ],
    source: {
      type: "movie + series",
      title: "Episode I-III / The Clone Wars"
    }
  },
  {
    prompt: "Is the Force more compelling when treated as a spiritual mystery, or when heavily systematized with rules?",
    stance_options: [
      "Mystery first",
      "Rules and structure",
      "Both needed",
      "Changes by story"
    ],
    category: "lore_discussion",
    topics: [
      "force",
      "worldbuilding",
      "philosophy"
    ],
    source: {
      type: "franchise"
    }
  },
  {
    prompt: "Did Andor set a new quality bar that future live-action Star Wars shows should match, even if it means fewer releases?",
    stance_options: [
      "Yes, raise bar",
      "No, keep variety",
      "Blend both",
      "Too early to say"
    ],
    category: "tv_series_discussion",
    topics: [
      "andor",
      "quality vs quantity",
      "disney+"
    ],
    source: {
      type: "series",
      title: "Andor"
    }
  }
];

// workers/free/index.ts
var clock = () => Math.floor(Date.now() / 1e3);
var admins = (env) => env.ADMIN_USER_IDS.split(",").map(Number).filter((n) => n > 0);
var botID = (env) => Number(env.BOT_TOKEN?.split(":")[0]);
var SYSTEM_PROMPT = PERSONALITY;
var HELP = `SIU-M8 cantina host \u2014 AI host for your Star Wars group.

/ask <question> \u2014 ask with brief conversation context
/discuss \u2014 one question for the group
/trivia \u2014 a 60-second quiz (first answer counts)
/poll \u2014 a community vote
/rank and /leaderboard \u2014 participation rewards
/whereami \u2014 show group and topic routing
/topics — show named topics; admins: /bindtopic <name> inside a topic
Content topics: gaming, movies, lore, hongkong/local_events, global_events, tv, memes, wallpapers
/guess, /quote, /weeklytrivia — play a two-minute quiz
/preferences on|off — opt into remembered preferences
/era any|prequels|original|sequels|high-republic|old-republic|legends
/spoilers avoid|allow — save spoiler preference
/privacy \u2014 what is stored and sent to AI
/optout \u2014 stop processing your participation
/optin \u2014 rejoin
/forget \u2014 remove your stored participation/context and opt out

Private requests from configured admins produce public responses in the group, not in DMs. I answer mentions and replies, occasionally join relevant conversations, and target five daily conversation starters, rising to seven or ten when recent participation is strong (10:00–23:00 Hong Kong). Admins: /pause, /resume, /status, /post [question|poll|idea|movie|game].`;
var PRIVACY = `I am an AI bot. Configured admins can message me privately, but all my responses and polls are published to the configured group. Private request text is retained in a separate private context, not copied into shared group history; my published answer can be used as group context. Direct questions, mentions, replies to me and occasional relevant group messages can be sent to Cloudflare Workers AI with recent bot-conversation context from this topic. That context expires after 24 hours. Unselected ordinary message text is not stored. Selected messages and my replies are kept for 24 hours. Autonomous post records are kept for 30 days. Topic activity timestamps (without text or user IDs) expire after 24 hours. Saved era/spoiler preferences are opt-in and kept until /preferences off or /forget. Poll aggregate results expire after 7 days. Adaptive posting uses at most one text-free engagement signal per member per five minutes; signals expire after two days and /forget removes them. I store participation scores, your display name, quiz answers and delivery counters. Quiz answers expire after 7 days; delivery records after 7 days; scores last until /forget. /optout stops new participation processing; /forget deletes your records and opts you out. Data already delivered to Telegram or processed by the AI provider cannot be recalled by this command.`;
function command(text, username) {
  const m = text.match(/^\/([a-z_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
  if (!m || m[2] && m[2].toLowerCase() !== username.toLowerCase()) return null;
  return { name: m[1].toLowerCase(), arg: (m[3] || "").trim() };
}
function addressed(m, env) {
  const escaped = env.BOT_USERNAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return env.BOT_USERNAME.length > 0 && new RegExp(`@${escaped}\\b`, "i").test(m.text || "") || m.reply_to_message?.from?.id === botID(env);
}
function allowed(m, env) {
  if (m.chat.type === "private") return admins(env).includes(m.from?.id || 0);
  if (m.chat.id !== Number(env.GROUP_ID) || Number(env.GROUP_ID) >= 0) return false;
  const threads = (env.ALLOWED_THREAD_IDS || "").split(",").filter(Boolean).map(Number);
  return !threads.length || threads.includes(m.message_thread_id || 0);
}
async function optedOut(env, user) {
  return Boolean((await env.DB.prepare("SELECT opted_out FROM preferences WHERE user_id=?").bind(user).first())?.opted_out);
}
async function mark(env, id, state, error = null) {
  await env.DB.prepare("UPDATE updates SET state=?, error=?, payload='{}',outbound=NULL,method=NULL WHERE id=?").bind(state, error, id).run();
}
function groupTarget(env) {
  const chat = Number(env.GROUP_ID);
  if (!Number.isSafeInteger(chat) || chat >= 0) throw new Error("invalid-group-routing");
  const allowedThreads = (env.ALLOWED_THREAD_IDS || "").split(",").filter(v => v.trim()).map(Number);
  const thread = Number(env.PRIVATE_THREAD_ID ?? env.PROACTIVE_THREAD_ID ?? allowedThreads[0] ?? 0);
  if (!Number.isSafeInteger(thread) || thread < 0 || allowedThreads.some(n => !Number.isSafeInteger(n) || n < 0) || allowedThreads.length && !allowedThreads.includes(thread)) throw new Error("invalid-topic-routing");
  return {chat_id:chat, ...(thread ? {message_thread_id:thread} : {})};
}
function groupDelivery(env, original) {
  const body = {...original};
  if (Number(body.chat_id) > 0) {
    // Message IDs and topic IDs are local to their source chat. Never attach a
    // private message's ID to a group reply, even on a persisted delivery retry.
    delete body.message_thread_id;
    delete body.reply_parameters;
    delete body.reply_to_message_id;
    delete body.direct_messages_topic_id;
    Object.assign(body, groupTarget(env));
  }
  if (Number(body.chat_id) !== Number(env.GROUP_ID) || Number(env.GROUP_ID) >= 0) throw new Error("unexpected-delivery-chat");
  return body;
}
async function send(env, updateId, method, body) {
  body = groupDelivery(env, body);
  // Community polls are closed by maintenance, which captures final totals.
  // Telegram may not send an update when an automatic timer closes an empty poll.
  await env.DB.prepare("UPDATE updates SET state='sending',outbound=?,method=? WHERE id=?").bind(JSON.stringify(body), method, updateId).run();
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8e3)
    });
  } catch {
    throw new Error("telegram-delivery-uncertain");
  }
  const result = await response.json();
  if (!result.ok) {
    if (result.error_code === 429) {
      await env.DB.prepare("UPDATE updates SET state='queued',ready_at=?,error='telegram-rate-limit' WHERE id=?").bind(clock() + Math.max(1, result.parameters?.retry_after || 30), updateId).run();
    } else if (result.error_code && result.error_code < 500) {
      await mark(env, updateId, "failed", `telegram-${result.error_code}`);
    }
    throw new Error("telegram-rejected");
  }
  if (method === "sendPoll" && body.type === "quiz" && result.result?.poll?.id) {
    await env.DB.prepare("INSERT OR IGNORE INTO polls(poll_id,correct,expires_at,chat_id,thread_id) VALUES (?,?,?,?,?)").bind(result.result.poll.id, Number(body.correct_option_id), clock() + (body.open_period || 60) + 5, Number(body.chat_id), Number(body.message_thread_id || 0)).run();
  }
  if (method === "sendPoll") await recordPoll(env,updateId,body,result.result);
  await setSetting(env, "last_delivery", JSON.stringify({update_id:updateId,chat_id:body.chat_id,thread_id:body.message_thread_id || 0,message_id:result.result?.message_id,method,sent_at:clock()}));
  return result.result;
}
async function say(env, id, m, text) {
  return send(env, id, "sendMessage", {
    chat_id: m.chat.id,
    message_thread_id: m.message_thread_id,
    text: text.slice(0, 3800),
    reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true },
    link_preview_options: { is_disabled: true }
  });
}
async function member(env, user) {
  await env.DB.prepare("INSERT INTO members(user_id,name) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name").bind(user.id, (user.first_name || user.username || "Member").replace(/[\r\n]/g, " ").slice(0, 80)).run();
}
async function reward(env, key, user, amount, kind) {
  const now = clock();
  await env.DB.prepare(`INSERT OR IGNORE INTO rewards(event_key,user_id,amount,kind,created_at)
    SELECT ?,?,?,?,? WHERE (SELECT COALESCE(SUM(amount),0) FROM rewards WHERE user_id=? AND created_at>=?) + ? <= 20
    AND NOT EXISTS(SELECT 1 FROM rewards WHERE user_id=? AND kind=? AND created_at>?)`).bind(key, user, amount, kind, now, user, now - now % 86400, amount, user, kind, now - 60).run();
}
async function takeQuota(env, key, m, kind, cap, gap) {
  const now = clock();
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO quota(event_key,user_id,thread_id,kind,created_at)
    SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM quota WHERE kind=? AND created_at>=?) < ?
    AND NOT EXISTS(SELECT 1 FROM quota WHERE user_id=? AND kind=? AND created_at>?)`).bind(key, m.from.id, m.message_thread_id || 0, kind, now, kind, now - now % 86400, cap, m.from.id, kind, now - gap).run();
  return (result.meta.changes || 0) > 0;
}
async function quizAnswer(env, u) {
  const a = u.poll_answer;
  if (!a.user || a.user.is_bot || a.option_ids.length !== 1 || await optedOut(env, a.user.id)) return;
  const poll = await env.DB.prepare("SELECT * FROM polls WHERE poll_id=? AND expires_at>=?").bind(a.poll_id, clock()).first();
  if (!poll || poll.chat_id !== Number(env.GROUP_ID)) return;
  await recordEngagement(env,a.user.id,poll.thread_id,true);
  await member(env, a.user);
  await env.DB.prepare("INSERT OR IGNORE INTO answers(poll_id,user_id,option_id) VALUES (?,?,?)").bind(a.poll_id, a.user.id, a.option_ids[0]).run();
  const first = await env.DB.prepare("SELECT option_id FROM answers WHERE poll_id=? AND user_id=?").bind(a.poll_id, a.user.id).first();
  if (first?.option_id === poll.correct) await reward(env, `quiz:${a.poll_id}:${a.user.id}`, a.user.id, 3, "quiz");
}
async function handle(env, u) {
  if (u.poll) { await receivePoll(env,u.poll); return; }
  if (u.internal_followup) { await followup(env,u.update_id,u.internal_followup,send,SYSTEM_PROMPT); return; }
  if (u.poll_answer) {
    await quizAnswer(env, u);
    return;
  }
  if (u.internal_configure) {
    const response=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getWebhookInfo`,{signal:AbortSignal.timeout(8000)});
    const info=await response.json();
    if(!info.ok || !info.result.url) throw Error('webhook-not-configured');
    const result=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:info.result.url,secret_token:env.WEBHOOK_SECRET,allowed_updates:['message','poll','poll_answer'],drop_pending_updates:false}),signal:AbortSignal.timeout(8000)});
    if(!(await result.json()).ok)throw Error('webhook-configure-failed');return;
  }
  if (u.internal_diagnostics) { await diagnose(env); return; }
  if (u.internal_post) { await proactive(env, u.update_id, u.internal_post, send, polls_default, trivia_default); return; }
  const m = u.message;
  if (!m?.from) return;
  const user = m.from;
  const text = (m.text || "").trim();
  if (!allowed(m, env) || user.is_bot || !text) return;
  const cmd = command(text, env.BOT_USERNAME);
  if (text.startsWith("/") && !cmd) return;
  if (cmd?.name === "whereami") {
    const target = groupTarget(env);
    const topic = target.message_thread_id || 0;
    await say(env, u.update_id, m, `Configured group: ${target.chat_id}\nPrivate requests publish to: ${topic ? "topic " + topic : "General"}\nCurrent group topic: ${m.chat.type === "private" ? "request came from DM" : m.message_thread_id || "General"}\nNamed topic map:\n${await topicSummary(env)}\nGroup replies stay in the topic where you ask.`);
    return;
  }
  if (cmd?.name === "privacy") {
    await say(env, u.update_id, m, PRIVACY);
    return;
  }
  if (["forget", "optout", "optin"].includes(cmd?.name || "")) {
    const out = cmd.name !== "optin" ? 1 : 0;
    await env.DB.prepare("INSERT INTO preferences(user_id,opted_out) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET opted_out=excluded.opted_out").bind(user.id, out).run();
    if (out) await env.DB.prepare("DELETE FROM context WHERE user_id=?").bind(user.id).run();
    if (cmd.name === "forget") {
      await env.DB.batch(["rewards", "members", "answers", "quota", "fan_preferences"].map((table) => env.DB.prepare(`DELETE FROM ${table} WHERE user_id=?`).bind(user.id)));
      await env.DB.prepare("UPDATE updates SET state='done',payload='{}',outbound=NULL,method=NULL WHERE id<>? AND json_extract(payload,'$.message.from.id')=?").bind(u.update_id, user.id).run();
    }
    await say(env, u.update_id, m, out ? "You\u2019re opted out. Your stored conversation context has been removed." + (cmd.name === "forget" ? " Your participation records were deleted too." : "") : "You\u2019re opted in. Use /privacy to review how testing works.");
    return;
  }
  if (await optedOut(env, user.id)) return;
  if (await preferencesCommand(env,u.update_id,m,cmd,say)) return;
  if (cmd?.name === 'topics' || cmd?.name === 'bindtopic') {
    if (cmd.name === 'bindtopic') {
      const name=topicName(cmd.arg);
      if (!admins(env).includes(user.id) || m.chat.type === 'private' || !name) {
        await say(env,u.update_id,m,'Admins: send /bindtopic <name> inside its group topic. Examples: gaming, movies, lore, hongkong, global_events, tv, memes, wallpapers. Names can contain letters, numbers and spaces/underscores (40 characters max).');return;
      }
      await env.DB.prepare('INSERT INTO topic_map(name,thread_id) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET thread_id=excluded.thread_id').bind(name,m.message_thread_id||0).run();
    }
    await say(env,u.update_id,m,await topicSummary(env));return;
  }
  if (["pause", "resume", "status"].includes(cmd?.name || "")) {
    if (!admins(env).includes(user.id)) {
      await say(env, u.update_id, m, "This command is for the configured admins.");
      return;
    }
    if (cmd.name !== "status") await env.DB.prepare("INSERT INTO settings(key,value) VALUES ('paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(cmd.name === "pause" ? "1" : "0").run();
    const paused = await env.DB.prepare("SELECT value FROM settings WHERE key='paused'").first();
    const errors = await env.DB.prepare("SELECT COUNT(*) AS n FROM updates WHERE state IN ('uncertain','failed')").first();
    const policy=await postingPolicy(env);
    const starters=await starterCount(env);
    await say(env, u.update_id, m, `Testing bot ${paused?.value === "1" ? "paused" : "active"}. Proactive starters: ${starters}/${policy.target} today (baseline 5, ceiling 10). Current spacing: ${policy.gap/60}min; wait for 10 quiet minutes in the topic. Engagement over 4h: ${policy.participants} participants, score ${policy.score}. Active hours: 10:00–23:00 Hong Kong. Busy topics, pauses and delivery failures can prevent the target; no catch-up bursts. Occasional replies: up to 6/day, 15min per-topic cooldown. AI reply cap: ${env.AI_DAILY_CAP}/day. Delivery failures needing inspection: ${errors?.n || 0}. Use /post to request a conversation starter; /pause stops autonomous posts and replies.`);
    return;
  }
  if (cmd?.name === "start" || cmd?.name === "help") {
    await say(env, u.update_id, m, HELP);
    return;
  }
  if ((await env.DB.prepare("SELECT value FROM settings WHERE key='paused'").first())?.value === "1") return;
  await member(env, user);
  if (cmd?.name === "rank" || cmd?.name === "leaderboard") {
    const result = await env.DB.prepare(`SELECT m.name,r.user_id,SUM(r.amount) AS xp FROM rewards r JOIN members m ON m.user_id=r.user_id
      ${cmd.name === "rank" ? "WHERE r.user_id=?" : ""} GROUP BY r.user_id,m.name ORDER BY xp DESC,r.user_id LIMIT 10`).bind(...cmd.name === "rank" ? [user.id] : []).all();
    await say(env, u.update_id, m, result.results.length ? "Participation rewards\n" + result.results.map((r, i) => `${i + 1}. ${r.name} \u2014 ${r.xp} XP`).join("\n") : "No rewards yet. Reply thoughtfully to another member or try /trivia. Rewards have cooldowns and daily caps.");
    return;
  }
  if (["trivia", "poll", "discuss"].includes(cmd?.name || "")) {
    if (!await takeQuota(env, `prompt:${u.update_id}`, m, "prompt", 12, 60)) {
      await say(env, u.update_id, m, "Let\u2019s give members time to join the current conversation. Try again later.");
      return;
    }
    const index = Math.abs(u.update_id);
    const thread = await topicThread(env,'lore');
    const destination = m.chat.type === "private" ? groupTarget(env) : {chat_id:Number(env.GROUP_ID),...(thread ? {message_thread_id:thread}:{})};
    if (cmd.name === "discuss") {
      await send(env, u.update_id, "sendMessage", {...destination, text:discussions_default[index % discussions_default.length].prompt + "\n\nWhat\u2019s your take, and which scene supports it? Different views are welcome."});
      return;
    }
    if (cmd.name === "poll") {
      const p = polls_default[index % polls_default.length];
      await send(env, u.update_id, "sendPoll", { ...destination, question: p.question, options: p.options, is_anonymous: true });
      return;
    }
    const q = trivia_default[index % trivia_default.length];
    await send(env, u.update_id, "sendPoll", { ...destination, question: q.question, options: q.options, type: "quiz", correct_option_id: q.correct, is_anonymous: false, open_period: 60, explanation: `Answer: ${q.options[q.correct]}. First answer counts for rewards.` });
    return;
  }
  if (['guess','quote','weeklytrivia'].includes(cmd?.name)) {
    if (!await takeQuota(env,`game:${u.update_id}`,m,'prompt',12,60)) return;
    await proactive(env,u.update_id,{kind:{guess:'character',quote:'quote',weeklytrivia:'weekly'}[cmd.name],scheduled_at:clock(),requested:true},send,polls_default,trivia_default);return;
  }
  if (cmd?.name === "post") {
    if (!admins(env).includes(user.id)) return;
    const requested=cmd.arg.toLowerCase() || "question";
    const kind=KINDS.includes(requested)?requested:Object.keys(TOPICS).find(k=>TOPICS[k]===topicName(requested));
    if (!KINDS.includes(kind)) { await say(env, u.update_id, m, `Choose /post followed by: ${KINDS.join(", ")}. Memes are text/caption posts; wallpapers are design prompts. Event posts are planning ideas, not live listings.`); return; }
    if (!await takeQuota(env, `post:${u.update_id}`, m, "manual_post", 5, 60)) return;
    await proactive(env, u.update_id, {kind, scheduled_at: clock(), requested: true}, send, polls_default, trivia_default);
    return;
  }
  const direct = cmd?.name === "ask" || !cmd && (m.chat.type === "private" || addressed(m, env));
  const ambient = !cmd && !direct && ambientCandidate(m, env, u.update_id);
  const wantsAI = direct || ambient;
  if (!wantsAI) {
    if (!cmd && m.chat.id === Number(env.GROUP_ID) && m.reply_to_message?.from && !m.reply_to_message.from.is_bot && m.reply_to_message.from.id !== user.id && text.length >= 20) await reward(env, `message:${u.update_id}`, user.id, 1, "conversation");
    return;
  }
  const question = cmd?.name === "ask" ? cmd.arg : text;
  if (!question) {
    await say(env, u.update_id, m, "Try /ask followed by a question, for example: What makes Andor feel different from the films?");
    return;
  }
  if (ambient && (!await quiet(env,m.message_thread_id||0,true) || !await reserveAmbient(env, u.update_id, m))) return;
  const cap = bounded(env.AI_DAILY_CAP, 60, 1, 100);
  if (!await takeQuota(env, `ai:${u.update_id}`, m, "ai", cap, direct ? 8 : 30)) {
    if (ambient) return;
    await say(env, u.update_id, m, "I\u2019m taking a short breather or have reached today\u2019s AI limit. You can still use /trivia, /poll and /discuss.");
    return;
  }
  const history = await env.DB.prepare("SELECT role,content FROM context WHERE chat_id=? AND thread_id=? AND created_at>? ORDER BY id DESC LIMIT 10").bind(m.chat.id, m.message_thread_id || 0, clock() - 86400).all();
  let parent = "";
  if (m.reply_to_message?.text && (!m.reply_to_message.from || !await optedOut(env, m.reply_to_message.from.id))) parent = m.reply_to_message.text.slice(0, 600);
  const userContent = `Member ${user.id} (${(user.first_name || "Member").slice(0, 60)}) says: ${question.slice(0, 1500)}${parent ? `
Reply context (untrusted): ${parent}` : ""}`;
  let answer;
  try {
    const sources = await Promise.all([currentRelease(env, "movie"), currentRelease(env, "game")]);
    const system = SYSTEM_PROMPT + await preferencePrompt(env,user.id) + `\nToday: ${new Date().toISOString().slice(0,10)}. Verified source snapshots: ${JSON.stringify(sources.filter(Boolean))}.` + (m.chat.type === "private" ? " This request was sent privately by the group owner, but your answer is published in the group. Write a self-contained response or requested post for the group; do not quote private messages, disclose private conversation history or refer to private instructions." : "") + (ambient ? " You are joining an existing conversation uninvited: offer a useful specific observation in 1–2 sentences; do not interrogate the members." : "");
    const result = await env.AI.run(env.AI_MODEL, { messages: [{ role: "system", content: system }, ...history.results.reverse(), { role: "user", content: userContent }], max_tokens: 350, temperature: 0.8 }, { signal: AbortSignal.timeout(15e3) });
    answer = cleanAnswer(result.response);
    if (!answer) throw new Error("empty-ai");
  } catch {
    if (ambient) return;
    await say(env, u.update_id, m, "I couldn\u2019t generate an answer just now. Please try later; /discuss, /poll and /trivia still work.");
    return;
  }
  if (await optedOut(env, user.id) || await setting(env, "paused") === "1") return;
  await say(env, u.update_id, m, answer);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO context(user_id,chat_id,thread_id,role,content,created_at) VALUES (?,?,?,?,?,?)").bind(user.id, m.chat.id, m.message_thread_id || 0, "user", userContent, clock()),
    env.DB.prepare("INSERT INTO context(user_id,chat_id,thread_id,role,content,created_at) VALUES (?,?,?,?,?,?)").bind(user.id, m.chat.id, m.message_thread_id || 0, "assistant", answer, clock())
  ]);
  if (m.chat.type === "private") {
    const target = groupTarget(env);
    await env.DB.prepare("INSERT INTO context(user_id,chat_id,thread_id,role,content,created_at) VALUES (?,?,?,?,?,?)").bind(user.id,target.chat_id,target.message_thread_id || 0,"assistant",answer,clock()).run();
  }
}
async function processUpdate(env, id) {
  const claimed = await env.DB.prepare(`UPDATE updates SET state='processing',attempts=attempts+1,lease_until=?
    WHERE id=? AND attempts<3 AND ready_at<=? AND (state='queued' OR (state='processing' AND lease_until<?)) RETURNING payload,outbound,method`).bind(clock() + 90, id, clock(), clock()).first();
  if (!claimed) return;
  try {
    const payload = JSON.parse(claimed.payload);
    payload.update_id = id;
    if (claimed.outbound && claimed.method) {
      // A queued delivery must still honor a later pause/opt-out.
      if (await setting(env, "paused") === "1" || payload.message?.from && await optedOut(env, payload.message.from.id)) { await mark(env, id, "done"); return; }
      if (payload.internal_post && (env.PROACTIVE_ENABLED === "false" || clock() - payload.internal_post.scheduled_at > 3600)) { await mark(env, id, "done"); return; }
      if (payload.internal_post || payload.internal_followup) {
        const body = JSON.parse(claimed.outbound);
        const autonomous = payload.internal_followup || !payload.internal_post.requested;
        if (payload.internal_post && !payload.internal_post.requested && await starterCount(env,id)>=(await postingPolicy(env)).target) {await mark(env,id,'done');return;}
        if (payload.internal_followup && (env.PROACTIVE_ENABLED === 'false' || clock() - (await env.DB.prepare('SELECT closes_at FROM community_polls WHERE poll_id=?').bind(payload.internal_followup).first())?.closes_at > 86400)) {await mark(env,id,'done');return;}
        if (payload.internal_post && !payload.internal_post.requested && await starterSpacingBlocked(env,id)) {await defer(env,id);return;}
        if (autonomous && (!activeHours() || !await quiet(env,body.message_thread_id||0))) {await defer(env,id);return;}
      }
      const delivered = await send(env, id, claimed.method, JSON.parse(claimed.outbound));
      await env.DB.prepare("UPDATE engagement_posts SET message_id=?,state='sent' WHERE update_id=?").bind(delivered.message_id, id).run();
    } else await handle(env, payload);
    const after = await env.DB.prepare('SELECT state FROM updates WHERE id=?').bind(id).first();
    if (after?.state !== 'queued') await mark(env, id, "done");
  } catch {
    const state = await env.DB.prepare("SELECT state,attempts FROM updates WHERE id=?").bind(id).first();
    if (state?.state === "sending") await mark(env, id, "uncertain", "delivery-or-recording-uncertain");
    else if (state?.state === "queued" && state.attempts >= 3) await mark(env, id, "failed", "retry-exhausted");
    else if (state?.state === "processing") {
      if (state.attempts >= 3) await mark(env, id, "failed", "processing-failed");
      else await env.DB.prepare("UPDATE updates SET state='queued',ready_at=?,error='processing-failed' WHERE id=?").bind(clock() + 60, id).run();
    }
  }
}
async function maintenance(env) {
  await scheduleProactive(env);
  await scheduleFollowups(env);
  await env.DB.prepare("UPDATE updates SET state='uncertain',payload='{}',outbound=NULL,method=NULL,error='send-interrupted' WHERE state='sending' AND lease_until<?").bind(clock()).run();
  const pending = await env.DB.prepare("SELECT id FROM updates WHERE attempts<3 AND ready_at<=? AND (state='queued' OR (state='processing' AND lease_until<?)) ORDER BY id LIMIT 3").bind(clock(), clock()).all();
  for (const item of pending.results) await processUpdate(env, item.id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM engagement_posts WHERE created_at<?").bind(clock() - 30 * 86400),
    env.DB.prepare("DELETE FROM context WHERE created_at<?").bind(clock() - 86400),
    env.DB.prepare("DELETE FROM quota WHERE created_at<?").bind(clock() - 172800),
    env.DB.prepare("DELETE FROM answers WHERE poll_id IN (SELECT poll_id FROM polls WHERE expires_at<?)").bind(clock() - 604800),
    env.DB.prepare("DELETE FROM polls WHERE expires_at<?").bind(clock() - 604800),
    env.DB.prepare("DELETE FROM updates WHERE created_at<?").bind(clock() - 604800),
    env.DB.prepare("UPDATE updates SET payload='{}',outbound=NULL,method=NULL,state='failed',error='expired' WHERE created_at<? AND state IN ('queued','processing')").bind(clock() - 86400)
  ]);
}
var index_default = {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === "/healthz" && request.method === "GET") {
      try {
        await env.DB.prepare("SELECT 1").first();
        return Response.json({ status: "ok", mode: "engaging", version: VERSION, configured: Boolean(env.BOT_TOKEN && env.WEBHOOK_SECRET && Number(env.GROUP_ID) < 0) });
      } catch {
        return Response.json({ status: "unavailable" }, { status: 503 });
      }
    }
    if (path !== "/telegram" || request.method !== "POST") return new Response("Not found", { status: 404 });
    if (!env.WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return new Response("Unauthorized", { status: 401 });
    if (!env.BOT_TOKEN) return new Response("Not configured", { status: 503 });
    if (Number(request.headers.get("Content-Length") || 0) > 65536) return new Response("Too large", { status: 413 });
    const raw = await request.text();
    if (raw.length > 65536) return new Response("Too large", { status: 413 });
    let u;
    try {
      u = JSON.parse(raw);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (!Number.isSafeInteger(u.update_id)) return new Response("Invalid update", { status: 400 });
    if (u.message) {
      if (!u.message.from || !u.message.chat || !Number.isSafeInteger(u.message.message_id) || !allowed(u.message, env) || u.message.from.is_bot) return new Response("OK");
      const m = u.message;
      if (m.date && m.date < clock() - 3600) return new Response("OK");
      u = { update_id: u.update_id, message: { message_id: m.message_id, chat: m.chat, from: m.from, text: m.text?.slice(0, 2500), message_thread_id: m.message_thread_id, reply_to_message: m.reply_to_message ? { message_id: m.reply_to_message.message_id, from: m.reply_to_message.from, text: m.reply_to_message.text?.slice(0, 600) } : void 0 } };
      const text = u.message.text || "";
      const c = command(text, env.BOT_USERNAME);
      if (await optedOut(env, m.from.id) && !["privacy", "optout", "optin", "forget"].includes(c?.name || "")) return new Response("OK");
      if (m.chat.id === Number(env.GROUP_ID)) {
        if (!text.startsWith('/') && text.trim().length>=12 && !await optedOut(env,m.from.id)) await recordEngagement(env,m.from.id,m.message_thread_id||0,addressed(u.message,env));
        await env.DB.prepare('INSERT OR IGNORE INTO activity(update_id,thread_id,created_at) VALUES (?,?,?)').bind(u.update_id,m.message_thread_id||0,clock()).run();
        const discoveredTopic=topicName(m.forum_topic_created?.name || m.forum_topic_edited?.name);
        if (discoveredTopic && Number.isSafeInteger(m.message_thread_id)) await env.DB.prepare('INSERT INTO topic_map(name,thread_id) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET thread_id=excluded.thread_id').bind(discoveredTopic,m.message_thread_id).run();
      }
      if (u.message.reply_to_message?.from && await optedOut(env, u.message.reply_to_message.from.id)) delete u.message.reply_to_message.text;
      if (m.chat.type !== "private" && !c && !addressed(u.message, env) && !ambientCandidate(u.message, env, u.update_id)) {
        if ((await env.DB.prepare("SELECT value FROM settings WHERE key='paused'").first())?.value !== "1" && !text.startsWith("/") && text.length >= 20 && m.reply_to_message?.from && !m.reply_to_message.from.is_bot && m.reply_to_message.from.id !== m.from.id && !await optedOut(env, m.from.id)) {
          await member(env, m.from);
          await reward(env, `message:${u.update_id}`, m.from.id, 1, "conversation");
        }
        return new Response("OK");
      }
    } else if (u.poll && typeof u.poll.id === 'string' && Array.isArray(u.poll.options)) {
      u={update_id:u.update_id,poll:{id:u.poll.id,is_closed:u.poll.is_closed===true,options:u.poll.options.slice(0,12).map(p=>({text:String(p.text).slice(0,100),voter_count:p.voter_count}))}};
    } else if (u.poll_answer?.user && Array.isArray(u.poll_answer.option_ids)) {
      u = { update_id: u.update_id, poll_answer: { poll_id: u.poll_answer.poll_id, user: u.poll_answer.user, option_ids: u.poll_answer.option_ids.slice(0, 1) } };
    } else return new Response("OK");
    await env.DB.prepare("INSERT OR IGNORE INTO updates(id,payload,created_at) VALUES (?,?,?)").bind(u.update_id, JSON.stringify(u), clock()).run();
    ctx.waitUntil(processUpdate(env, u.update_id));
    return new Response("OK");
  },
  async scheduled(_event, env) {
    await maintenance(env);
    await refreshReleases(env);
  }
};
export {
  SYSTEM_PROMPT,
  addressed,
  groupDelivery,
  groupTarget,
  command,
  index_default as default,
  maintenance,
  processUpdate
};
