import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { processUpdate, addressed, maintenance } from '../index.mjs';
import { makePlan, activeHours, localDay, ambientCandidate, reserveAmbient, releaseCard, validPoll, scheduleProactive, buildPost, currentRelease } from '../engagement.mjs';

let env, sqlite, sent, aiCalls, waits, originalFetch, originalNow;
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0002_engagement.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0003_community.sql', import.meta.url), 'utf8'));
  const adapter = { prepare(sql) { let args=[]; const statement={bind(...a){args=a;return statement;},async first(){return db.prepare(sql).get(...args) || null;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:r.changes}};}};return statement;}, async batch(items){return Promise.all(items.map(s=>s.run()));}};
  return [db,adapter];
}
beforeEach(() => {
  originalNow=Date.now; Date.now=()=>Date.parse('2026-10-27T06:00:00Z');
  [sqlite,env] = database();
  env={DB:env, GROUP_ID:'-100123',BOT_TOKEN:'123:fake',BOT_USERNAME:'SIU_M8_bot',WEBHOOK_SECRET:'test-secret',ADMIN_USER_IDS:'42', AI_DAILY_CAP:'60', AI_MODEL:'test',AI:{async run(model,request){aiCalls.push(request); return {response:'Chopper would get the job done, then invoice you for emotional damages. R2 is my pick for reliability.'};}}};
  sent=[];aiCalls=[];waits=[];originalFetch=globalThis.fetch;
  globalThis.fetch=async (url,options)=>{const body=JSON.parse(options.body);sent.push({method:String(url).split('/').at(-1),body});return Response.json({ok:true,result:{message_id:900+sent.length}});};
});
afterEach(()=>{globalThis.fetch=originalFetch;Date.now=originalNow;sqlite.close();});
function update(id=1,text='@SIU_M8_bot Which droid would be the best coworker?',extra={}) {return {update_id:id,message:{message_id:id,date:Math.floor(Date.now()/1000),chat:{id:-100123,type:'supergroup'},from:{id:42,first_name:'Test member',is_bot:false},text,...extra}};}
async function webhook(u) { const response=await worker.fetch(new Request('https://test/telegram',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'test-secret'},body:JSON.stringify(u)}),env,{waitUntil(p){waits.push(p);}});await Promise.all(waits.splice(0));return response; }
async function queue(id,payload) {sqlite.prepare('INSERT INTO updates(id,payload,created_at) VALUES (?,?,?)').run(id,JSON.stringify(payload),Math.floor(Date.now()/1000));await processUpdate(env,id);}

