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

test('120 distinct unchanged Reddit image assets have source attribution and Telegram-compatible dimensions',()=>{
 assert.equal(roster.length,120);assert.equal(new Set(roster.map(r=>r.sha256)).size,120);
 for(const r of roster){
  const bytes=readFileSync(new URL('../data/memes/'+r.file,import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),r.sha256);
  assert.equal(bytes.length,r.bytes);assert.ok(bytes.length<10*1024*1024);
  assert.ok(bytes.subarray(0,3).toString('hex')==='ffd8ff'||bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a');
  assert.ok(r.width+r.height<=10000&&Math.max(r.width/r.height,r.height/r.width)<=20);
  assert.match(r.source_url,/^https:\/\/www\.reddit\.com\/r\/[^/]+\/comments\//);assert.ok(r.author);
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
test('sends only a photo to Memes and caches confirmed Telegram file ID',async()=>{
 await queue();assert.equal(sent.length,1);assert.equal(sent[0].method,'sendPhoto');
 assert.equal(sent[0].body.message_thread_id,22);assert.equal(sent[0].body.chat_id,-100123);
 assert.equal(Object.hasOwn(sent[0].body,'caption'),false);assert.equal(Object.hasOwn(sent[0].body,'caption_entities'),false);
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

test('legacy photo retries drop captions before sending and persist only the image across rate limits',async()=>{
 const post=await memePost(env,1000);
 const payload={internal_post:{kind:'memes',scheduled_at:now/1000,requested:true}};
 const oldBody={chat_id:-100123,message_thread_id:22,photo:post.photo,caption:'Old source credit',caption_entities:[{type:'text_link',offset:0,length:17,url:roster[0].source_url}],parse_mode:'HTML',show_caption_above_media:true};
 sqlite.prepare('INSERT INTO updates(id,payload,created_at,outbound,method) VALUES (?,?,?,?,?)').run(1000,JSON.stringify(payload),now/1000,JSON.stringify(oldBody),'sendPhoto');
 const success=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{sent.push({method:String(url).split('/').at(-1),body:JSON.parse(options.body)});return Response.json({ok:false,error_code:429,parameters:{retry_after:1}});};
 await processUpdate(env,1000);
 const expected={chat_id:-100123,message_thread_id:22,photo:post.photo};
 assert.deepEqual(sent[0].body,expected);
 assert.deepEqual(JSON.parse(sqlite.prepare('SELECT outbound FROM updates WHERE id=1000').get().outbound),expected);
 globalThis.fetch=success;ready(1000);await processUpdate(env,1000);
 assert.deepEqual(sent[1].body,expected);
 assert.equal(sqlite.prepare('SELECT message_id FROM meme_deliveries WHERE update_id=1000').get().message_id,101);
});
test('Reddit seed retires old images atomically and preserves removals, cached IDs and rotation on reimport',()=>{
 sqlite.exec("INSERT INTO meme_roster(id,image_url,source_url,author,sha256) VALUES ('imgflip-old','https://example.com/old.jpg','https://imgflip.com/i/old','old','oldhash')");
 const seed=readFileSync(new URL('../data/memes/seed.sql',import.meta.url),'utf8');
 sqlite.exec('BEGIN');sqlite.exec(seed);sqlite.exec('COMMIT');
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM meme_roster WHERE active=1').get().n,120);
 assert.equal(sqlite.prepare("SELECT active FROM meme_roster WHERE id='imgflip-old'").get().active,0);
 sqlite.prepare("UPDATE meme_roster SET active=0,file_id='cached',last_selected=99 WHERE id=?").run(roster[0].id);
 sqlite.exec(seed);const row=sqlite.prepare('SELECT * FROM meme_roster WHERE id=?').get(roster[0].id);
 assert.equal(row.active,0);assert.equal(row.file_id,'cached');assert.equal(row.last_selected,99);
 assert.match(row.image_url,/raw\.githubusercontent\.com\/yessur3808\/sw-bot\/[a-f0-9]{40}\//);
});
