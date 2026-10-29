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
  db.exec(readFileSync(new URL('../migrations/0004_cantina.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0005_production.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0006_safe_recaps_games.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0007_admin_portal.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0009_youtube.sql', import.meta.url), 'utf8'));
  db.exec("INSERT INTO deployment_identity VALUES (1,'-100123','test')");
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
test('release commands show sourced availability in the matching topic without calling AI',async()=>{
 Date.now=()=>Date.parse('2026-10-29T06:00:00Z');
 sqlite.prepare("INSERT INTO topic_map VALUES ('gaming',19)").run();
 await webhook(update(1,'/releases games'));
 assert.equal(aiCalls.length,0);assert.equal(sent.length,1);assert.equal(sent[0].body.message_thread_id,19);
 assert.match(sent[0].body.text,/Star Wars Zero Company/);assert.match(sent[0].body.text,/Hong Kong availability not verified/);assert.match(sent[0].body.text,/https:\/\/www.starwars.com/);
});
test('source diagnostics stay private and absent local feed is not presented as no events',async()=>{
 await webhook(update(1,'/sources'));
 assert.equal(sent[0].body.chat_id,42);assert.match(sent[0].body.text,/News & release sources/);assert.match(sent[0].body.text,/YouTube trailers: Star Wars: not_connected/);
 await webhook(update(2,'/sources',{from:{id:99}}));assert.equal(sent.length,1);
 sqlite.prepare("INSERT INTO topic_map VALUES ('hongkong',8)").run();
 await webhook(update(3,'/news hongkong'));
 assert.equal(sent[1].body.message_thread_id,8);assert.match(sent[1].body.text,/does not mean there are no local events/);
});
test('release questions receive regional source evidence as data with no speculative availability',async()=>{
 Date.now=()=>Date.parse('2026-10-29T06:00:00Z');
 await webhook(update(1,'@SIU_M8_bot Where can I watch Maul Shadow Lord in Hong Kong?'));
 assert.equal(aiCalls.length,1);
 const prompt=aiCalls[0].messages[0].content;
 assert.match(prompt,/Shadow Lord/);assert.match(prompt,/disneyplus.com/);assert.match(prompt,/do not infer Hong Kong availability/);
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
test('movie cards use the verified release catalogue with source links',async()=>{
 Date.now=()=>Date.parse('2026-10-29T06:00:00Z');
 await queue(-1,{internal_post:{kind:'movie',scheduled_at:Date.now()/1000}});assert.match(sent[0].body.text,/2026-05-22/);assert.match(sent[0].body.text,/https:\/\/www.starwars.com/);assert.equal(releaseCard('movie',Date.parse('2027-06-01')/1000),undefined);assert.equal(releaseCard('game',Date.parse('2026-12-01')/1000),undefined);
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
test('private content commands publish to the group while operational receipts stay private',async()=>{
 for(const [i,cmd] of ['/help','/status','/poll','/trivia','/whereami','/privacy'].entries()){
  Date.now=()=>Date.parse('2026-10-27T06:00:00Z')+i*61000;
  await webhook(update(210+i,cmd,{chat:{id:42,type:'private'}}));
 }
 assert.equal(sent.length,6);for(const [i,s] of sent.entries()){assert.equal(s.body.chat_id,[1,4].includes(i)?42:-100123);assert.equal(s.body.reply_parameters,undefined);}assert.equal(sent.filter(s=>s.method==='sendPoll').length,2);
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
 Date.now=()=>Date.parse('2026-10-29T06:00:00Z');
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
 assert.equal(body.type,'quiz');assert.equal(body.message_thread_id,15);assert.equal(body.close_date,Date.now()/1000+120);assert.equal(body.open_period,undefined);assert.ok(Number.isInteger(body.correct_option_id));
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
 assert.equal(sent.length,2);for(const x of sent){assert.equal(x.body.type,'quiz');assert.ok(x.body.options[x.body.correct_option_id]);assert.equal(x.body.close_date,Date.now()/1000+120);assert.equal(x.body.open_period,undefined);}
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
 Date.now=()=>Date.parse('2026-10-27T08:00:00Z');await receivePoll(env,{id:'real-poll',is_closed:true,options:JSON.parse(p.options)});
 await maintenance(env);await maintenance(env);assert.equal(sent.length,2);assert.match(sent[1].body.text,/No votes/);
});
test('rate-limited polls get one fresh HKT deadline matching Telegram and stored follow-up time',async()=>{
 let attempts=0;
 globalThis.fetch=async(url,options)=>{
  const body=JSON.parse(options.body);sent.push({body});
  return Response.json(++attempts===1?{ok:false,error_code:429,parameters:{retry_after:2}}:{ok:true,result:{message_id:901,poll:{id:'retry-poll',options:body.options.map(text=>({text,voter_count:0}))}}});
 };
 await webhook(update(1,'/poll'));
 assert.match(sent[0].body.question,/Ends at 16:00:00 HKT · 27 Oct$/);
 const saved=JSON.parse(sqlite.prepare('SELECT outbound FROM updates WHERE id=1').get().outbound);
 assert.doesNotMatch(saved.question,/Ends at/);assert.equal(saved.close_date,undefined);
 Date.now=()=>Date.parse('2026-10-27T06:01:03Z');await processUpdate(env,1);
 assert.equal(sent.length,2);assert.match(sent[1].body.question,/Ends at 16:01:03 HKT · 27 Oct$/);
 assert.equal(sent[1].body.question.match(/Ends at/g).length,1);
 const poll=sqlite.prepare("SELECT * FROM community_polls WHERE poll_id='retry-poll'").get();
 assert.equal(poll.closes_at,sent[1].body.close_date);assert.equal(poll.closes_at,Date.now()/1000+7200);
 assert.equal(poll.question,saved.question);
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

import {queueClub,CLUB_OFFSET,parseHK,nextWeekend,makeBriefing,memoryContext,messageLink} from '../cantina-core.mjs';
import {scheduleClub} from '../cantina-jobs.mjs';
import {startGame,gamePoints,scheduleGames} from '../cantina-games.mjs';
async function drainClub(){
 await scheduleClub(env);
 for(const row of sqlite.prepare("SELECT id FROM updates WHERE id < -30000000000000 AND state='queued' AND ready_at<=? ORDER BY id").all(Date.now()/1000))await processUpdate(env,row.id);
}
function nativeTelegram(){
 globalThis.fetch=async(url,options)=>{
  const method=String(url).split('/').at(-1),body=JSON.parse(options.body||'{}');sent.push({method,body});
  if(method==='getChatMember')return Response.json({ok:true,result:{status:'member'}});
  if(['deleteMessage','restrictChatMember','banChatMember'].includes(method))return Response.json({ok:true,result:true});
  return Response.json({ok:true,result:{message_id:900+sent.length,...method==='sendPoll'?{poll:{id:'native-'+sent.length,options:body.options.map(text=>({text,voter_count:0}))}}:{}}});
 };
}
test('Hong Kong event dates reject invalid calendars and weekend choices are future local afternoons',()=>{
 assert.equal(parseHK('2026-10-28 18:30'),Date.parse('2026-10-28T10:30:00Z')/1000);assert.equal(parseHK('2026-02-30 18:30'),null);assert.equal(parseHK('tomorrow'),null);
 const [sat,sun]=nextWeekend();assert.equal(sun-sat,86400);assert.equal(new Date((sat+28800)*1000).getUTCDay(),6);assert.equal(new Date((sat+28800)*1000).getUTCHours(),15);assert.ok(sat>Date.now()/1000);
});
test('natural weekend planning queues an availability poll in Hong Kong without confirming attendance',async()=>{
 nativeTelegram();sqlite.prepare("INSERT INTO topic_map VALUES ('hongkong',20)").run();await webhook(update(100,'Is anyone free this weekend?'));await drainClub();
 const e=sqlite.prepare('SELECT * FROM club_events').get();assert.equal(e.status,'planning');assert.equal(e.thread_id,20);assert.ok(e.poll_id);assert.equal(sent.at(-1).method,'sendPoll');assert.equal(sent.at(-1).body.is_anonymous,false);
 await webhook({update_id:101,poll_answer:{poll_id:e.poll_id,user:{id:77,is_bot:false},option_ids:[1]}});assert.equal(sqlite.prepare('SELECT option_id FROM club_date_votes').get().option_id,1);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM club_rsvps').get().n,0);
});
test('draft event requires admin confirmation then sends group reminders only to opted-in attendees',async()=>{
 nativeTelegram();sqlite.prepare("INSERT INTO topic_map VALUES ('hongkong',20)").run();
 await webhook(update(100,'/event create Watch party|2026-10-28 18:00|Community room|hongkong|https://example.com/details',{from:{id:77,first_name:'Guest'}}));
 await webhook(update(101,'/event confirm 100',{from:{id:77}}));assert.equal(sqlite.prepare('SELECT status FROM club_events').get().status,'draft');
 await webhook(update(102,'/event confirm 100'));await drainClub();assert.equal(sqlite.prepare('SELECT status FROM club_events').get().status,'confirmed');assert.match(sent.at(-1).body.text,/Admin-confirmed/);assert.equal(sent.at(-1).body.message_thread_id,20);
 await webhook(update(103,'/rsvp 100 yes remind',{from:{id:77,first_name:'Guest'}}));await webhook(update(104,'/rsvp 100 yes',{from:{id:78,first_name:'Silent'}}));
 Date.now=()=>Date.parse('2026-10-28T09:31:00Z');await drainClub();const reminder=sent.find(s=>s.body.text?.startsWith('Opt-in reminder'));assert.ok(reminder);assert.deepEqual(reminder.body.entities.map(e=>e.user.id),[77]);assert.equal(reminder.body.chat_id,-100123);
});
test('cancelled events never deliver a queued reminder',async()=>{
 nativeTelegram();await webhook(update(100,'/event create Test|2026-10-28 18:00|Room|hongkong'));await webhook(update(101,'/event confirm 100'));await drainClub();await webhook(update(102,'/rsvp 100 yes remind'));
 Date.now=()=>Date.parse('2026-10-28T09:31:00Z');await scheduleClub(env);await webhook(update(103,'/event cancel 100'));await drainClub();assert.equal(sent.filter(s=>s.body.text?.startsWith('Opt-in reminder')).length,0);
});
test('pending memory never enters answers until an admin approves; admins can remove it',async()=>{
 await webhook(update(100,'/remember decision|Watch party|We chose Saturday at 18:00.',{from:{id:77}}));assert.equal((await memoryContext(env,'watch party')).length,0);
 await webhook(update(101,'/approve memory 100',{from:{id:77}}));assert.equal((await memoryContext(env,'watch party')).length,0);
 await webhook(update(102,'/memory show 100'));assert.match(sent.at(-1).body.text,/Saturday/);
 await webhook(update(103,'/approve memory 100'));const memory=await memoryContext(env,'watch party');assert.equal(memory.length,1);assert.match(memory[0].source,/\/100$/);
 await webhook(update(104,'/ask What did we decide about the watch party?'));assert.match(aiCalls.at(-1).messages[0].content,/We chose Saturday/);
 await webhook(update(105,'/memory remove 100'));assert.equal((await memoryContext(env,'watch party')).length,0);
});
test('briefing uses linked group excerpts, marks recorded replies and excludes private/opted-out text',async()=>{
 env.AMBIENT_ENABLED='false';await webhook(update(100,'Who would join a watch party?',{from:{id:77}}));await webhook(update(101,'I would join on Saturday.',{from:{id:78},reply_to_message:{message_id:100,from:{id:77}}}));
 await webhook(update(102,'Secret private planning',{chat:{id:42,type:'private'}}));sqlite.prepare('INSERT INTO preferences VALUES (99,1)').run();await webhook(update(103,'Do not include this in recaps?',{from:{id:99}}));
 const briefing=await makeBriefing(env);assert.match(briefing,/Discussed \/ liked/);assert.match(briefing,/https:\/\/t.me\/c\/123\/100/);assert.doesNotMatch(briefing,/Secret private|Do not include/);
});
test('onboarding uses approved rules, explains privacy and offers optional preferences',async()=>{
 await webhook(update(100,'/remember rule|Spoilers|Use spoiler formatting.'));await webhook(update(101,'/approve memory 100'));
 await webhook(update(102,undefined,{text:undefined,new_chat_members:[{id:77,first_name:'Newbie',is_bot:false}]}));await drainClub();const welcome=sent.find(s=>s.body.text?.startsWith('Welcome aboard'));assert.ok(welcome);assert.match(welcome.body.text,/Use spoiler formatting/);assert.match(welcome.body.text,/Optional: \/preferences on/);assert.match(welcome.body.text,/\/privacy/);
});
test('moderation only flags possible issues and requires a configured admin’s explicit action',async()=>{
 nativeTelegram();env.AMBIENT_ENABLED='false';await webhook(update(100,'https://a.example https://b.example https://c.example',{from:{id:77}}));
 const review=sqlite.prepare('SELECT * FROM club_reviews').get();assert.equal(review.state,'pending');assert.equal(sent.length,0);
 await webhook(update(101,`/approve ${review.id} mute`,{from:{id:77}}));assert.equal(sqlite.prepare('SELECT state FROM club_reviews').get().state,'pending');
 await webhook(update(102,`/approve ${review.id} mute`));await drainClub();const mute=sent.find(s=>s.method==='restrictChatMember');assert.ok(mute);assert.equal(mute.body.user_id,77);assert.equal(mute.body.until_date,Date.now()/1000+3600);assert.equal(sqlite.prepare('SELECT state FROM club_reviews').get().state,'executed');
 await webhook(update(103,`/approve ${review.id} mute`));await drainClub();assert.equal(sent.filter(s=>s.method==='restrictChatMember').length,1);
});
test('live administrator status protects targets even after moderation approval',async()=>{
 nativeTelegram();env.AMBIENT_ENABLED='false';await webhook(update(100,'https://a.example https://b.example https://c.example',{from:{id:77}}));const review=sqlite.prepare('SELECT id FROM club_reviews').get();await webhook(update(101,`/approve ${review.id} ban`));
 const original=globalThis.fetch;globalThis.fetch=async(url,opts)=>String(url).endsWith('/getChatMember')?Response.json({ok:true,result:{status:'administrator'}}):original(url,opts);
 await drainClub();assert.equal(sent.filter(s=>s.method==='banChatMember').length,0);assert.equal(sqlite.prepare('SELECT state FROM club_reviews').get().state,'protected');
});
test('spoiler heuristics ignore Telegram spoiler formatting and flag only for human review',async()=>{
 env.AMBIENT_ENABLED='false';await webhook(update(100,'Spoiler: in the finale someone dies.',{from:{id:77},entities:[{type:'spoiler',offset:0,length:35}]}));assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM club_reviews').get().n,0);
 await webhook(update(101,'Spoiler: in the finale someone dies.',{from:{id:78}}));assert.equal(sqlite.prepare('SELECT state FROM club_reviews').get().state,'pending');assert.equal(sent.length,0);
});
test('hosting revives one unanswered question, respects opt-out and stops after a recorded answer',async()=>{
 env.AMBIENT_ENABLED='false';await webhook(update(100,'Who wants to discuss this character?',{from:{id:77}}));Date.now=()=>Date.parse('2026-10-27T08:01:00Z');await drainClub();assert.ok(sent.some(s=>s.body.text?.startsWith('This question has no recorded reply')));
 const control=sqlite.prepare('SELECT last_nudge FROM club_controls WHERE user_id=77').get();assert.ok(control.last_nudge);
 await webhook(update(101,'/prompts off',{from:{id:78}}));await webhook(update(102,'What about another question?',{from:{id:78}}));assert.equal(sqlite.prepare('SELECT prompts FROM club_controls WHERE user_id=78').get().prompts,0);
});
test('positive reactions can revive a liked suggestion without prompting its author repeatedly',async()=>{
 env.AMBIENT_ENABLED='false';await webhook(update(100,'We should organise a costume workshop.',{from:{id:77}}));
 for(const user of [78,79])await webhook({update_id:user,message_reaction:{chat:{id:-100123},message_id:100,user:{id:user,is_bot:false},new_reaction:[{type:'emoji',emoji:'👍'}]}});
 Date.now=()=>Date.parse('2026-10-27T08:01:00Z');await drainClub();assert.ok(sent.some(s=>s.body.text?.startsWith('This idea picked up interest')));await drainClub();assert.equal(sent.filter(s=>s.body.text?.startsWith('This idea')).length,1);
});
test('progressive character clues stop when solved and award only the first solver',async()=>{
 await startGame(env,101,'character',15);await drainClub();assert.match(sent.at(-1).body.text,/Clue 1 of 3/);
 Date.now=()=>Date.parse('2026-10-27T06:05:01Z');await drainClub();assert.match(sent.at(-1).body.text,/Clue 2 of 3/);
 const answer=JSON.parse(sqlite.prepare('SELECT payload FROM club_games').get().payload).display;await webhook(update(200,`/answer 101 ${answer}`,{from:{id:77}}));await webhook(update(201,`/answer 101 ${answer}`,{from:{id:78}}));assert.equal(sqlite.prepare('SELECT SUM(points) n FROM club_points').get().n,5);assert.equal(sqlite.prepare('SELECT state FROM club_games').get().state,'solved');
 Date.now=()=>Date.parse('2026-10-27T06:11:00Z');await drainClub();assert.equal(sent.filter(s=>s.body.text?.includes('clue 3/3')).length,0);
});
test('team trivia records the first answer, scores participation and preserves awarded team membership',async()=>{
 nativeTelegram();await webhook(update(90,'/team rebels',{from:{id:77}}));await startGame(env,100,'trivia',15);await drainClub();const round=sqlite.prepare('SELECT * FROM club_game_polls').get();assert.ok(round);
 await webhook({update_id:101,poll_answer:{poll_id:round.poll_id,user:{id:77,is_bot:false},option_ids:[round.correct]}});await webhook({update_id:102,poll_answer:{poll_id:round.poll_id,user:{id:77,is_bot:false},option_ids:[(round.correct+1)%4]}});assert.equal(sqlite.prepare('SELECT points FROM club_points').get().points,3);
 await webhook(update(103,'/team empire',{from:{id:77}}));assert.equal(sqlite.prepare('SELECT team FROM club_points').get().team,'rebels');
 Date.now=()=>Date.parse('2026-10-27T06:02:31Z');await drainClub();assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM club_game_polls').get().n,2);
});
test('caption contests award creative participation and one peer vote, with no self-voting',async()=>{
 await startGame(env,100,'caption',15);await drainClub();await webhook(update(101,'/caption 100 These are not the invoices you are looking for.',{from:{id:77}}));await webhook(update(102,'/vote 100 77',{from:{id:77}}));assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM club_caption_votes').get().n,0);
 await webhook(update(103,'/vote 100 77',{from:{id:78}}));await webhook(update(104,'/vote 100 77',{from:{id:78}}));assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM club_caption_votes').get().n,1);
 Date.now=()=>Date.parse('2026-10-28T06:01:00Z');await drainClub();assert.match(sent.at(-1).body.text,/Community vote winner/);assert.equal(sqlite.prepare('SELECT SUM(points) n FROM club_points WHERE user_id=77').get().n,7);
});
test('briefings and weekly games are durably scheduled only once in their Hong Kong windows',async()=>{
 Date.now=()=>Date.parse('2026-11-02T11:00:00Z');await scheduleClub(env);await scheduleClub(env);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM club_jobs WHERE kind='game_start'").get().n,1);
 Date.now=()=>Date.parse('2026-11-02T13:00:00Z');await scheduleClub(env);await scheduleClub(env);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM club_jobs WHERE kind='briefing'").get().n,1);
});
test('quiet mode pauses automatic work but leaves direct admin commands available',async()=>{
 env.AMBIENT_ENABLED='false';await webhook(update(99,'Who wants to join a watch party?',{from:{id:77}}));
 await webhook(update(100,'/quiet 60'));await queue(-50,{internal_post:{kind:'idea',scheduled_at:Date.now()/1000}});assert.equal(sent.length,1);
 const job=await queueClub(env,'briefing-test','briefing',{});await drainClub();assert.equal(sqlite.prepare('SELECT state FROM club_jobs WHERE id=?').get(job.id).state,'pending');await webhook(update(101,'/settings'));assert.match(sent.at(-1).body.text,/Quiet until:/);
 await webhook(update(102,'/quiet off'));Date.now=()=>Date.parse('2026-10-27T06:11:00Z');await drainClub();assert.ok(sent.some(s=>s.body.text?.startsWith('Cantina briefing')));
});
test('forget removes preferences, attendance, game records and pending proposals without leaking DMs',async()=>{
 await webhook(update(100,'/preferences on'));await webhook(update(101,'/interests gaming,movies'));await webhook(update(102,'/team rebels'));await webhook(update(103,'/remember faq|Test|A pending answer'));await gamePoints(env,'sample',42,3,'test');
 await webhook(update(104,'/forget'));for(const table of ['fan_interests','club_teams','club_points','club_memory','club_controls'])assert.equal(sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
});
test('public webhook cannot inject club jobs or destructive moderation actions',async()=>{
 await webhook({update_id:1,internal_club:1});await webhook({update_id:2,internal_action:{method:'banChatMember'}});assert.equal(sent.length,0);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM club_jobs').get().n,0);
});
test('Sunday weekend availability includes today rather than silently jumping a week',()=>{
 const now=Date.parse('2026-11-01T02:00:00Z')/1000;const options=nextWeekend(now);assert.equal(new Date((options[0]+28800)*1000).toISOString().slice(0,10),'2026-11-01');assert.ok(options.every(t=>t>now));
});
test('uncertain moderation delivery is recorded and never automatically repeated',async()=>{
 nativeTelegram();env.AMBIENT_ENABLED='false';await webhook(update(100,'https://a.example https://b.example https://c.example',{from:{id:77}}));const review=sqlite.prepare('SELECT id FROM club_reviews').get();await webhook(update(101,`/approve ${review.id} delete`));
 let attempts=0;globalThis.fetch=async(url)=>{if(String(url).endsWith('/getChatMember'))return Response.json({ok:true,result:{status:'member'}});attempts++;throw Error('connection lost after send');};
 await drainClub();await drainClub();assert.equal(attempts,1);assert.equal(sqlite.prepare("SELECT state FROM club_jobs WHERE kind='moderation'").get().state,'uncertain');
});
test('event reminder retry rechecks opt-in and never mentions someone who opted out',async()=>{
 nativeTelegram();await webhook(update(100,'/event create Test|2026-10-28 18:00|Room|hongkong'));await webhook(update(101,'/event confirm 100'));await drainClub();await webhook(update(102,'/rsvp 100 yes remind',{from:{id:77}}));
 Date.now=()=>Date.parse('2026-10-28T09:31:00Z');globalThis.fetch=async()=>Response.json({ok:false,error_code:429,parameters:{retry_after:2}});await drainClub();
 await webhook(update(103,'/optout',{from:{id:77}}));nativeTelegram();Date.now=()=>Date.parse('2026-10-28T09:32:00Z');await drainClub();assert.equal(sent.filter(s=>s.body.text?.startsWith('Opt-in reminder')).length,0);
});
test('bot answers prevent a question being falsely revived as unanswered',async()=>{
 await webhook(update(100,'@SIU_M8_bot Which droid is useful?'));Date.now=()=>Date.parse('2026-10-27T08:01:00Z');await drainClub();assert.equal(sent.filter(s=>s.body.text?.startsWith('This question')).length,0);
});
test('new-member opt-out before welcome delivery suppresses the queued greeting',async()=>{
 await webhook(update(100,undefined,{text:undefined,new_chat_members:[{id:77,first_name:'Newbie',is_bot:false}]}));await webhook(update(101,'/optout',{from:{id:77}}));await drainClub();assert.equal(sent.filter(s=>s.body.text?.startsWith('Welcome aboard')).length,0);
});
test('game points are capped and cannot be earned twice from the same event',async()=>{
 for(let i=0;i<10;i++)await gamePoints(env,'score:'+i,77,3,'test');await gamePoints(env,'score:0',77,3,'test');assert.equal(sqlite.prepare('SELECT SUM(points) n FROM club_points').get().n,18);
});

// Production isolation and shared automation budget regressions.
import {assertDeployment,automaticDelivery,reserveAutomation,budgetStatus,readiness} from '../production.mjs';
test('changing the group refuses webhook, cron and queued sends before touching test data',async()=>{
 env.GROUP_ID='-100999';
 assert.equal((await webhook(update())).status,503);
 await assert.rejects(maintenance(env),/database-group-mismatch/);
 sqlite.prepare('INSERT INTO updates(id,payload,created_at) VALUES (1,?,?)').run(JSON.stringify(update()),Date.now()/1000);
 await assert.rejects(processUpdate(env,1),/database-group-mismatch/);
 assert.equal(sqlite.prepare('SELECT state FROM updates').get().state,'queued');
 assert.equal(sent.length,0);assert.equal(aiCalls.length,0);
});
test('missing identity, production/test mismatch and disabled deployments fail closed',async()=>{
 env.DEPLOYMENT_ENV='production';await assert.rejects(assertDeployment(env),/database-group-mismatch/);
 env.DEPLOYMENT_ENV='test';env.DEPLOYMENT_ENABLED='false';await assert.rejects(assertDeployment(env),/deployment-disabled/);
 delete env.DEPLOYMENT_ENABLED;sqlite.exec('DELETE FROM deployment_identity');await assert.rejects(assertDeployment(env),/database-group-mismatch/);
 assert.equal((await worker.fetch(new Request('https://test/healthz'),env,{})).status,503);
});
test('budget reservations are atomic, shared, retry-idempotent and reset at HK midnight',async()=>{
 env.AUTOMATED_DAILY_CAP='5';
 const result=await Promise.all(Array.from({length:12},(_,i)=>reserveAutomation(env,i+1)));
 assert.equal(result.filter(Boolean).length,5);assert.equal(await reserveAutomation(env,1),true);
 assert.deepEqual(await budgetStatus(env),{used:5,cap:5});
 Date.now=()=>Date.parse('2026-10-27T16:00:01Z');assert.equal(await reserveAutomation(env,1),true);assert.equal((await budgetStatus(env)).used,1);
});
test('automation classification includes welcomes, game rounds, reminders and ambient but excludes direct requests',()=>{
 for(const kind of ['game_step','game_close','event_reminder','host','text','briefing'])assert.equal(automaticDelivery({}, {kind,job_key:'job',data:'{}'},env.BOT_USERNAME,123),true);
 assert.equal(automaticDelivery({internal_followup:'poll'},null,env.BOT_USERNAME,123),true);
 assert.equal(automaticDelivery({internal_post:{requested:false}},null,env.BOT_USERNAME,123),true);
 assert.equal(automaticDelivery({internal_post:{requested:true}},null,env.BOT_USERNAME,123),false);
 assert.equal(automaticDelivery({}, {kind:'briefing',job_key:'job',data:'{"requested":true}'},env.BOT_USERNAME,123),false);
 assert.equal(automaticDelivery({}, {kind:'moderation',job_key:'job',data:'{}'},env.BOT_USERNAME,123),false);
 assert.equal(automaticDelivery(update(1,'Which droid?'),null,env.BOT_USERNAME,123),true);
 assert.equal(automaticDelivery(update(),null,env.BOT_USERNAME,123),false);
 assert.equal(automaticDelivery(update(1,'/settings'),null,env.BOT_USERNAME,123),false);
});
test('full budget blocks a real queued club send but still delivers direct member replies',async()=>{
 env.AUTOMATED_DAILY_CAP='5';for(let i=0;i<5;i++)await reserveAutomation(env,100+i);
 const job=await queueClub(env,'budget-welcome','text',{text:'Welcome'},0);
 await queue(-30000000000000-job.id,{internal_club:job.id});
 assert.equal(sent.length,0);assert.equal(sqlite.prepare('SELECT state FROM club_jobs WHERE id=?').get(job.id).state,'budget_limited');
 await webhook(update(999));assert.equal(sent.length,1);assert.equal((await budgetStatus(env)).used,5);
});
test('429 automated delivery retry uses one budget slot',async()=>{
 let tries=0;globalThis.fetch=async()=>Response.json(++tries===1?{ok:false,error_code:429,parameters:{retry_after:2}}:{ok:true,result:{message_id:700}});
 const job=await queueClub(env,'retry-budget','text',{text:'Hello'},0),id=-30000000000000-job.id;
 await queue(id,{internal_club:job.id});assert.equal((await budgetStatus(env)).used,1);
 Date.now=()=>Date.parse('2026-10-27T06:00:03Z');await processUpdate(env,id);
 assert.equal(tries,2);assert.equal((await budgetStatus(env)).used,1);assert.equal(sqlite.prepare('SELECT state FROM club_jobs').get().state,'sent');
});
test('readiness reports missing mappings, rules and Telegram permissions without publishing automatically',async()=>{
 const report=await readiness(env);assert.ok(report.issues.includes('Bind topic: gaming'));assert.ok(report.issues.includes('Add and approve the real group rules'));assert.ok(report.issues.includes('Missing restrict-members permission'));
 assert.ok(sent.every(r=>r.method.startsWith('get')));
});
test('production resume remains paused until real permissions, topics, rules and webhook pass',async()=>{
 env.DEPLOYMENT_ENV='production';env.EXPECTED_WEBHOOK_URL='https://production.example/telegram';
 sqlite.exec("UPDATE deployment_identity SET environment='production'; INSERT INTO settings VALUES ('paused','1')");
 await webhook(update(100,'/resume'));assert.equal(sqlite.prepare("SELECT value FROM settings WHERE key='paused'").get().value,'1');
 sqlite.exec("INSERT INTO topic_map VALUES ('gaming',2),('movies',4),('lore',6); INSERT INTO club_memory(id,title,body,kind,proposed_by,status,created_at) VALUES(1,'Rules','Be kind','rule',42,'approved',1)");
 sent=[];globalThis.fetch=async(url,options)=>{const method=String(url).split('/').at(-1),body=JSON.parse(options.body);sent.push({method,body});const result=method==='getMe'?{username:env.BOT_USERNAME}:method==='getChat'?{id:-100123,is_forum:true}:method==='getChatMember'?{status:'administrator',can_delete_messages:true,can_restrict_members:true}:method==='getWebhookInfo'?{url:env.EXPECTED_WEBHOOK_URL,allowed_updates:['message','poll','poll_answer','message_reaction'],pending_update_count:0}:{message_id:901};return Response.json({ok:true,result});};
 await webhook(update(101,'/resume'));assert.equal(sqlite.prepare("SELECT value FROM settings WHERE key='paused'").get().value,'0');assert.equal(sent.filter(r=>r.method==='sendMessage').length,1);
});
test('readiness command is restricted to configured admins',async()=>{
 await webhook(update(1,'/readiness',{from:{id:99,is_bot:false,first_name:'Member'}}));assert.equal(sent.length,1);assert.match(sent[0].body.text,/configured admins/);
});
test('a group switch during AI generation is caught at final delivery boundary',async()=>{
 env.AI.run=async()=>{env.GROUP_ID='-100999';return {response:'Do not leak this answer.'};};await webhook(update());assert.equal(sent.length,0);
});
test('full budget expires a game instead of leaving scheduled rounds to flood tomorrow',async()=>{
 env.AUTOMATED_DAILY_CAP='5';for(let i=0;i<5;i++)await reserveAutomation(env,100+i);
 await startGame(env,500,'character',6);
 const job=sqlite.prepare("SELECT id FROM club_jobs WHERE job_key='game:500:0'").get();await queue(-30000000000000-job.id,{internal_club:job.id});
 assert.equal(sent.length,0);assert.equal(sqlite.prepare('SELECT state FROM club_games WHERE id=500').get().state,'expired');
 await scheduleGames(env);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM club_jobs').get().n,1);
});
test('webhook cannot trigger internal launch readiness or network permission probes',async()=>{
 await webhook({update_id:200,internal_readiness:true});assert.equal(sent.length,0);assert.equal(sqlite.prepare("SELECT value FROM settings WHERE key='launch_readiness'").get(),undefined);
});
test('invalid default topic routing fails before processing member messages',async()=>{
 env.ALLOWED_THREAD_IDS='4,6';env.PRIVATE_THREAD_ID='0';assert.equal((await webhook(update())).status,503);assert.equal(sent.length,0);
});


test('empty manual briefings produce no acknowledgement, no AI request and no budget reservation',async()=>{
 await webhook(update(700,'/briefing'));await drainClub();await drainClub();
 assert.equal(sent.length,0);assert.equal(aiCalls.length,0);assert.equal((await budgetStatus(env)).used,0);
 assert.equal(sqlite.prepare("SELECT state FROM club_jobs WHERE kind='briefing'").get().state,'skipped');
});
test('scheduled briefings skip ordinary chatter and polls with no votes',async()=>{
 env.AMBIENT_ENABLED='false';await webhook(update(701,'Good morning everyone, hope your day is going well.',{from:{id:77}}));
 sqlite.prepare('INSERT INTO community_polls(poll_id,message_id,thread_id,question,options,closes_at,closed,followup_id) VALUES (?,?,?,?,?,?,1,?)').run('empty',800,0,'Droid choice?',JSON.stringify([{text:'R2',voter_count:0},{text:'Chopper',voter_count:0}]),Date.now()/1000-60,-999);
 await queueClub(env,'empty-daily','briefing',{});Date.now=()=>Date.parse('2026-10-27T06:11:00Z');await drainClub();
 assert.equal(sent.length,0);assert.equal(aiCalls.length,0);assert.equal((await budgetStatus(env)).used,0);
 assert.equal(sqlite.prepare("SELECT state FROM club_jobs WHERE kind='briefing'").get().state,'skipped');
});
test('a voted poll alone is enough to publish a briefing without an empty-discussion notice',async()=>{
 sqlite.prepare('INSERT INTO community_polls(poll_id,message_id,thread_id,question,options,closes_at,closed,followup_id) VALUES (?,?,?,?,?,?,1,?)').run('voted',800,0,'Droid choice?',JSON.stringify([{text:'R2',voter_count:3},{text:'Chopper',voter_count:1}]),Date.now()/1000-60,-999);
 await webhook(update(700,'/briefing'));await drainClub();assert.equal(sent.length,1);assert.match(sent[0].body.text,/R2 — 3/);assert.doesNotMatch(sent[0].body.text,/No eligible/);
});
test('a confirmed upcoming event alone keeps the briefing useful',async()=>{
 sqlite.prepare("INSERT INTO club_events(id,title,creator,starts_at,location,status,created_at,thread_id) VALUES(1,'Watch party',42,?,'Room','confirmed',?,0)").run(Date.now()/1000+86400,Date.now()/1000);
 const briefing=await makeBriefing(env);assert.match(briefing,/Upcoming: Watch party/);assert.doesNotMatch(briefing,/No eligible/);
});

test('forget during briefing generation invalidates the entire draft, including blended summaries',async()=>{
 env.AMBIENT_ENABLED='false';
 await webhook(update(800,'Should we discuss my secret watch-party idea?',{from:{id:77}}));
 await webhook(update(801,'Which day is best for the public meetup?',{from:{id:78}}));
 env.AI.run=async()=>{
  await webhook(update(802,'/forget',{from:{id:77}}));
  return {response:JSON.stringify([{id:801,summary:'Combine the public meetup with the secret watch-party idea.'}])};
 };
 await queueClub(env,'forget-during-briefing','briefing',{requested:true},0,42);await drainClub();
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM club_messages WHERE user_id=77').get().n,0);
 assert.equal(sent.filter(s=>s.body.text?.startsWith('Cantina briefing')).length,0);
 assert.equal(sqlite.prepare("SELECT state FROM club_jobs WHERE kind='briefing'").get().state,'skipped');
});
test('briefing source consent is rechecked at final send after queue writes',async()=>{
 env.AMBIENT_ENABLED='false';await webhook(update(800,'Should we discuss my watch-party idea?',{from:{id:77}}));
 env.AI.run=async()=>({response:JSON.stringify([{id:800,summary:'A watch-party idea was proposed.'}])});
 const originalPrepare=env.DB.prepare.bind(env.DB);let withdrawn=false;
 env.DB.prepare=sql=>{
  const statement=originalPrepare(sql);
  if(sql.startsWith("UPDATE updates SET state='sending'")){
   const bind=statement.bind,run=statement.run;let body;
   statement.bind=(...args)=>{body=JSON.parse(args[0]);return bind(...args);};
   statement.run=async()=>{const result=await run();if(!withdrawn&&body.text?.startsWith('Cantina briefing')){withdrawn=true;await webhook(update(801,'/forget',{from:{id:77}}));}return result;};
  }
  return statement;
 };
 await queueClub(env,'late-withdrawal','briefing',{requested:true},0,42);await drainClub();
 assert.ok(withdrawn);assert.equal(sent.filter(s=>s.body.text?.startsWith('Cantina briefing')).length,0);
 assert.equal(sqlite.prepare("SELECT state FROM club_jobs WHERE kind='briefing'").get().state,'skipped');
 assert.ok(sqlite.prepare("SELECT 1 FROM updates WHERE error='delivery-invalidated' AND outbound IS NULL").get());
});
test('briefing rate-limit retries rebuild from current sources after opt-out',async()=>{
 env.AMBIENT_ENABLED='false';await webhook(update(800,'Would you join my watch-party idea?',{from:{id:77}}));
 const job=await queueClub(env,'briefing-429','briefing',{requested:true},0,42),id=-CLUB_OFFSET-job.id;
 globalThis.fetch=async()=>Response.json({ok:false,error_code:429,parameters:{retry_after:2}});
 await drainClub();assert.equal(sqlite.prepare('SELECT state FROM updates WHERE id=?').get(id).state,'queued');
 nativeTelegram();await webhook(update(801,'/optout',{from:{id:77}}));Date.now=()=>Date.parse('2026-10-27T06:00:03Z');await drainClub();
 assert.equal(sent.filter(s=>s.body.text?.startsWith('Cantina briefing')).length,0);
 assert.equal(sqlite.prepare('SELECT state FROM club_jobs WHERE id=?').get(job.id).state,'skipped');
});
test('spoiler-formatted excerpts are excluded from AI briefings and fallback text',async()=>{
 env.AMBIENT_ENABLED='false';
 await webhook(update(800,'Why does Captain Example die in the finale?',{from:{id:77},entities:[{type:'spoiler',offset:0,length:42}]}));
 await webhook(update(801,'Which droid would make a good host?',{from:{id:78}}));
 env.AI.run=async(model,request)=>{aiCalls.push(request);throw Error('unavailable');};
 await webhook(update(802,'/briefing'));await drainClub();
 assert.equal(sent.length,1);assert.match(sent[0].body.text,/Which droid/);assert.doesNotMatch(sent[0].body.text,/Captain Example/);
 assert.ok(aiCalls.length);assert.doesNotMatch(JSON.stringify(aiCalls),/Captain Example/);
 assert.equal(sqlite.prepare('SELECT text FROM club_messages WHERE message_id=800').get().text,'');
});
test('spoiler-marked questions cannot be revived by new or already queued hosting jobs',async()=>{
 env.AMBIENT_ENABLED='false';await webhook(update(800,'Why does Captain Example die in the finale?',{from:{id:77},entities:[{type:'spoiler',offset:0,length:42}]}));
 await queueClub(env,'legacy-host-spoiler','host',{message_id:800},0,77);
 Date.now=()=>Date.parse('2026-10-27T08:01:00Z');await drainClub();
 assert.equal(sent.length,0);assert.equal(sqlite.prepare("SELECT state FROM club_jobs WHERE kind='host'").get().state,'cancelled');
});
test('legacy excerpts with unknown spoiler metadata are not eligible for recaps',async()=>{
 sqlite.prepare("INSERT INTO club_messages(message_id,user_id,thread_id,text,kind,created_at) VALUES(800,77,0,'Why does Captain Example die?','question',?)").run(Date.now()/1000);
 assert.equal(await makeBriefing(env),null);assert.equal(aiCalls.length,0);
});
test('a ten-minute delayed character game starts at clue one and waits between delivered clues',async()=>{
 await startGame(env,800,'character',6);
 Date.now=()=>Date.parse('2026-10-27T06:10:01Z');await drainClub();
 const clues=()=>sent.filter(s=>s.body.text?.startsWith('🧩 Who am I?')).map(s=>Number(s.body.text.match(/Clue (\d)/)[1]));
 assert.deepEqual(clues(),[1]);assert.equal(sqlite.prepare('SELECT last_step_at FROM club_games').get().last_step_at,Date.now()/1000);
 Date.now=()=>Date.parse('2026-10-27T06:15:00Z');await drainClub();assert.deepEqual(clues(),[1]);
 Date.now=()=>Date.parse('2026-10-27T06:15:01Z');await drainClub();assert.deepEqual(clues(),[1,2]);
 Date.now=()=>Date.parse('2026-10-27T06:20:01Z');await drainClub();assert.deepEqual(clues(),[1,2,3]);
});
test('legacy future rounds wait for predecessors and stale rounds cannot rewind progress',async()=>{
 await startGame(env,800,'character',6);
 await queueClub(env,'game:800:2','game_step',{game_id:800,step:2},6);
 Date.now=()=>Date.parse('2026-10-27T06:10:01Z');await drainClub();
 assert.equal(sent.length,1);assert.match(sent[0].body.text,/Clue 1 of 3/);
 await queueClub(env,'stale-step-zero','game_step',{game_id:800,step:0},6);await drainClub();
 assert.equal(sent.length,1);assert.equal(sqlite.prepare("SELECT state FROM club_jobs WHERE job_key='stale-step-zero'").get().state,'cancelled');
 Date.now=()=>Date.parse('2026-10-27T06:15:01Z');await drainClub();assert.equal(sent.length,2);assert.match(sent[1].body.text,/Clue 2 of 3/);
 Date.now=()=>Date.parse('2026-10-27T06:20:01Z');await drainClub();assert.equal(sent.length,3);assert.match(sent[2].body.text,/Clue 3 of 3/);
 assert.equal(sqlite.prepare('SELECT step FROM club_games').get().step,2);
});
test('trivia waits for successful first delivery after 429 before scheduling the next poll',async()=>{
 await startGame(env,800,'trivia',6);globalThis.fetch=async()=>Response.json({ok:false,error_code:429,parameters:{retry_after:600}});await drainClub();
 assert.equal(sqlite.prepare('SELECT step FROM club_games').get().step,-1);
 Date.now=()=>Date.parse('2026-10-27T06:09:00Z');await scheduleClub(env);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM club_jobs WHERE kind='game_step'").get().n,1);
 nativeTelegram();Date.now=()=>Date.parse('2026-10-27T06:10:00Z');await drainClub();assert.equal(sent.length,1);assert.match(sent[0].body.question,/Round 1 of 3/);
 Date.now=()=>Date.parse('2026-10-27T06:12:29Z');await drainClub();assert.equal(sent.length,1);
 Date.now=()=>Date.parse('2026-10-27T06:12:30Z');await drainClub();assert.equal(sent.length,2);assert.match(sent[1].body.question,/Round 2 of 3/);
});
test('unsent games expire without revealing an answer or emitting a catch-up burst',async()=>{
 await startGame(env,800,'character',6);Date.now=()=>Date.parse('2026-10-27T07:01:00Z');await drainClub();
 assert.equal(sent.length,0);assert.equal(sqlite.prepare('SELECT state FROM club_games').get().state,'expired');
});
test('a game solved during queue preparation is rechecked before the clue reaches Telegram',async()=>{
 await startGame(env,800,'character',6);
 const originalPrepare=env.DB.prepare.bind(env.DB);let solved=false;
 env.DB.prepare=sql=>{
  const statement=originalPrepare(sql);
  if(sql.startsWith("UPDATE updates SET state='sending'")){
   const run=statement.run;
   statement.run=async()=>{const result=await run();if(!solved){solved=true;sqlite.exec("UPDATE club_games SET state='solved' WHERE id=800");}return result;};
  }
  return statement;
 };
 await drainClub();assert.equal(sent.length,0);assert.equal(sqlite.prepare('SELECT step FROM club_games').get().step,-1);
});

test('hosting suppresses an excerpt forgotten during final queue preparation',async()=>{
 env.AMBIENT_ENABLED='false';await webhook(update(800,'Who wants to discuss my private watch-party idea?',{from:{id:77}}));
 Date.now=()=>Date.parse('2026-10-27T08:01:00Z');
 const originalPrepare=env.DB.prepare.bind(env.DB);let withdrawn=false;
 env.DB.prepare=sql=>{
  const statement=originalPrepare(sql);
  if(sql.startsWith("UPDATE updates SET state='sending'")){
   const bind=statement.bind,run=statement.run;let body;
   statement.bind=(...args)=>{body=JSON.parse(args[0]);return bind(...args);};
   statement.run=async()=>{const result=await run();if(!withdrawn&&body.text?.startsWith('This question has no recorded reply')){withdrawn=true;await webhook(update(801,'/forget',{from:{id:77}}));}return result;};
  }
  return statement;
 };
 await drainClub();
 assert.ok(withdrawn);
 assert.equal(sent.filter(s=>s.body.text?.startsWith('This question has no recorded reply')).length,0);
});

for(const [withdrawal,remaining] of [['/forget',true],['/optout',true],['/rsvp 100 no',true],['/rsvp 100 yes silent',true],['/forget',false]]){
 test(`event reminder handles ${withdrawal} during final preparation with ${remaining?1:0} remaining attendee`,async()=>{
  nativeTelegram();await webhook(update(100,'/event create Test|2026-10-28 18:00|Room|hongkong'));
  await webhook(update(101,'/event confirm 100'));await drainClub();
  await webhook(update(102,'/rsvp 100 yes remind',{from:{id:77,first_name:'Withdrawn'}}));
  if(remaining)await webhook(update(103,'/rsvp 100 yes remind',{from:{id:78,first_name:'Remaining'}}));
  Date.now=()=>Date.parse('2026-10-28T09:31:00Z');
  const originalPrepare=env.DB.prepare.bind(env.DB);let withdrawn=false;
  env.DB.prepare=sql=>{
   const statement=originalPrepare(sql);
   if(sql.startsWith("UPDATE updates SET state='sending'")){
    const bind=statement.bind,run=statement.run;let body;
    statement.bind=(...args)=>{body=JSON.parse(args[0]);return bind(...args);};
    statement.run=async()=>{const result=await run();if(!withdrawn&&body.text?.startsWith('Opt-in reminder')){withdrawn=true;await webhook(update(104,withdrawal,{from:{id:77}}));}return result;};
   }
   return statement;
  };
  await drainClub();assert.ok(withdrawn);
  assert.equal(sent.filter(s=>s.body.text?.startsWith('Opt-in reminder')).length,0);
  Date.now=()=>Date.parse('2026-10-28T09:36:01Z');await drainClub();
  const reminders=sent.filter(s=>s.body.text?.startsWith('Opt-in reminder'));
  assert.equal(reminders.length,remaining?1:0);
  if(remaining){assert.deepEqual(reminders[0].body.entities.map(e=>e.user.id),[78]);assert.doesNotMatch(reminders[0].body.text,/Withdrawn/);}
  else assert.equal(sqlite.prepare("SELECT state FROM club_jobs WHERE kind='event_reminder'").get().state,'skipped');
 });
}

test('welcome is cancelled if the newcomer forgets during final queue preparation',async()=>{
 const originalPrepare=env.DB.prepare.bind(env.DB);let withdrawn=false;
 env.DB.prepare=sql=>{
  const statement=originalPrepare(sql);
  if(sql.startsWith("UPDATE updates SET state='sending'")){
   const bind=statement.bind,run=statement.run;let body;
   statement.bind=(...args)=>{body=JSON.parse(args[0]);return bind(...args);};
   statement.run=async()=>{const result=await run();if(!withdrawn&&body.text?.startsWith('Welcome aboard')){withdrawn=true;await webhook(update(101,'/forget',{from:{id:77}}));}return result;};
  }
  return statement;
 };
 await webhook(update(100,'',{new_chat_members:[{id:77,first_name:'Withdrawn',is_bot:false}]}));await drainClub();
 assert.ok(withdrawn);assert.equal(sent.filter(s=>s.body.text?.startsWith('Welcome aboard')).length,0);
});

for(const kind of ['trivia','caption'])for(const withdrawal of ['/forget','/optout']){
 test(`${kind} closing rebuilds after ${withdrawal} during final delivery preparation`,async()=>{
  const n=Date.now()/1000;
  sqlite.prepare("INSERT INTO club_games(id,kind,thread_id,opened_at,ends_at,message_id,payload,step) VALUES (800,?,6,?,?,900,'{}',2)").run(kind,n-600,n-1);
  if(kind==='trivia'){sqlite.exec("INSERT INTO members(user_id,name) VALUES (77,'Withdrawn'),(78,'Remaining'); INSERT INTO club_game_answers VALUES (800,0,77,1),(800,0,78,0)");}
  else sqlite.exec("INSERT INTO club_captions VALUES (800,77,'Withdrawn caption'),(800,78,'Remaining caption'); INSERT INTO club_caption_votes VALUES (800,79,77),(800,80,78)");
  const originalPrepare=env.DB.prepare.bind(env.DB);let withdrawn=false;
  env.DB.prepare=sql=>{
   const statement=originalPrepare(sql);
   if(sql.startsWith("UPDATE updates SET state='sending'")){
    const bind=statement.bind,run=statement.run;let body;
    statement.bind=(...args)=>{body=JSON.parse(args[0]);return bind(...args);};
    statement.run=async()=>{const result=await run();if(!withdrawn&&body.text?.includes('— finished')){withdrawn=true;await webhook(update(801,withdrawal,{from:{id:77}}));}return result;};
   }
   return statement;
  };
  await drainClub();assert.ok(withdrawn);assert.equal(sent.filter(s=>s.body.text?.includes('— finished')).length,0);
  Date.now=()=>n*1000+301000;await drainClub();
  const closings=sent.filter(s=>s.body.text?.includes('— finished'));assert.equal(closings.length,1);assert.doesNotMatch(closings[0].body.text,/Withdrawn|entry #1\b/);assert.match(closings[0].body.text,kind==='trivia'?/Remaining/:/entry #2\b/);
 });
}

test('character games hide internal IDs and accept short guesses in topic or reply context',async()=>{
 const id=30000000000055;await startGame(env,id,'character',6,42);await drainClub();
 const clue=sent.find(s=>s.body.text?.startsWith('🧩'));assert.ok(clue);assert.doesNotMatch(clue.body.text,/30000000000055|<character>/);assert.match(clue.body.text,/Clue 1 of 3\n\n/);
 await webhook(update(901,'/answer Yoda',{message_thread_id:6}));assert.equal(sqlite.prepare('SELECT state FROM club_games WHERE id=?').get(id).state,'solved');
 await startGame(env,101,'character',4,42);await drainClub();
 const game=sqlite.prepare('SELECT * FROM club_games WHERE id=101').get();
 await webhook(update(902,'/answer Chewbacca',{message_thread_id:6,reply_to_message:{message_id:game.message_id,from:{id:123,is_bot:true}}}));
 assert.equal(sqlite.prepare('SELECT state FROM club_games WHERE id=101').get().state,'solved');
});
test('short caption and vote commands use displayed entry numbers',async()=>{
 await startGame(env,30000000000054,'caption',6,42);await drainClub();
 await webhook(update(910,'/caption A droid walks into a cantina',{message_thread_id:6,from:{id:77,first_name:'Author'}}));
 await webhook(update(911,'/game show',{message_thread_id:6}));
 const shown=sent.at(-1).body.text;assert.match(shown,/#1 · A droid/);assert.doesNotMatch(shown,/30000000000054|entry 77/);
 await webhook(update(912,'/vote 1',{message_thread_id:6,from:{id:78,first_name:'Voter'}}));assert.equal(sqlite.prepare('SELECT candidate FROM club_caption_votes').get().candidate,77);
});
test('withdrawing a caption voter before closing changes both announcement and awarded bonus',async()=>{
 const n=Date.now()/1000;sqlite.prepare("INSERT INTO club_games(id,kind,thread_id,opened_at,ends_at,message_id,payload,step) VALUES (800,'caption',6,?,?,900,'{}',0)").run(n-90000,n-1);
 sqlite.exec("INSERT INTO club_captions VALUES (800,77,'Caption A'),(800,78,'Caption B'); INSERT INTO club_caption_votes VALUES (800,79,77),(800,80,78)");
 const prepare=env.DB.prepare.bind(env.DB);let withdrawn=false;
 env.DB.prepare=sql=>{const s=prepare(sql);if(sql.startsWith("UPDATE updates SET state='sending'")){const bind=s.bind,run=s.run;let body;s.bind=(...args)=>{body=JSON.parse(args[0]);return bind(...args);};s.run=async()=>{const r=await run();if(!withdrawn&&body.text?.includes('— finished')){withdrawn=true;await webhook(update(801,'/forget',{from:{id:79}}));}return r;};}return s;};
 await drainClub();assert.ok(withdrawn);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM club_points WHERE kind='caption-winner'").get().n,0);
 Date.now=()=>n*1000+301000;await drainClub();
 assert.match(sent.find(s=>s.body.text?.includes('— finished')).body.text,/entry #2/);
 assert.deepEqual(sqlite.prepare("SELECT user_id,points FROM club_points WHERE kind='caption-winner'").all().map(p=>[p.user_id,p.points]),[[78,5]]);
});
test('confirmed caption closing recovers scoring once without resending and forget scrubs its winner snapshot',async()=>{
 const n=Date.now()/1000;sqlite.prepare("INSERT INTO club_games(id,kind,thread_id,opened_at,ends_at,message_id,payload,step) VALUES (800,'caption',6,?,?,900,'{}',0)").run(n-90000,n-1);
 sqlite.exec("INSERT INTO club_captions VALUES (800,77,'Caption A'); INSERT INTO club_caption_votes VALUES (800,79,77)");
 const prepare=env.DB.prepare.bind(env.DB);let failed=false;
 env.DB.prepare=sql=>{const s=prepare(sql);if(sql.startsWith('INSERT OR IGNORE INTO club_points')){const run=s.run;s.run=async()=>{if(!failed){failed=true;throw Error('temporary scoring failure');}return run();};}return s;};
 await drainClub();assert.ok(failed);assert.equal(sent.filter(s=>s.body.text?.includes('— finished')).length,1);
 await scheduleGames(env);await scheduleGames(env);assert.equal(sqlite.prepare('SELECT state FROM club_games').get().state,'closed');assert.equal(sqlite.prepare('SELECT SUM(points) n FROM club_points').get().n,5);
 await webhook(update(920,'/forget',{from:{id:77}}));const data=JSON.parse(sqlite.prepare("SELECT data FROM club_jobs WHERE kind='game_close'").get().data);assert.deepEqual(data.closing_winners,[]);
 assert.equal(sent.filter(s=>s.body.text?.includes('— finished')).length,1);
});