test('random plans stay in HK active hours, have 3–5 posts and at least 2h gaps',()=>{
 for(let i=0;i<1000;i++){const p=makePlan('2026-10-27');assert.ok(p.length>=3&&p.length<=5);assert.equal(new Set(p.map(s=>s.kind)).size,p.length);p.forEach((s,j)=>{assert.ok(activeHours(s.at));assert.equal(localDay(s.at),'2026-10-27');if(j)assert.ok(s.at-p[j-1].at>=7200);});}
});
test('plain group mention gets contextual AI reply and duplicate delivery is suppressed',async()=>{
 await webhook(update());await webhook(update());assert.equal(sent.length,1);assert.equal(aiCalls.length,1);assert.equal(sent[0].body.reply_parameters.message_id,1);assert.match(aiCalls[0].messages[0].content,/cantina droid/);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM context').get().n,2);
});
test('replies to this bot are addressed but replies to other bots are not',()=>{
 assert.ok(addressed(update(1,'yes',{reply_to_message:{from:{id:123,is_bot:true}}}).message,env));assert.ok(!addressed(update(1,'yes',{reply_to_message:{from:{id:999,is_bot:true}}}).message,env));
});
test('follow-up contains parent text and conversation history',async()=>{
 await webhook(update());Date.now=()=>Date.parse('2026-10-27T06:01:00Z');await webhook(update(2,'But would R2 be any good at meetings?',{reply_to_message:{message_id:901,from:{id:123,is_bot:true},text:sent[0].body.text}}));assert.equal(sent.length,2);assert.ok(aiCalls[1].messages.some(m=>m.role==='assistant'));assert.match(aiCalls[1].messages.at(-1).content,/Reply context/);
});
test('privacy opt-out and wrong group prevent AI and context storage',async()=>{
 sqlite.prepare('INSERT INTO preferences VALUES (42,1)').run();await webhook(update());await webhook(update(2,'@SIU_M8_bot hello',{chat:{id:-100999,type:'supergroup'}}));assert.equal(sent.length,0);assert.equal(aiCalls.length,0);
});
test('pause stops replies and internal proactive jobs',async()=>{
 sqlite.prepare("INSERT INTO settings VALUES ('paused','1')").run();await webhook(update());await queue(-1,{internal_post:{kind:'question',scheduled_at:Date.now()/1000}});assert.equal(sent.length,0);
});
test('public webhook cannot inject internal jobs',async()=>{
 await webhook({update_id:5,internal_post:{kind:'poll',scheduled_at:Date.now()/1000}});assert.equal(sent.length,0);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM updates').get().n,0);
});
test('ambient sampling is stable and cooldown is atomic across users',async()=>{
 const m=update().message;assert.equal(ambientCandidate(m,env,44),ambientCandidate(m,env,44));assert.equal(ambientCandidate({...m,text:'hi'},env,44),false);assert.equal(await reserveAmbient(env,1,m),true);assert.equal(await reserveAmbient(env,2,{...m,from:{id:43}}),false);
});
test('an ordinary relevant message can reach the AI through the webhook',async()=>{
 env.AMBIENT_REPLY_CHANCE='0.4';const text='What makes a Star Wars game feel like Star Wars to you?';let id=100;while(!ambientCandidate(update(id,text).message,env,id))id++;await webhook(update(id,text));assert.equal(aiCalls.length,1);assert.equal(sent.length,1);
});
test('AI failure stays silent for ambient messages, helpful for direct requests',async()=>{
 env.AI.run=async()=>{throw Error('offline');};env.AMBIENT_REPLY_CHANCE='0.4';let id=100;while(!ambientCandidate(update(id,'Which Star Wars game is worth replaying?').message,env,id))id++;await webhook(update(id,'Which Star Wars game is worth replaying?'));assert.equal(sent.length,0);Date.now=()=>Date.parse('2026-10-27T06:01:00Z');await webhook(update(999));assert.equal(sent.length,1);assert.match(sent[0].body.text,/couldn/);
});
test('proactive native poll is delivered once and logged',async()=>{
 env.AI.run=async()=>({response:JSON.stringify({question:'Which droid gets the promotion?',options:['R2-D2','Chopper','BD-1']})});await queue(-1,{internal_post:{kind:'poll',scheduled_at:Date.now()/1000}});await processUpdate(env,-1);assert.equal(sent.length,1);assert.equal(sent[0].method,'sendPoll');assert.equal(sqlite.prepare('SELECT state FROM engagement_posts').get().state,'sent');
});
test('scheduled posts respect gap, but an explicit admin /post can request one',async()=>{
 await queue(-1,{internal_post:{kind:'movie',scheduled_at:Date.now()/1000}});await queue(-2,{internal_post:{kind:'idea',scheduled_at:Date.now()/1000}});assert.equal(sent.length,1);await webhook(update(10,'/post poll'));assert.equal(sent.length,2);
});
test('movie cards are sourced, future dated and expire instead of inventing news',async()=>{
 await queue(-1,{internal_post:{kind:'movie',scheduled_at:Date.now()/1000}});assert.match(sent[0].body.text,/May 28, 2027/);assert.match(sent[0].body.text,/https:\/\/www.starwars.com/);assert.equal(releaseCard('movie',Date.parse('2027-06-01')/1000),undefined);assert.equal(releaseCard('game',Date.parse('2026-12-01')/1000),undefined);
});
test('changed release cache supersedes original seeded date',async()=>{
 sqlite.prepare('INSERT INTO settings VALUES (?,?)').run('release:movie',JSON.stringify({date:'2026-10-26',checked:'2026-10-27'}));assert.equal(await currentRelease(env,'movie'),null);
});
test('scheduler keeps a durable plan, does not duplicate jobs or replay old slots',async()=>{
 const at=Date.now()/1000;sqlite.prepare('INSERT INTO settings VALUES (?,?)').run('plan:2026-10-27',JSON.stringify([{at:at-60,kind:'idea'},{at:at-7200,kind:'poll'}]));await scheduleProactive(env);await scheduleProactive(env);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM updates').get().n,1);assert.equal(sqlite.prepare('SELECT id FROM updates').get().id,-(at-60));
});
test('429 retries the stored outbound payload without another model call',async()=>{
 let attempts=0;globalThis.fetch=async(url,options)=>{sent.push(JSON.parse(options.body));attempts++;return Response.json(attempts===1?{ok:false,error_code:429,parameters:{retry_after:2}}:{ok:true,result:{message_id:900}});};await webhook(update());assert.equal(sqlite.prepare('SELECT state FROM updates').get().state,'queued');Date.now=()=>Date.parse('2026-10-27T06:00:03Z');await processUpdate(env,1);assert.equal(aiCalls.length,1);assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1]);assert.equal(sqlite.prepare('SELECT state FROM updates').get().state,'done');
});
test('uncertain delivery is not resent',async()=>{
 globalThis.fetch=async()=>{throw Error('connection lost');};await webhook(update());assert.equal(sqlite.prepare('SELECT state FROM updates').get().state,'uncertain');await processUpdate(env,1);assert.equal(aiCalls.length,1);
});
test('invalid generated poll falls back to validated curated options',async()=>{
 env.AI.run=async()=>({response:'{"question":"Wrong","options":["same","same"]}'});const post=await buildPost(env,'poll',[{question:'Which droid would you hire?',options:['R2-D2','BD-1']}]);assert.ok(validPoll(post));
});
test('expired proactive jobs and quiet hours never post automatically',async()=>{
 await queue(-1,{internal_post:{kind:'idea',scheduled_at:Date.now()/1000-7200}});Date.now=()=>Date.parse('2026-10-27T18:00:00Z');await queue(-2,{internal_post:{kind:'idea',scheduled_at:Date.now()/1000}});assert.equal(sent.length,0);
});
test('pause arriving during AI generation prevents the outgoing reply',async()=>{
 env.AI.run=async()=>{sqlite.prepare("INSERT INTO settings VALUES ('paused','1')").run();return {response:'An answer that must not be sent.'};};await webhook(update());assert.equal(sent.length,0);
});
test('pause arriving during proactive generation prevents delivery',async()=>{
 env.AI.run=async()=>{sqlite.prepare("INSERT INTO settings VALUES ('paused','1')").run();return {response:'Which droid would make the worst flatmate?'};};await queue(-1,{internal_post:{kind:'question',scheduled_at:Date.now()/1000}});assert.equal(sent.length,0);
});
test('daily autonomous cap remains effective for explicitly requested posts',async()=>{
 let generated=0;env.AI.run=async()=>({response:`Creative prompt number ${++generated}: invent your ideal companion droid.`});
 for(let i=0;i<6;i++){await queue(-100-i,{internal_post:{kind:i%2?'game':'movie',scheduled_at:Date.now()/1000,requested:true}});Date.now=()=>Date.parse('2026-10-27T06:00:00Z')+(i+1)*1000;}
 assert.equal(sent.length,5);
});

