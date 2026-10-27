import { nowSeconds, activeHours, setting, cleanAnswer } from './engagement.mjs';
export const TOPICS = {game:'gaming',movie:'movies',question:'lore',poll:'lore',idea:'lore',character:'lore',quote:'lore',weekly:'lore'};
export async function topicThread(env, kind) {
  const mapped = await env.DB.prepare('SELECT thread_id FROM topic_map WHERE name=?').bind(TOPICS[kind] || kind).first();
  const allowed = (env.ALLOWED_THREAD_IDS || '').split(',').filter(Boolean).map(Number);
  const thread = mapped?.thread_id ?? Number(env.PROACTIVE_THREAD_ID || allowed[0] || 0);
  if (!Number.isSafeInteger(thread) || thread < 0 || allowed.length && !allowed.includes(thread)) throw Error('topic-not-allowed');
  return thread;
}
export async function topicSummary(env) {
  const rows = (await env.DB.prepare('SELECT name,thread_id FROM topic_map ORDER BY name').all()).results;
  return rows.length ? rows.map(r=>`${r.name}: topic ${r.thread_id || 'General'}`).join('\n') : 'No named topics mapped yet. Admins: use /bindtopic gaming, movies or lore inside the corresponding topic.';
}
export async function quiet(env, thread, ambient=false) {
  const row = await env.DB.prepare('SELECT COUNT(*) n,MAX(created_at) latest FROM activity WHERE thread_id=? AND created_at>?').bind(thread,nowSeconds()-600).first();
  return ambient ? row.n < 4 : !row.latest;
}
export async function defer(env,id) {
  await env.DB.prepare("UPDATE updates SET state='queued',ready_at=?,attempts=MAX(0,attempts-1),lease_until=0 WHERE id=?").bind(nowSeconds()+300,id).run();
}
export async function preferencesCommand(env,id,m,cmd,say) {
  if (!['preferences','era','spoilers'].includes(cmd?.name)) return false;
  const eras=['any','prequels','original','sequels','high-republic','old-republic','legends'];
  if (cmd.name==='preferences' && cmd.arg==='off') {
    await env.DB.prepare('DELETE FROM fan_preferences WHERE user_id=?').bind(m.from.id).run();
    await say(env,id,m,'Your saved era and spoiler preferences have been deleted.');return true;
  }
  if (cmd.name==='preferences' && cmd.arg==='on') await env.DB.prepare('INSERT OR IGNORE INTO fan_preferences(user_id) VALUES (?)').bind(m.from.id).run();
  const p=await env.DB.prepare('SELECT era,spoilers FROM fan_preferences WHERE user_id=?').bind(m.from.id).first();
  if (!p) {await say(env,id,m,'Preferences are off. Use /preferences on to opt in, then /era <era> and /spoilers avoid|allow. Preferences affect public group replies; private instructions are not quoted.');return true;}
  if (cmd.name==='era' || cmd.name==='spoilers') {
    const valid=cmd.name==='era'?eras:['avoid','allow'];
    if (!valid.includes(cmd.arg)) {await say(env,id,m,`Choose /${cmd.name} ${valid.join(' | ')}`);return true;}
    await env.DB.prepare(`UPDATE fan_preferences SET ${cmd.name}=? WHERE user_id=?`).bind(cmd.arg,m.from.id).run();p[cmd.name]=cmd.arg;
  }
  await say(env,id,m,`Saved preferences: era ${p.era}; spoilers ${p.spoilers}. /preferences off deletes them. Spoiler details are only allowed when everyone with saved preferences in this group permits them; otherwise replies stay spoiler-free.`);return true;
}
export async function preferencePrompt(env,user) {
  const p=await env.DB.prepare('SELECT era,spoilers FROM fan_preferences WHERE user_id=?').bind(user).first();
  const avoid=await env.DB.prepare("SELECT 1 FROM fan_preferences f WHERE spoilers='avoid' AND NOT EXISTS(SELECT 1 FROM preferences p WHERE p.user_id=f.user_id AND p.opted_out=1) LIMIT 1").first();
  return ` Public group spoiler policy: ${p?.spoilers==='allow'&&!avoid?'the requester opted in; warn before plot spoilers and only include them if explicitly requested':'no plot twists, deaths or endings; keep this answer spoiler-free even if asked for spoilers'}.`+(p?` This member explicitly saved favorite era: ${p.era}. Use it only when relevant, never announce their stored preferences.`:'');
}
export async function recordPoll(env,id,body,result) {
  if (!result?.poll?.id || body.type==='quiz') return;
  await env.DB.prepare('INSERT OR IGNORE INTO community_polls(poll_id,message_id,thread_id,question,options,closes_at,followup_id) VALUES (?,?,?,?,?,?,?)')
    .bind(result.poll.id,result.message_id,body.message_thread_id||0,body.question,JSON.stringify(result.poll.options || body.options.map(text=>({text,voter_count:0}))),nowSeconds()+600,-4000000000000-Math.abs(id)).run();
}
export async function receivePoll(env,poll) {
  // Only polls sent and recorded by this bot are accepted; only final totals authorize a follow-up.
  if (!poll.is_closed || !Array.isArray(poll.options)) return;
  const known=await env.DB.prepare('SELECT options FROM community_polls WHERE poll_id=?').bind(poll.id).first();
  if (!known) return;
  const expected=JSON.parse(known.options);
  if (poll.options.length!==expected.length || poll.options.some((p,i)=>p.text!==expected[i].text || !Number.isSafeInteger(p.voter_count) || p.voter_count<0)) return;
  await env.DB.prepare('UPDATE community_polls SET options=?,closed=1 WHERE poll_id=?').bind(JSON.stringify(poll.options.map(p=>({text:p.text,voter_count:p.voter_count}))),poll.id).run();
}
export async function scheduleFollowups(env) {
  if (env.PROACTIVE_ENABLED==='false'||await setting(env,'paused')==='1') return;
  const polls=(await env.DB.prepare('SELECT * FROM community_polls WHERE closes_at<=? AND closes_at>?').bind(nowSeconds(),nowSeconds()-86400).all()).results;
  for(const p of polls) await env.DB.prepare('INSERT OR IGNORE INTO updates(id,payload,created_at) VALUES (?,?,?)').bind(p.followup_id,JSON.stringify({internal_followup:p.poll_id}),nowSeconds()).run();
  await env.DB.prepare('DELETE FROM activity WHERE created_at<?').bind(nowSeconds()-86400).run();
  await env.DB.prepare('DELETE FROM community_polls WHERE closes_at<?').bind(nowSeconds()-7*86400).run();
}
export function pollResult(p) {
  const options=JSON.parse(p.options),max=Math.max(...options.map(o=>o.voter_count));
  if (!max) return `No votes landed for “${p.question}”. I'll retire this one and leave the floor to you.`;
  const winners=options.filter(o=>o.voter_count===max);
  return `${winners.length>1?'A tie':'The winning choice'} in “${p.question}”: ${winners.map(o=>o.text).join(' / ')} (${max} vote${max===1?'':'s'}${winners.length>1?' each':''}).`;
}
export async function followup(env,id,pollId,send,personality) {
  if (env.PROACTIVE_ENABLED==='false'||await setting(env,'paused')==='1') return;
  const p=await env.DB.prepare('SELECT * FROM community_polls WHERE poll_id=?').bind(pollId).first();
  if (!p || nowSeconds()-p.closes_at>86400) return;
  if (!activeHours()||!await quiet(env,p.thread_id)) {await defer(env,id);return;}
  if (!p.closed) {
    // stopPoll is idempotent in effect. A lost response never authorizes invented results.
    const res=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/stopPoll`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:Number(env.GROUP_ID),message_id:p.message_id}),signal:AbortSignal.timeout(8000)});
    const data=await res.json();
    if (data.ok) await receivePoll(env,data.result);
    const refreshed=await env.DB.prepare('SELECT * FROM community_polls WHERE poll_id=?').bind(pollId).first();
    if (!refreshed.closed) throw Error('final-poll-results-unavailable');
    Object.assign(p,refreshed);
  }
  const result=pollResult(p),hasVotes=JSON.parse(p.options).some(o=>o.voter_count>0);
  let discussion='';
  if(hasVotes) {
    discussion='That choice has the votes; now it needs a defence. What is its strongest drawback, and which alternative handles it better?';
    try {
      const r=await env.AI.run(env.AI_MODEL,{messages:[{role:'system',content:personality+' Keep this public post spoiler-free.'},{role:'user',content:`Verified poll result: ${result}\nIn two sentences, give one concrete strength and one tradeoff of the winning choice (or compare the tied choices), then invite a counterargument. Do not repeat counts or invent voters or reasons they voted.`}],max_tokens:160,temperature:0.8},{signal:AbortSignal.timeout(15000)});
      discussion=cleanAnswer(r.response,650)||discussion;
    }catch{/* factual result and an invitation remain available without AI */}
  }
  if(await setting(env,'paused')==='1')return;
  if(!await quiet(env,p.thread_id)){await defer(env,id);return;}
  await send(env,id,'sendMessage',{chat_id:Number(env.GROUP_ID),...(p.thread_id?{message_thread_id:p.thread_id}:{}),reply_parameters:{message_id:p.message_id,allow_sending_without_reply:true},text:result+(discussion?'\n\n'+discussion:'')});
}
// Short, recognisable lines; no plot twists or endings in the challenges.
const CHARACTERS=[
 ['Character guess: Astromech. Blue panels. Has very strong opinions about your repair technique.',['R2-D2','C-3PO','K-2SO','IG-11'],0],
 ['Character guess: Protocol specialist. Gold plating. Fluent in more languages than your translation app.',['BB-8','C-3PO','Chopper','BD-1'],1],
 ['Character guess: Wookiee co-pilot. Bowcaster enthusiast. Probably too tall for this cantina.',['Zeb','Bossk','Chewbacca','Yoda'],2],
 ['Character guess: Bounty hunter. Mandalorian armour. His ship used to be called the Razor Crest.',['Din Djarin','Han Solo','Cassian Andor','Lando Calrissian'],0]
];
const QUOTES=[
 ['Quote challenge: Who says “Do. Or do not. There is no try.”?',['Obi-Wan Kenobi','Yoda','Qui-Gon Jinn','Luke Skywalker'],1],
 ['Quote challenge: Who calls someone a “scruffy-looking nerf herder”?',['Leia Organa','Padmé Amidala','Rey','Ahsoka Tano'],0],
 ['Quote challenge: Who says “Hello there!” to General Grievous?',['Anakin Skywalker','Mace Windu','Obi-Wan Kenobi','Count Dooku'],2]
];
export function recurringKind(day) {
 const weekday=new Date(day+'T12:00:00Z').getUTCDay();
 return weekday===1?'weekly':weekday%2?'quote':'character';
}
export async function gamePost(env,kind,trivia) {
 const rows=(await env.DB.prepare('SELECT seed FROM engagement_posts WHERE kind=? ORDER BY created_at DESC LIMIT 20').bind(kind).all()).results;
 const pool=kind==='weekly'?trivia.filter(q=>! /destroyed|killed|dies|death of|father|betray/i.test(q.question)).map(q=>['Weekly trivia: '+q.question,q.options,q.correct]):kind==='quote'?QUOTES:CHARACTERS;
 const unused=pool.map((q,i)=>({q,i})).filter(x=>!rows.some(r=>r.seed===`${kind}:${x.i}`));
 const chosen=unused.length?unused[Math.floor(Math.random()*unused.length)]:{q:pool[(Number(rows[0]?.seed.split(':')[1]||0)+1)%pool.length],i:(Number(rows[0]?.seed.split(':')[1]||0)+1)%pool.length};
 return {question:chosen.q[0],options:chosen.q[1],correct:chosen.q[2],seed:`${kind}:${chosen.i}`,generation:'curated'};
}
