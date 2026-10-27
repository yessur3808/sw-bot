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