test('plain admin DM produces a group response without a private reply ID',async()=>{
 await webhook(update(200,'Which droid would you take on a road trip?',{chat:{id:42,type:'private'},message_thread_id:777}));
 assert.equal(aiCalls.length,1);assert.equal(sent.length,1);assert.equal(sent[0].body.chat_id,-100123);assert.equal(sent[0].body.reply_parameters,undefined);assert.equal(sent[0].body.message_thread_id,undefined);
 assert.match(aiCalls[0].messages[0].content,/published in the group/);
 const shared=sqlite.prepare('SELECT role,content FROM context WHERE chat_id=-100123').all();assert.equal(shared.length,1);assert.equal(shared[0].role,'assistant');
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM context WHERE chat_id=42').get().n,2);
});
test('non-admin private users cannot cause group posts',async()=>{
 await webhook(update(201,'/poll',{chat:{id:43,type:'private'},from:{id:43,first_name:'Other',is_bot:false}}));assert.equal(sent.length,0);
});
test('private commands including polls and quizzes always use the group destination',async()=>{
 for(const [i,cmd] of ['/help','/status','/poll','/trivia','/whereami','/privacy'].entries()){
  Date.now=()=>Date.parse('2026-10-27T06:00:00Z')+i*61000;
  await webhook(update(210+i,cmd,{chat:{id:42,type:'private'}}));
 }
 assert.equal(sent.length,6);for(const s of sent){assert.equal(s.body.chat_id,-100123);assert.equal(s.body.reply_parameters,undefined);}assert.equal(sent.filter(s=>s.method==='sendPoll').length,2);
});
test('private routing honors configured topics and does not inherit DM topic IDs',async()=>{
 env.ALLOWED_THREAD_IDS='17,23';env.PRIVATE_THREAD_ID='23';
 await webhook(update(230,'/poll',{chat:{id:42,type:'private'},message_thread_id:999}));assert.equal(sent[0].body.chat_id,-100123);assert.equal(sent[0].body.message_thread_id,23);
});
test('invalid private topic routing fails closed without posting to a DM',async()=>{
 env.ALLOWED_THREAD_IDS='17';env.PRIVATE_THREAD_ID='23';await webhook(update(231,'/help',{chat:{id:42,type:'private'}}));assert.equal(sent.length,0);
});
test('group replies retain the original group topic and reply target',async()=>{
 await webhook(update(240,undefined,{message_thread_id:17}));assert.equal(sent[0].body.chat_id,-100123);assert.equal(sent[0].body.message_thread_id,17);assert.equal(sent[0].body.reply_parameters.message_id,240);
});
test('private delivery retries retain the group destination',async()=>{
 let attempts=0;globalThis.fetch=async(url,options)=>{sent.push({body:JSON.parse(options.body)});return Response.json(++attempts===1?{ok:false,error_code:429,parameters:{retry_after:2}}:{ok:true,result:{message_id:987}});};
 await webhook(update(250,'/help',{chat:{id:42,type:'private'}}));Date.now=()=>Date.parse('2026-10-27T06:00:03Z');await processUpdate(env,250);assert.equal(sent.length,2);for(const s of sent){assert.equal(s.body.chat_id,-100123);assert.equal(s.body.reply_parameters,undefined);}
});
test('private follow-ups retain their own history without exposing prompts to group history',async()=>{
 await webhook(update(260,'I like exploration, what should I play?',{chat:{id:42,type:'private'}}));Date.now=()=>Date.parse('2026-10-27T06:01:00Z');await webhook(update(261,'And if I want less combat?',{chat:{id:42,type:'private'}}));assert.equal(sent.length,2);assert.ok(aiCalls[1].messages.some(m=>m.role==='user'&&m.content.includes('I like exploration')));
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM context WHERE chat_id=-100123 AND role='user'").get().n,0);
});

