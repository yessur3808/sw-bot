import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {portalFixture} from './portal-fixture.mjs';
import {memePost,memeDelivered} from '../memes.mjs';
import {processUpdate} from '../index.mjs';

let env,sqlite,realNow,realFetch,now,sent;
const roster=JSON.parse(readFileSync(new URL('../data/memes/roster.json',import.meta.url)));
beforeEach(()=>{
 ({env,sqlite}=portalFixture());realNow=Date.now;realFetch=globalThis.fetch;
 now=Date.parse('2026-10-31T10:00:00+08:00');Date.now=()=>now;sent=[];
 sqlite.exec("INSERT INTO topic_map VALUES ('memes',22)");
 for(const r of roster)sqlite.prepare('INSERT INTO meme_roster(id,image_url,source_url,author,sha256) VALUES (?,?,?,?,?)').run(r.id,r.image_url,r.source_url,r.author,r.sha256);
 globalThis.fetch=async(url,options)=>{sent.push({method:String(url).split('/').at(-1),body:JSON.parse(options.body)});return Response.json({ok:true,result:{message_id:101,photo:[{file_id:'small'},{file_id:'cached-photo'}]}});};
});
afterEach(()=>{Date.now=realNow;globalThis.fetch=realFetch;sqlite.close();});
async function queue(id=1,requested=true){sqlite.prepare('INSERT INTO updates(id,payload,created_at) VALUES (?,?,?)').run(id,JSON.stringify({internal_post:{kind:'memes',scheduled_at:now/1000,requested}}),now/1000);await processUpdate(env,id);}
function ready(id=1){sqlite.prepare("UPDATE updates SET ready_at=0 WHERE id=?").run(id);}

test('120 distinct unchanged JPEG assets have source attribution and Telegram-compatible dimensions',()=>{
 assert.equal(roster.length,120);assert.equal(new Set(roster.map(r=>r.sha256)).size,120);
 for(const r of roster){
  const bytes=readFileSync(new URL('../data/memes/'+r.file,import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),r.sha256);
  assert.equal(bytes.length,r.bytes);assert.ok(bytes.length<10*1024*1024);
  assert.equal(bytes.subarray(0,3).toString('hex'),'ffd8ff');
  assert.ok(r.width+r.height<=10000&&Math.max(r.width/r.height,r.height/r.width)<=20);
  assert.match(r.source_url,/^https:\/\/imgflip.com\//);assert.ok(r.author);
 }
});
test('atomic selection cycles through all 120 before repeats and reuses selection on retry',async()=>{
 const ids=[];for(let i=1;i<=120;i++)ids.push((await memePost(env,i)).meme_id);
 assert.equal(new Set(ids).size,120);
 assert.equal((await memePost(env,120)).meme_id,ids[119]);
 assert.equal((await memePost(env,121)).meme_id,ids[0]);
 await memeDelivered(env,121,{message_id:100,photo:[{file_id:'reuse'}]});
 assert.equal(await memePost(env,121),null);
});
test('sends a photo to Memes, retains attribution and caches confirmed Telegram file ID',async()=>{
 await queue();assert.equal(sent.length,1);assert.equal(sent[0].method,'sendPhoto');
 assert.equal(sent[0].body.message_thread_id,22);assert.equal(sent[0].body.chat_id,-100123);
 assert.match(sent[0].body.caption,/Shared by/);assert.equal(sent[0].body.caption_entities[0].type,'text_link');
 const row=sqlite.prepare('SELECT * FROM meme_roster WHERE last_sent_at IS NOT NULL').get();assert.equal(row.file_id,'cached-photo');
 sqlite.prepare('UPDATE meme_roster SET active=0 WHERE id<>?').run(row.id);
 const next=await memePost(env,2);assert.equal(next.photo,'cached-photo');
 await processUpdate(env,1);assert.equal(sent.length,1);
});
test('empty or disabled roster, missing binding and paused bot produce no text fallback',async()=>{
 sqlite.exec('UPDATE meme_roster SET active=0');await queue(1);assert.equal(sent.length,0);
 sqlite.exec("UPDATE meme_roster SET active=1; DELETE FROM topic_map WHERE name='memes'");await queue(2);assert.equal(sent.length,0);
 sqlite.exec("INSERT INTO topic_map VALUES ('memes',22); INSERT INTO settings VALUES ('paused','1')");await queue(3);assert.equal(sent.length,0);
});
test('rate-limit retry keeps the photo and refuses an image disabled before retry',async()=>{
 globalThis.fetch=async(url,options)=>{sent.push(JSON.parse(options.body));return Response.json({ok:false,error_code:429,parameters:{retry_after:1}});};
 await queue();const first=sent[0].photo;ready();await processUpdate(env,1);assert.equal(sent[1].photo,first);
 sqlite.exec('UPDATE meme_roster SET active=0');ready();await processUpdate(env,1);assert.equal(sent.length,2);
 assert.equal(sqlite.prepare('SELECT error FROM updates WHERE id=1').get().error,'delivery-invalidated');
});
test('cached retry rechecks topic binding and does not deliver to the old topic',async()=>{
 globalThis.fetch=async()=>Response.json({ok:false,error_code:429});await queue();
 sqlite.exec("UPDATE topic_map SET thread_id=23 WHERE name='memes'");ready();
 globalThis.fetch=async()=>{throw Error('must not send');};await processUpdate(env,1);
 assert.equal(sqlite.prepare('SELECT error FROM updates WHERE id=1').get().error,'delivery-invalidated');
});
test('automatic images obey quiet hours and daily budget; portal review mode never emits text',async()=>{
 now=Date.parse('2026-10-31T03:00:00+08:00');await queue(1,false);assert.equal(sent.length,0);
 now=Date.parse('2026-10-31T10:00:00+08:00');env.AUTOMATED_DAILY_CAP='5';
 for(let i=1;i<=5;i++)sqlite.prepare('INSERT INTO automated_budget VALUES (?,?)').run('2026-10-31',-i);
 await queue(2,false);assert.equal(sent.length,0);assert.equal(sqlite.prepare('SELECT error FROM updates WHERE id=2').get().error,'automated-budget-exhausted');
 sqlite.exec("DELETE FROM automated_budget; DELETE FROM engagement_posts; INSERT INTO settings VALUES ('portal_starter_approval','1')");
 await queue(3,false);assert.equal(sent.length,0);
});
test('crossing midnight during the final image guard defers without sending',async()=>{
 const base=env.DB.prepare.bind(env.DB);let crossed=false;
 env.DB.prepare=sql=>{const s=base(sql);if(sql.includes('SELECT m.image_url,m.file_id,t.thread_id')){const first=s.first.bind(s);s.first=async()=>{const out=await first();crossed=true;now=Date.parse('2026-11-01T00:00:00+08:00');return out;};}return s;};
 await queue(1,false);assert.ok(crossed);assert.equal(sent.length,0);assert.equal(sqlite.prepare('SELECT state FROM updates WHERE id=1').get().state,'queued');
});

test('legacy queued text-only meme deliveries are invalidated',async()=>{
 sqlite.prepare('INSERT INTO updates(id,payload,created_at,outbound,method) VALUES (?,?,?,?,?)').run(10,JSON.stringify({internal_post:{kind:'memes',scheduled_at:now/1000,requested:true}}),now/1000,JSON.stringify({chat_id:-100123,message_thread_id:22,text:'Old caption challenge'}),'sendMessage');
 await processUpdate(env,10);assert.equal(sent.length,0);assert.equal(sqlite.prepare('SELECT error FROM updates WHERE id=10').get().error,'delivery-invalidated');
});
