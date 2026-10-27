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

test('random plans stay in HK active hours, have five baseline posts and at least 2h gaps',()=>{
 for(let i=0;i<1000;i++){const p=makePlan('2026-10-27');assert.equal(p.length,5);assert.equal(new Set(p.map(s=>s.kind)).size,p.length);p.forEach((s,j)=>{assert.ok(activeHours(s.at));assert.equal(localDay(s.at),'2026-10-27');if(j)assert.ok(s.at-p[j-1].at>=7200);});}
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
test('scheduler keeps a durable plan, deduplicates work and queues only one catch-up starter',async()=>{
 const at=Date.now()/1000;sqlite.prepare('INSERT INTO settings VALUES (?,?)').run('adaptive-plan:2026-10-27',JSON.stringify([{at:at-60,kind:'idea'},{at:at-7200,kind:'poll'}]));await scheduleProactive(env);await scheduleProactive(env);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM updates').get().n,1);assert.equal(sqlite.prepare('SELECT id FROM updates').get().id,-2000000000000-Math.floor(at/300));
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
 for(let i=0;i<11;i++){await queue(-100-i,{internal_post:{kind:i%2?'game':'movie',scheduled_at:Date.now()/1000,requested:true}});Date.now=()=>Date.parse('2026-10-27T06:00:00Z')+(i+1)*1000;}
 assert.equal(sent.length,10);
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
 sqlite.prepare('INSERT INTO settings VALUES (?,?)').run('adaptive-plan:2026-10-27','[]');
 globalThis.fetch=async(url,options)=>{const body=JSON.parse(options.body);sent.push({body});return Response.json({ok:true,result:{message_id:901,poll:{id:'real-poll',options:body.options.map(text=>({text,voter_count:0}))}}});};
 await webhook(update(1,'/poll'));assert.equal(sent[0].body.open_period,undefined);const p=sqlite.prepare('SELECT * FROM community_polls').get();assert.equal(p.poll_id,'real-poll');assert.equal(p.message_id,901);
 Date.now=()=>Date.parse('2026-10-27T06:11:00Z');await receivePoll(env,{id:'real-poll',is_closed:true,options:JSON.parse(p.options)});
 await maintenance(env);await maintenance(env);assert.equal(sent.length,2);assert.match(sent[1].body.text,/No votes/);
});
test('stale poll follow-ups expire rather than replaying yesterday’s discussion',async()=>{
 trackedPoll();Date.now=()=>Date.parse('2026-10-28T07:00:00Z');await queue(-4000000000010,{internal_followup:'poll-1'});assert.equal(sent.length,0);
});
test('maintenance closes polls and captures final totals even while their topic is busy',async()=>{
 sqlite.prepare('INSERT INTO settings VALUES (?,?)').run('adaptive-plan:2026-10-27','[]');
 trackedPoll(undefined,0);await webhook(update(1,'hello',{message_thread_id:15}));
 globalThis.fetch=async(url,options)=>{const method=String(url).split('/').at(-1);sent.push({method,body:JSON.parse(options.body)});return Response.json({ok:true,result:{id:'poll-1',is_closed:true,options:[{text:'R2-D2',voter_count:4},{text:'Chopper',voter_count:2}]}});};
 await maintenance(env);assert.deepEqual(sent.map(s=>s.method),['stopPoll']);assert.equal(sqlite.prepare('SELECT closed FROM community_polls').get().closed,1);assert.equal(sqlite.prepare('SELECT state FROM updates WHERE id=-4000000000010').get().state,'queued');
 Date.now=()=>Date.parse('2026-10-27T06:11:00Z');await processUpdate(env,-4000000000010);assert.equal(sent.at(-1).method,'sendMessage');assert.match(sent.at(-1).body.text,/4 votes/);
});

import { postingPolicy, recordEngagement, dayStart } from '../adaptive.mjs';
function seedInterest(users,buckets,offset=0) {
 const now=Date.now()/1000;
 for(let u=1;u<=users;u++)for(let b=0;b<buckets;b++)sqlite.prepare('INSERT OR IGNORE INTO quota VALUES (?,?,?,?,?)').run(`interest:${u}:${b}:${offset}`,u,0,'engagement_reply',now-offset-b*300);
}
function seedStarters(count,age=8000) {
 for(let i=0;i<count;i++)sqlite.prepare("INSERT INTO engagement_posts(update_id,kind,seed,text,payload,created_at,state) VALUES (?,'question',?,?, '{}',?,'sent')").run(-1000-i,`old:${i}`,`Existing starter ${i}`,Date.now()/1000-age-i);
}
test('posting target rises from five to seven to ten with recent participation',async()=>{
 assert.equal((await postingPolicy(env)).target,5);seedInterest(2,2);assert.equal((await postingPolicy(env)).target,7);assert.equal((await postingPolicy(env)).gap,5400);
 seedInterest(3,4);assert.equal((await postingPolicy(env)).target,10);assert.equal((await postingPolicy(env)).gap,3600);
});
test('single-member spam and repeated webhook delivery cannot unlock bonus posts',async()=>{
 seedInterest(1,30);assert.equal((await postingPolicy(env)).target,5);
 for(let i=0;i<20;i++)await recordEngagement(env,99,0,true);
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM quota WHERE event_key LIKE 'engagement:99:%'").get().n,1);
});
test('engagement expires after four hours and opted-out members do not boost posting',async()=>{
 seedInterest(3,4);assert.equal((await postingPolicy(env)).target,10);
 sqlite.prepare('INSERT INTO preferences VALUES (1,1),(2,1)').run();assert.equal((await postingPolicy(env)).target,5);
 sqlite.prepare('DELETE FROM preferences').run();Date.now=()=>Date.parse('2026-10-27T10:00:01Z');assert.equal((await postingPolicy(env)).target,5);
});
test('real aggregate poll votes can unlock moderate engagement without tracking voters',async()=>{
 trackedPoll([{text:'R2-D2',voter_count:4},{text:'Chopper',voter_count:4}]);assert.equal((await postingPolicy(env)).target,7);
 sqlite.prepare('UPDATE community_polls SET closed=0').run();assert.equal((await postingPolicy(env)).target,5);
});
test('private messages and admin commands never boost engagement',async()=>{
 await webhook(update(1,'/status'));await webhook(update(2,'Which droid should I pick?',{chat:{id:42,type:'private'}}));assert.equal((await postingPolicy(env)).score,0);
 await webhook(update(3,'An ordinary group contribution.'));assert.equal((await postingPolicy(env)).score,1);
});
test('five baseline reservations prevent extra posts without engagement',async()=>{
 seedStarters(5);await scheduleProactive(env);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM updates').get().n,0);
 await queue(-10,{internal_post:{kind:'idea',scheduled_at:Date.now()/1000,adaptive:true}});assert.equal(sent.length,0);
});
test('high engagement queues an extra post but a busy topic still defers it',async()=>{
 seedStarters(5);seedInterest(3,4);await webhook(update(10,'The cantina is busy right now.'));await scheduleProactive(env);
 const row=sqlite.prepare('SELECT id FROM updates WHERE id<0').get();assert.ok(row);await processUpdate(env,row.id);assert.equal(sent.length,0);assert.equal(sqlite.prepare('SELECT state FROM updates WHERE id=?').get(row.id).state,'queued');
 Date.now=()=>Date.parse('2026-10-27T06:11:00Z');await processUpdate(env,row.id);assert.equal(sent.length,1);
});
test('queued bonuses are cancelled when engagement cools before execution',async()=>{
 seedStarters(5);seedInterest(3,4);await scheduleProactive(env);const row=sqlite.prepare('SELECT id FROM updates WHERE id<0').get();assert.ok(row);
 sqlite.prepare("DELETE FROM quota WHERE kind='engagement_reply'").run();await processUpdate(env,row.id);assert.equal(sent.length,0);assert.equal(sqlite.prepare('SELECT state FROM updates WHERE id=?').get(row.id).state,'done');
});
test('adaptive minimum spacing, pause and quiet hours remain enforced',async()=>{
 seedStarters(5,1800);seedInterest(3,4);await scheduleProactive(env);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM updates').get().n,0);
 sqlite.prepare('UPDATE engagement_posts SET created_at=created_at-7200').run();sqlite.prepare("INSERT INTO settings VALUES ('paused','1')").run();await scheduleProactive(env);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM updates').get().n,0);
 sqlite.prepare("DELETE FROM settings WHERE key='paused'").run();Date.now=()=>Date.parse('2026-10-27T16:00:00Z');await scheduleProactive(env);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM updates').get().n,0);
});
test('daily counts reset at Hong Kong midnight rather than UTC midnight',async()=>{
 Date.now=()=>Date.parse('2026-10-27T16:01:00Z');assert.equal(dayStart(),Date.parse('2026-10-27T16:00:00Z')/1000);
});
test('a quiet full day schedules five baseline starters without a catch-up burst',async()=>{
 sqlite.prepare('INSERT INTO settings VALUES (?,?)').run('adaptive-plan:2026-10-27',JSON.stringify(makePlan('2026-10-27',()=>0)));
 let generated=0;env.AI.run=async()=>({response:`Fresh discussion ${++generated}: what would you put in a cantina?`});
 for(let minute=0;minute<13*60;minute+=5){Date.now=()=>Date.parse('2026-10-27T02:00:00Z')+minute*60000;await scheduleProactive(env);const rows=sqlite.prepare("SELECT id FROM updates WHERE state='queued'").all();for(const r of rows)await processUpdate(env,r.id);}
 assert.equal(sent.length,5);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM engagement_posts WHERE state='sent'").get().n,5);
});
test('sustained engagement can reach ten but never exceeds the daily ceiling',async()=>{
 sqlite.prepare('INSERT INTO settings VALUES (?,?)').run('adaptive-plan:2026-10-27',JSON.stringify(makePlan('2026-10-27',()=>0)));
 let generated=0;env.AI.run=async()=>({response:`Fresh lively discussion ${++generated}: which planet would you visit?`});
 for(let hour=0;hour<13;hour++){Date.now=()=>Date.parse('2026-10-27T02:00:00Z')+hour*3600000;seedInterest(3,4,hour);await scheduleProactive(env);for(const r of sqlite.prepare("SELECT id FROM updates WHERE state='queued'").all())await processUpdate(env,r.id);}
 assert.equal(sent.length,10);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM engagement_posts WHERE state='sent'").get().n,10);
});
test('a retry does not publish a bonus after participation falls below the current count',async()=>{
 seedStarters(5);seedInterest(3,4);globalThis.fetch=async()=>Response.json({ok:false,error_code:429,parameters:{retry_after:2}});
 await queue(-50,{internal_post:{kind:'idea',scheduled_at:Date.now()/1000}});assert.equal(sqlite.prepare('SELECT state FROM updates WHERE id=-50').get().state,'queued');
 sqlite.prepare("DELETE FROM quota WHERE kind='engagement_reply'").run();Date.now=()=>Date.parse('2026-10-27T06:01:00Z');globalThis.fetch=async()=>{throw Error('retry must not send');};await processUpdate(env,-50);assert.equal(sqlite.prepare('SELECT state FROM updates WHERE id=-50').get().state,'done');
});
test('status exposes the dynamic target and group messages create erasable signals',async()=>{
 seedInterest(3,4);await webhook(update(1,'/status'));assert.match(sent.at(-1).body.text,/0\/10 today/);assert.match(sent.at(-1).body.text,/60min/);
 await webhook(update(2,'The droids deserve their own spin-off.'));assert.ok(sqlite.prepare("SELECT 1 FROM quota WHERE user_id=42 AND kind='engagement_chat'").get());
 await webhook(update(3,'/forget'));assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM quota WHERE user_id=42').get().n,0);
});

import { topicName, availablePostKinds } from '../community.mjs';
test('expanded topic aliases normalize to consistent bindings',()=>{
 for(const alias of ['Hong Kong','hong_kong','hk','local events','local_events'])assert.equal(topicName(alias),'hongkong');
 for(const alias of ['TV Shows','tv_shows','television'])assert.equal(topicName(alias),'tv');
 assert.equal(topicName('global events'),'global_events');assert.equal(topicName('meme'),'memes');assert.equal(topicName('wallpaper'),'wallpapers');
 assert.equal(topicName('collectibles'),'collectibles');assert.equal(topicName('../secret'),null);assert.equal(topicName('x'.repeat(41)),null);
});
test('admins can bind new and custom topics while private/non-admin requests cannot',async()=>{
 await webhook(update(1,'/bindtopic local events',{message_thread_id:20}));await webhook(update(2,'/bindtopic tv shows',{message_thread_id:21}));await webhook(update(3,'/bindtopic collectibles',{message_thread_id:22}));
 assert.equal(sqlite.prepare("SELECT thread_id FROM topic_map WHERE name='hongkong'").get().thread_id,20);assert.equal(sqlite.prepare("SELECT thread_id FROM topic_map WHERE name='tv'").get().thread_id,21);assert.match(sent.at(-1).body.text,/collectibles.*no automatic content/);
 await webhook(update(4,'/bindtopic memes',{chat:{id:42,type:'private'}}));await webhook(update(5,'/bindtopic wallpapers',{from:{id:99},message_thread_id:23}));assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM topic_map WHERE name IN ('memes','wallpapers')").get().n,0);
});
test('each expanded content category routes to its actual bound topic',async()=>{
 let i=0;for(const name of ['hongkong','global_events','tv','memes','wallpapers']){
  sqlite.prepare('INSERT INTO topic_map VALUES (?,?)').run(name,20+i);
  env.AI.run=async()=>({response:`A distinct ${name} discussion prompt for the group.`});
  await queue(-100-i,{internal_post:{kind:name,scheduled_at:Date.now()/1000,requested:true}});assert.equal(sent.at(-1).body.message_thread_id,20+i);i++;
 }
 assert.equal(sent.length,5);
});
test('only bound extra categories enter automatic rotation; custom maps remain routing-only',async()=>{
 assert.equal((await availablePostKinds(env)).includes('hongkong'),false);sqlite.prepare("INSERT INTO topic_map VALUES ('hongkong',20),('tv',21),('collectibles',22)").run();
 const kinds=await availablePostKinds(env);assert.ok(kinds.includes('hongkong'));assert.ok(kinds.includes('tv'));assert.equal(kinds.includes('memes'),false);assert.equal(kinds.includes('collectibles'),false);
});
test('local and global event posts use labelled planning prompts without inventing announcements',async()=>{
 const local=await buildPost(env,'hongkong',[]),global=await buildPost(env,'global_events',[]);assert.equal(aiCalls.length,0);assert.equal(local.generation,'curated');assert.equal(global.generation,'curated');assert.match(local.text,/idea|wishlist|gathering/i);assert.match(global.text,/wishlist|If fans|would/i);
});
test('wallpaper generation explicitly requests a concept without claiming images or links',async()=>{
 await buildPost(env,'wallpapers',[]);assert.match(aiCalls[0].messages.at(-1).content,/never claim you generated, attached, downloaded or found an image/);
});
test('expanded topic service messages learn canonical aliases',async()=>{
 await webhook(update(1,undefined,{text:undefined,message_thread_id:20,forum_topic_created:{name:'Hong Kong'}}));await webhook(update(2,undefined,{text:undefined,message_thread_id:21,forum_topic_created:{name:'TV Shows'}}));
 assert.equal(sqlite.prepare("SELECT thread_id FROM topic_map WHERE name='hongkong'").get().thread_id,20);assert.equal(sqlite.prepare("SELECT thread_id FROM topic_map WHERE name='tv'").get().thread_id,21);
});
test('a newly bound category can enter the current day without increasing its daily target',async()=>{
 const at=Date.now()/1000;sqlite.prepare('INSERT INTO settings VALUES (?,?)').run('adaptive-plan:2026-10-27',JSON.stringify(makePlan('2026-10-27',()=>0)));
 sqlite.prepare("INSERT INTO topic_map VALUES ('tv',21)").run();
 for(const [i,kind] of ['question','poll','idea','movie','game'].entries())sqlite.prepare('INSERT INTO engagement_posts(update_id,kind,seed,text,payload,created_at,state) VALUES (?,?,?,?,?,?,?)').run(-100-i,kind,kind,kind,'{}',at-86400,'sent');
 seedStarters(1);await scheduleProactive(env);const row=sqlite.prepare("SELECT payload FROM updates WHERE id<0").get();assert.equal(JSON.parse(row.payload).internal_post.kind,'tv');assert.equal((await postingPolicy(env)).target,5);
});