// New community features exercise real SQL, queue transitions and webhook sanitisation.
import { pollResult, receivePoll, recurringKind, preferencePrompt } from '../community.mjs';
test('busy topic defers a scheduled post without exhausting retries, then sends after quiet',async()=>{
 await webhook(update(100,'hello everyone'));await queue(-10,{internal_post:{kind:'idea',scheduled_at:Date.now()/1000}});
 assert.equal(sent.length,0);assert.equal(sqlite.prepare('SELECT state,attempts FROM updates WHERE id=-10').get().state,'queued');
 Date.now=()=>Date.parse('2026-10-27T06:05:01Z');await processUpdate(env,-10);assert.equal(sent.length,0);
 assert.equal(sqlite.prepare('SELECT attempts FROM updates WHERE id=-10').get().attempts,0);
 Date.now=()=>Date.parse('2026-10-27T06:11:00Z');await processUpdate(env,-10);assert.equal(sent.length,1);
 assert.equal(sqlite.prepare('SELECT state FROM updates WHERE id=-10').get().state,'done');
});
test('activity metadata is deduplicated and lively conversations suppress ambient interruptions',async()=>{
 env.AMBIENT_REPLY_CHANCE='0.4';for(let i=1;i<=4;i++)await webhook(update(i,'hello everyone'));await webhook(update(1,'hello everyone'));
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM activity').get().n,4);
 let id=100;while(!ambientCandidate(update(id,'Which Star Wars game would you pick?').message,env,id))id++;
 await webhook(update(id,'Which Star Wars game would you pick?'));assert.equal(aiCalls.length,0);
 assert.deepEqual(sqlite.prepare('PRAGMA table_info(activity)').all().map(x=>x.name),['update_id','thread_id','created_at']);
});
test('topic bindings require admins in group, then route gaming and movie starters independently',async()=>{
 await webhook(update(1,'/bindtopic gaming',{message_thread_id:12,from:{id:99}}));assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM topic_map').get().n,0);
 await webhook(update(2,'/bindtopic gaming',{message_thread_id:12}));await webhook(update(3,'/bindtopic movies',{message_thread_id:13}));
 sent=[];await queue(-10,{internal_post:{kind:'game',scheduled_at:Date.now()/1000,requested:true}});
 await queue(-11,{internal_post:{kind:'movie',scheduled_at:Date.now()/1000,requested:true}});
 assert.deepEqual(sent.map(x=>x.body.message_thread_id),[12,13]);
});
test('topic creation service messages learn names without sending content to AI',async()=>{
 await webhook(update(1,undefined,{text:undefined,message_thread_id:15,forum_topic_created:{name:'Lore'}}));assert.equal(sqlite.prepare("SELECT thread_id FROM topic_map WHERE name='lore'").get().thread_id,15);assert.equal(aiCalls.length,0);
});
test('busy Gaming does not block a quiet Movies topic',async()=>{
 sqlite.prepare('INSERT INTO topic_map VALUES (?,?)').run('movies',13);await webhook(update(1,'hello',{message_thread_id:12}));
 await queue(-10,{internal_post:{kind:'movie',scheduled_at:Date.now()/1000}});assert.equal(sent.length,1);assert.equal(sent[0].body.message_thread_id,13);
});
test('preferences require explicit opt-in, constrain spoilers, and forget deletes them',async()=>{
 await webhook(update(1,'/era prequels'));assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM fan_preferences').get().n,0);
 await webhook(update(2,'/preferences on'));await webhook(update(3,'/era prequels'));await webhook(update(4,'/spoilers avoid'));
 Date.now=()=>Date.parse('2026-10-27T06:01:00Z');await webhook(update(5));assert.match(aiCalls.at(-1).messages[0].content,/favorite era: prequels/);assert.match(aiCalls.at(-1).messages[0].content,/keep this answer spoiler-free/);
 await webhook(update(6,'/forget'));assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM fan_preferences').get().n,0);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM context').get().n,0);
});
test('one member allowing spoilers cannot override another saved avoid preference',async()=>{
 sqlite.prepare("INSERT INTO fan_preferences VALUES (42,'original','allow'),(43,'any','avoid')").run();assert.match(await preferencePrompt(env,42),/keep this answer spoiler-free/);
 await webhook(update(1,'/preferences off'));assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM fan_preferences WHERE user_id=42').get().n,0);
});
test('recurring daily game slot alternates characters/quotes with Monday weekly trivia',()=>{
 assert.equal(recurringKind('2026-10-26'),'weekly');assert.equal(recurringKind('2026-10-27'),'character');assert.equal(recurringKind('2026-10-28'),'quote');
 assert.equal(makePlan('2026-10-26')[0].kind,'weekly');
});
test('character game uses native quiz, topic mapping, correct answer and full answer window',async()=>{
 sqlite.prepare("INSERT INTO topic_map VALUES ('lore',15)").run();globalThis.fetch=async(url,options)=>{sent.push({method:String(url).split('/').at(-1),body:JSON.parse(options.body)});return Response.json({ok:true,result:{message_id:901,poll:{id:'quiz-game'}}});};
 await queue(-10,{internal_post:{kind:'character',scheduled_at:Date.now()/1000}});const body=sent[0].body;
 assert.equal(body.type,'quiz');assert.equal(body.message_thread_id,15);assert.equal(body.open_period,120);assert.ok(Number.isInteger(body.correct_option_id));
 assert.equal(sqlite.prepare('SELECT expires_at FROM polls').get().expires_at,Date.now()/1000+125);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM community_polls').get().n,0);
});
function trackedPoll(options=[{text:'R2-D2',voter_count:3},{text:'Chopper',voter_count:1}],closed=1){sqlite.prepare('INSERT INTO community_polls VALUES (?,?,?,?,?,?,?,?)').run('poll-1',800,15,'Which droid?',JSON.stringify(options),Date.now()/1000-60,closed,-4000000000010);}
test('poll result distinguishes a winner, tied totals and no votes',()=>{
 assert.match(pollResult({question:'Droid?',options:JSON.stringify([{text:'R2',voter_count:3},{text:'Chopper',voter_count:1}])}),/winning choice.*R2 \(3 votes\)/);
 assert.match(pollResult({question:'Droid?',options:JSON.stringify([{text:'R2',voter_count:2},{text:'Chopper',voter_count:2}])}),/A tie.*R2 \/ Chopper \(2 votes each\)/);
 assert.match(pollResult({question:'Droid?',options:JSON.stringify([{text:'R2',voter_count:0},{text:'Chopper',voter_count:0}])}),/No votes/);
});
test('final results from known polls only are accepted, invalid option counts ignored',async()=>{
 trackedPoll(undefined,0);await webhook({update_id:20,poll:{id:'unknown',is_closed:true,options:[]}});
 await receivePoll(env,{id:'poll-1',is_closed:true,options:[{text:'R2-D2',voter_count:-1},{text:'Chopper',voter_count:1}]});assert.equal(sqlite.prepare('SELECT closed FROM community_polls').get().closed,0);
 await webhook({update_id:21,poll:{id:'poll-1',is_closed:true,options:[{text:'R2-D2',voter_count:5},{text:'Chopper',voter_count:2}]}});assert.equal(sqlite.prepare('SELECT closed FROM community_polls').get().closed,1);
});
test('poll follow-up quotes real totals, replies in original topic and sends once',async()=>{
 trackedPoll();await queue(-4000000000010,{internal_followup:'poll-1'});await processUpdate(env,-4000000000010);
 assert.equal(sent.length,1);assert.match(sent[0].body.text,/R2-D2 \(3 votes\)/);assert.equal(sent[0].body.message_thread_id,15);assert.equal(sent[0].body.reply_parameters.message_id,800);assert.match(aiCalls[0].messages.at(-1).content,/counterargument/);
});
test('follow-up waits for quiet and never invents totals if closing poll fails',async()=>{
 trackedPoll(undefined,0);await webhook(update(2,'hello',{message_thread_id:15}));await queue(-4000000000010,{internal_followup:'poll-1'});assert.equal(sent.length,0);
 Date.now=()=>Date.parse('2026-10-27T06:11:00Z');globalThis.fetch=async()=>Response.json({ok:false,error_code:400});await processUpdate(env,-4000000000010);assert.equal(sent.length,0);assert.equal(aiCalls.length,0);
});
test('zero-vote follow-up is honest and needs no model',async()=>{
 trackedPoll([{text:'R2-D2',voter_count:0},{text:'Chopper',voter_count:0}]);await queue(-4000000000010,{internal_followup:'poll-1'});assert.equal(aiCalls.length,0);assert.match(sent[0].body.text,/No votes/);
});
test('webhook cannot spoof configuration or poll follow-up jobs',async()=>{
 await webhook({update_id:1,internal_configure:true});await webhook({update_id:2,internal_followup:'poll-1'});assert.equal(sent.length,0);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM updates').get().n,0);
});
test('recurring games continue after every curated question has appeared',async()=>{
 for(let i=0;i<4;i++)sqlite.prepare("INSERT INTO engagement_posts(update_id,kind,seed,text,payload,created_at,state) VALUES (?,'character',?,?, '{}',?,'sent')").run(-100-i,`character:${i}`,['Character guess: Astromech. Blue panels. Has very strong opinions about your repair technique.','Character guess: Protocol specialist. Gold plating. Fluent in more languages than your translation app.','Character guess: Wookiee co-pilot. Bowcaster enthusiast. Probably too tall for this cantina.','Character guess: Bounty hunter. Mandalorian armour. His ship used to be called the Razor Crest.'][i],Date.now()/1000-(i+1)*86400);
 await queue(-10,{internal_post:{kind:'character',scheduled_at:Date.now()/1000}});assert.equal(sent.length,1);assert.equal(sent[0].body.type,'quiz');
});
test('quote and weekly trivia quizzes have valid choices and correct answers',async()=>{
 for(const kind of ['quote','weekly'])await queue(kind==='quote'?-10:-11,{internal_post:{kind,scheduled_at:Date.now()/1000,requested:true}});
 assert.equal(sent.length,2);for(const x of sent){assert.equal(x.body.type,'quiz');assert.ok(x.body.options[x.body.correct_option_id]);assert.equal(x.body.open_period,120);}
});
test('a 429 follow-up retries its original text and rechecks topic activity',async()=>{
 trackedPoll();let attempts=0;
 globalThis.fetch=async(url,options)=>{sent.push({body:JSON.parse(options.body)});return Response.json(++attempts===1?{ok:false,error_code:429,parameters:{retry_after:2}}:{ok:true,result:{message_id:999}});};
 await queue(-4000000000010,{internal_followup:'poll-1'});assert.equal(sqlite.prepare('SELECT state FROM updates WHERE id=-4000000000010').get().state,'queued');
 await webhook(update(10,'hi',{message_thread_id:15}));Date.now=()=>Date.parse('2026-10-27T06:00:03Z');await processUpdate(env,-4000000000010);assert.equal(sent.length,1);
 Date.now=()=>Date.parse('2026-10-27T06:11:00Z');await processUpdate(env,-4000000000010);assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1]);assert.equal(aiCalls.length,1);
});
test('poll recording uses Telegram IDs and scheduler deduplicates its follow-up',async()=>{
 globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body);sent.push({body});return Response.json({ok:true,result:{message_id:901,poll:{id:'real-poll',options:body.options.map(text=>({text,voter_count:0}))}}});};
 await webhook(update(1,'/poll'));assert.equal(sent[0].body.open_period,600);const p=sqlite.prepare('SELECT * FROM community_polls').get();assert.equal(p.poll_id,'real-poll');assert.equal(p.message_id,901);
 Date.now=()=>Date.parse('2026-10-27T06:11:00Z');await receivePoll(env,{id:'real-poll',is_closed:true,options:JSON.parse(p.options)});
 await maintenance(env);await maintenance(env);assert.equal(sent.length,2);assert.match(sent[1].body.text,/No votes/);
});
test('stale poll follow-ups expire rather than replaying yesterday’s discussion',async()=>{
 trackedPoll();Date.now=()=>Date.parse('2026-10-28T07:00:00Z');await queue(-4000000000010,{internal_followup:'poll-1'});assert.equal(sent.length,0);
});
