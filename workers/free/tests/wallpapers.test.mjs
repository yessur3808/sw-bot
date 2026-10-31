import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {portalFixture} from './portal-fixture.mjs';
import {wallpaperPost,wallpaperDelivered} from '../wallpapers.mjs';
import {processUpdate} from '../index.mjs';

let env,sqlite,realNow,realFetch,now,sent;
const roster=JSON.parse(readFileSync(new URL('../data/wallpapers/roster.json',import.meta.url)));
beforeEach(()=>{
 ({env,sqlite}=portalFixture());realNow=Date.now;realFetch=globalThis.fetch;
 now=Date.parse('2026-10-31T10:00:00+08:00');Date.now=()=>now;sent=[];
 sqlite.exec("INSERT INTO topic_map VALUES ('wallpapers',26)");
 for(const r of roster)sqlite.prepare('INSERT INTO wallpaper_roster(id,image_url,source_url,sha256) VALUES (?,?,?,?)').run(r.id,r.image_url,r.source_url,r.sha256);
 globalThis.fetch=async(url,options)=>{sent.push({method:String(url).split('/').at(-1),body:JSON.parse(options.body)});return Response.json({ok:true,result:{message_id:101,photo:[{file_id:'small'},{file_id:'cached-photo'}]}});};
});
afterEach(()=>{Date.now=realNow;globalThis.fetch=realFetch;sqlite.close();});
async function queue(id=1,requested=true){sqlite.prepare('INSERT INTO updates(id,payload,created_at) VALUES (?,?,?)').run(id,JSON.stringify({internal_post:{kind:'wallpapers',scheduled_at:now/1000,requested}}),now/1000);await processUpdate(env,id);}
function ready(id=1){sqlite.prepare("UPDATE updates SET ready_at=0 WHERE id=?").run(id);}

