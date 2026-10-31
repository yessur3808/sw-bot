import test from 'node:test';
import assert from 'node:assert/strict';
import {portalFixture} from './portal-fixture.mjs';
import {mediaFetch,YOUTUBE_CHANNELS,trailerTopic,youtubeStatus} from '../youtube.mjs';
const secret='a'.repeat(64),channel=YOUTUBE_CHANNELS[0].id;
const at=Date.parse('2026-10-29T05:00:00Z');
const req=(path,data)=>new Request('https://bot.example/media/'+path,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+secret,...data?{'Content-Type':'application/json'}:{}},...data?{body:JSON.stringify(data)}:{}});
const item=(id='AbcDefGh123')=>({id,title:'Star Wars: Galactic Racer | Official Launch Trailer',channel_id:channel,timestamp:at/1000-600,duration:120});
async function fixture(fn){const {sqlite,env}=portalFixture();env.MEDIA_AGENT_SECRET=secret;sqlite.exec("INSERT INTO topic_map VALUES ('gaming',19),('tv',18)");const old=Date.now;Date.now=()=>at;try{await fn(sqlite,env);}finally{Date.now=old;sqlite.close();}}
async function scan(env,items){return mediaFetch(req('scan',{channel_id:channel,status:'ok',items}),env);}
async function ready(env){await scan(env,[item('Baseline001')]);await scan(env,[item()]);}
const upload=()=>new Request('https://bot.example/media/upload/AbcDefGh123',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'video/mp4','Content-Length':'2000'},body:new Uint8Array(2000)});
test('trailer routing rejects unofficial, reaction and ambiguous content',()=>{
 assert.equal(trailerTopic(item().title,'',channel),'gaming');
 assert.equal(trailerTopic('The Mandalorian and Grogu | Official Trailer','',channel),'movies');
 assert.equal(trailerTopic('Ahsoka Season 2 | Official Teaser','',channel),'tv');
 assert.equal(trailerTopic('New Star Wars | Official Trailer','An original series streaming on Disney+',channel),'tv');
 assert.equal(trailerTopic('New Star Wars | Official Trailer','Coming to theaters and a video game for Xbox',channel),null);
 assert.equal(trailerTopic('Star Wars: Galactic Racer Trailer Reaction','',channel),null);
 assert.equal(trailerTopic(item().title,'','fake'),null);
});
test('media ingress requires scoped auth and deployment identity',()=>fixture(async(db,env)=>{
 assert.equal((await mediaFetch(new Request('https://bot.example/media/monitor'),env)).status,401);
 assert.equal((await mediaFetch(req('monitor'),{...env,DEPLOYMENT_ENABLED:'false'})).status,500);
 assert.equal((await mediaFetch(req('scan',{channel_id:'fake',items:[]}),env)).status,400);
}));
test('baseline, stale titles, wrong channel and duplicate scans cannot cause uploads',()=>fixture(async(db,env)=>{
 await ready(env);await scan(env,[item()]);
 const rows=db.prepare('SELECT state,reason FROM youtube_videos ORDER BY id').all();
 assert.equal(rows.length,2);assert.equal(rows[0].reason,'initial_baseline');assert.equal(rows[1].state,'pending');
 await scan(env,[{...item('WrongUser01'),channel_id:'fake'},{...item('OldVideo001'),timestamp:at/1000-8*86400},{...item('Mystery0001'),title:'Star Wars | Official Trailer'}]);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM youtube_videos WHERE state='pending'").get().n,1);
 assert.equal(db.prepare("SELECT state FROM youtube_videos WHERE video_id='Mystery0001'").get().state,'review');
 assert.equal((await youtubeStatus(env)).channels[0].status,'ok');
}));
test('empty scans do not initialise baseline and unknown routes do not bypass auth',()=>fixture(async(db,env)=>{
 assert.equal((await scan(env,[])).status,422);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM youtube_videos').get().n,0);
 assert.equal((await mediaFetch(req('unknown'),env)).status,404);
}));
test('video send uses fixed group topic, attribution and spoiler protection, then deduplicates',()=>fixture(async(db,env)=>{
 await ready(env);const original=fetch;let calls=0;
 globalThis.fetch=async(url,options)=>{calls++;assert.match(url,/sendVideo$/);const form=await new Response(options.body,{headers:options.headers}).formData();assert.equal(form.get('chat_id'),'-100123');assert.equal(form.get('message_thread_id'),'19');assert.equal(form.get('has_spoiler'),'true');assert.match(form.get('caption'),/youtube.com\/watch\?v=AbcDefGh123/);assert.equal(form.get('video').size,2000);return Response.json({ok:true,result:{message_id:123}});};
 try{assert.equal((await mediaFetch(upload(),env)).status,200);assert.equal((await mediaFetch(upload(),env)).status,409);assert.equal(calls,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM automated_budget').get().n,1);}finally{globalThis.fetch=original;}
}));
test('midnight, paused, busy, unbound and exhausted budget prevent video delivery',()=>fixture(async(db,env)=>{
 await ready(env);const original=fetch,oldNow=Date.now;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('must not send');};
 try{
  Date.now=()=>Date.parse('2026-10-29T17:00:00Z');assert.equal((await mediaFetch(upload(),env)).status,409);Date.now=oldNow;
  db.exec("INSERT INTO settings VALUES ('paused','1')");assert.equal((await mediaFetch(upload(),env)).status,409);db.exec("DELETE FROM settings WHERE key='paused'");
  db.exec('INSERT INTO activity VALUES (123,19,'+(at/1000)+')');assert.equal((await mediaFetch(upload(),env)).status,409);db.exec('DELETE FROM activity');
  db.exec("DELETE FROM topic_map WHERE name='gaming'");assert.equal((await mediaFetch(upload(),env)).status,409);db.exec("INSERT INTO topic_map VALUES ('gaming',19)");
  for(let i=0;i<20;i++)db.prepare('INSERT INTO automated_budget VALUES (?,?)').run('2026-10-29',i);
  assert.equal((await mediaFetch(upload(),env)).status,409);assert.equal(calls,0);
 }finally{globalThis.fetch=original;Date.now=oldNow;}
}));
test('ambiguous Telegram response and interrupted sends are never automatically retried',()=>fixture(async(db,env)=>{
 await ready(env);const original=fetch;globalThis.fetch=async()=>{throw Error('connection dropped');};
 try{assert.equal((await mediaFetch(upload(),env)).status,202);assert.equal((await mediaFetch(upload(),env)).status,409);assert.equal(db.prepare("SELECT state FROM youtube_videos WHERE video_id='AbcDefGh123'").get().state,'uncertain');}finally{globalThis.fetch=original;}
 db.exec("UPDATE youtube_videos SET state='sending',attempted_at="+(at/1000-400)+" WHERE video_id='AbcDefGh123'");
 const response=await mediaFetch(req('monitor'),env);assert.equal((await response.json()).jobs.length,0);
 assert.equal(db.prepare("SELECT state FROM youtube_videos WHERE video_id='AbcDefGh123'").get().state,'uncertain');
}));
test('Telegram rate limit retries later; definitive rejection is held',()=>fixture(async(db,env)=>{
 await ready(env);const original=fetch;globalThis.fetch=async()=>Response.json({ok:false,error_code:429,parameters:{retry_after:120}});
 try{assert.equal((await mediaFetch(upload(),env)).status,429);assert.equal((await mediaFetch(upload(),env)).status,409);db.exec("UPDATE youtube_videos SET ready_at=0");globalThis.fetch=async()=>Response.json({ok:false,error_code:400});assert.equal((await mediaFetch(upload(),env)).status,202);assert.equal(db.prepare("SELECT state FROM youtube_videos WHERE video_id='AbcDefGh123'").get().state,'failed');}finally{globalThis.fetch=original;}
}));
test('topic remap or pause during the final claim defers without sending to the old destination',()=>fixture(async(db,env)=>{
 await ready(env);const original=fetch,prepare=env.DB.prepare;let calls=0;
 globalThis.fetch=async()=>{calls++;throw Error('must not send');};
 env.DB.prepare=function(sql){const st=prepare(sql);if(sql.includes("SET state='sending'")){const run=st.run;st.run=async()=>{const r=await run();db.exec("UPDATE topic_map SET thread_id=99 WHERE name='gaming'");return r;};}return st;};
 try{assert.equal((await mediaFetch(upload(),env)).status,409);assert.equal(calls,0);assert.equal(db.prepare("SELECT state FROM youtube_videos WHERE video_id='AbcDefGh123'").get().state,'pending');}finally{globalThis.fetch=original;env.DB.prepare=prepare;}
}));
test('concurrent uploads claim one send and oversized files never enter sending state',()=>fixture(async(db,env)=>{
 await ready(env);const original=fetch;let calls=0,release;const gate=new Promise(r=>{release=r;});
 globalThis.fetch=async()=>{calls++;await gate;return Response.json({ok:true,result:{message_id:9}});};
 try{
  const large=new Request('https://bot.example/media/upload/AbcDefGh123',{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'video/mp4','Content-Length':'50000001'},body:'large'});
  assert.equal((await mediaFetch(large,env)).status,413);
  const first=mediaFetch(upload(),env);await new Promise(r=>setTimeout(r,5));const second=await mediaFetch(upload(),env);release();assert.equal(second.status,409);assert.equal((await first).status,200);assert.equal(calls,1);
 }finally{release();globalThis.fetch=original;}
}));