test('30 distinct wallpaper assets match their manifest and Telegram photo limits',()=>{
 assert.equal(roster.length,30);assert.equal(new Set(roster.map(r=>r.sha256)).size,30);
 for(const r of roster){
  const bytes=readFileSync(new URL('../data/wallpapers/'+r.file,import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),r.sha256);
  assert.equal(bytes.length,r.bytes);assert.ok(bytes.length<10*1024*1024);
  assert.ok(bytes.subarray(0,3).toString('hex')==='ffd8ff'||bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a');
  assert.ok(r.width+r.height<=10000&&Math.max(r.width/r.height,r.height/r.width)<=20);
  assert.match(r.source_url,/^https:\/\/www\.pinterest\.com\//);
 }
});
test('atomic selection cycles through all 30 before repeats and reuses selection on retry',async()=>{
 const ids=[];for(let i=1;i<=30;i++)ids.push((await wallpaperPost(env,i)).wallpaper_id);
 assert.equal(new Set(ids).size,30);
 assert.equal((await wallpaperPost(env,30)).wallpaper_id,ids[29]);
 assert.equal((await wallpaperPost(env,31)).wallpaper_id,ids[0]);
 await wallpaperDelivered(env,31,{message_id:100,photo:[{file_id:'reuse'}]});
 assert.equal(await wallpaperPost(env,31),null);
});
test('sends only a photo to Wallpapers and caches confirmed Telegram file ID',async()=>{
 await queue();assert.equal(sent.length,1);assert.equal(sent[0].method,'sendPhoto');
 assert.equal(sent[0].body.message_thread_id,26);assert.equal(sent[0].body.chat_id,-100123);
 assert.equal(Object.hasOwn(sent[0].body,'caption'),false);assert.equal(Object.hasOwn(sent[0].body,'caption_entities'),false);
 const row=sqlite.prepare('SELECT * FROM wallpaper_roster WHERE last_sent_at IS NOT NULL').get();assert.equal(row.file_id,'cached-photo');
 sqlite.prepare('UPDATE wallpaper_roster SET active=0 WHERE id<>?').run(row.id);
 const next=await wallpaperPost(env,2);assert.equal(next.photo,'cached-photo');
 await processUpdate(env,1);assert.equal(sent.length,1);
});
test('empty or disabled roster, missing binding and paused bot produce no text fallback',async()=>{
 sqlite.exec('UPDATE wallpaper_roster SET active=0');await queue(1);assert.equal(sent.length,0);
 sqlite.exec("UPDATE wallpaper_roster SET active=1; DELETE FROM topic_map WHERE name='wallpapers'");await queue(2);assert.equal(sent.length,0);
 sqlite.exec("INSERT INTO topic_map VALUES ('wallpapers',26); INSERT INTO settings VALUES ('paused','1')");await queue(3);assert.equal(sent.length,0);
});
test('rate-limit retry keeps the photo and refuses an image disabled before retry',async()=>{
 globalThis.fetch=async(url,options)=>{sent.push(JSON.parse(options.body));return Response.json({ok:false,error_code:429,parameters:{retry_after:1}});};
 await queue();const first=sent[0].photo;ready();await processUpdate(env,1);assert.equal(sent[1].photo,first);
 sqlite.exec('UPDATE wallpaper_roster SET active=0');ready();await processUpdate(env,1);assert.equal(sent.length,2);
 assert.equal(sqlite.prepare('SELECT error FROM updates WHERE id=1').get().error,'delivery-invalidated');
});
test('cached retry rechecks topic binding and does not deliver to the old topic',async()=>{
 globalThis.fetch=async()=>Response.json({ok:false,error_code:429});await queue();
 sqlite.exec("UPDATE topic_map SET thread_id=23 WHERE name='wallpapers'");ready();
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

test('legacy queued text-only wallpaper deliveries are invalidated',async()=>{
 sqlite.prepare('INSERT INTO updates(id,payload,created_at,outbound,method) VALUES (?,?,?,?,?)').run(10,JSON.stringify({internal_post:{kind:'wallpapers',scheduled_at:now/1000,requested:true}}),now/1000,JSON.stringify({chat_id:-100123,message_thread_id:26,text:'Old caption challenge'}),'sendMessage');
 await processUpdate(env,10);assert.equal(sent.length,0);assert.equal(sqlite.prepare('SELECT error FROM updates WHERE id=10').get().error,'delivery-invalidated');
});

test('legacy photo retries drop captions before sending and persist only the image across rate limits',async()=>{
 const post=await wallpaperPost(env,1000);
 const payload={internal_post:{kind:'wallpapers',scheduled_at:now/1000,requested:true}};
 const oldBody={chat_id:-100123,message_thread_id:26,photo:post.photo,caption:'Old source credit',caption_entities:[{type:'text_link',offset:0,length:17,url:roster[0].source_url}],parse_mode:'HTML',show_caption_above_media:true,reply_markup:{inline_keyboard:[[{text:'Source',url:roster[0].source_url}]]}};
 sqlite.prepare('INSERT INTO updates(id,payload,created_at,outbound,method) VALUES (?,?,?,?,?)').run(1000,JSON.stringify(payload),now/1000,JSON.stringify(oldBody),'sendPhoto');
 const success=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{sent.push({method:String(url).split('/').at(-1),body:JSON.parse(options.body)});return Response.json({ok:false,error_code:429,parameters:{retry_after:1}});};
 await processUpdate(env,1000);
 const expected={chat_id:-100123,message_thread_id:26,photo:post.photo};
 assert.deepEqual(sent[0].body,expected);
 assert.deepEqual(JSON.parse(sqlite.prepare('SELECT outbound FROM updates WHERE id=1000').get().outbound),expected);
 globalThis.fetch=success;ready(1000);await processUpdate(env,1000);
 assert.deepEqual(sent[1].body,expected);
 assert.equal(sqlite.prepare('SELECT message_id FROM wallpaper_deliveries WHERE update_id=1000').get().message_id,101);
});
test('seed import preserves rotation, cached IDs and manual removals',()=>{
 const seed=readFileSync(new URL('../data/wallpapers/seed.sql',import.meta.url),'utf8');
 sqlite.prepare("UPDATE wallpaper_roster SET active=0,file_id='cached',last_selected=99 WHERE id=?").run(roster[0].id);
 sqlite.exec(seed);const row=sqlite.prepare('SELECT * FROM wallpaper_roster WHERE id=?').get(roster[0].id);
 assert.equal(row.active,0);assert.equal(row.file_id,'cached');assert.equal(row.last_selected,99);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM wallpaper_roster').get().n,30);
 assert.match(row.image_url,/raw\.githubusercontent\.com\/yessur3808\/sw-bot\/[a-f0-9]{40}\//);
});
test('cached legacy engagement text is skipped without sending a prompt or poll',async()=>{
 for(const [id,post] of [[50,{text:'Old wallpaper concept'}],[51,{question:'Old wallpaper poll',options:['A','B']}]] ){
  sqlite.prepare('INSERT INTO engagement_posts(update_id,kind,seed,text,payload,created_at) VALUES (?,?,?,?,?,?)').run(id,'wallpapers','legacy','legacy',JSON.stringify(post),now/1000);
  await queue(id);
 }
 assert.equal(sent.length,0);
});
test('wallpaper delivery cannot use the meme topic or an unselected image',async()=>{
 const post=await wallpaperPost(env,77);
 sqlite.exec("INSERT INTO topic_map VALUES ('memes',22)");
 for(const [id,body] of [[77,{chat_id:-100123,message_thread_id:22,photo:post.photo}],[78,{chat_id:-100123,message_thread_id:26,photo:'https://example.com/unselected.jpg'}]]){
  if(id===78)await wallpaperPost(env,id);
  sqlite.prepare('INSERT INTO updates(id,payload,created_at,outbound,method) VALUES (?,?,?,?,?)').run(id,JSON.stringify({internal_post:{kind:'wallpapers',requested:true,scheduled_at:now/1000}}),now/1000,JSON.stringify(body),'sendPhoto');
  await processUpdate(env,id);
  assert.equal(sqlite.prepare('SELECT error FROM updates WHERE id=?').get(id).error,'delivery-invalidated');
 }
 assert.equal(sent.length,0);
});
