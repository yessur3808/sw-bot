import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {portalFixture} from './portal-fixture.mjs';
import {topicContentImport} from '../scripts/topic-content-import.mjs';
import {changePost,schedulePortalPosts,portalPostBody,claimPortalPost} from '../portal-content.mjs';
const now=()=>Math.floor(Date.now()/1000);
let realNow;
beforeEach(()=>{
 realNow=Date.now;
 // Tomorrow at 12:00 HKT: deterministic waking hours, later than SQLite's
 // wall clock used by the atomic event-expiry predicate.
 const at=Math.floor((realNow()+28800000)/86400000)*86400000+86400000+14400000;
 Date.now=()=>at;
});
afterEach(()=>{Date.now=realNow;});
const entry={topic:'hongkong',kind:'text',text:'Confirmed event details and official source.',source:{title:'Organizer',type:'official',url:'https://example.org/event'},topics:['local events']};
const identity={groupId:'-100123',environment:'test',adminId:42};
test('curated topic drafts never publish to a fallback and resolve a later binding',async()=>{
 const {sqlite,env}=portalFixture();try{
  const q=topicContentImport([entry],identity);assert.equal(sqlite.prepare(q.sql).run(...q.params).changes,1);
  const p=sqlite.prepare('SELECT * FROM admin_posts').get();assert.equal(p.thread_id,0);assert.equal(p.state,'draft');
  assert.equal(sqlite.prepare(q.sql).run(...q.params).changes,0);
  await changePost(env,42,p.id,1,'approve');await assert.rejects(changePost(env,42,p.id,1,'publish'),/Bind the hongkong/);
  sqlite.exec("INSERT INTO topic_map VALUES ('hongkong',25)");
  const published=await changePost(env,42,p.id,1,'publish');assert.equal(published.thread_id,25);
  await schedulePortalPosts(env);const job=sqlite.prepare('SELECT * FROM club_jobs').get();
  assert.equal((await portalPostBody(env,job)).body.message_thread_id,25);
  sqlite.exec("UPDATE topic_map SET thread_id=26 WHERE name='hongkong'");
  assert.equal(await portalPostBody(env,job),null);assert.equal(await claimPortalPost(env,job),'cancel');assert.equal(sqlite.prepare('SELECT state FROM admin_posts').get().state,'draft');
 }finally{sqlite.close();}
});
test('expired event drafts and future schedules beyond expiry cannot publish; delivery rechecks expiry',async()=>{
 const {sqlite,env}=portalFixture();try{
  sqlite.exec("INSERT INTO topic_map VALUES ('hongkong',25)");
  const q=topicContentImport([{...entry,expires_at:now()+60}],identity);sqlite.prepare(q.sql).run(...q.params);
  await changePost(env,42,1,1,'approve');await assert.rejects(changePost(env,42,1,1,'publish',{scheduled_at:now()+120}),/expired/);
  await changePost(env,42,1,1,'publish');await schedulePortalPosts(env);const job=sqlite.prepare('SELECT * FROM club_jobs').get();
  sqlite.prepare("UPDATE admin_posts SET import_metadata=json_set(import_metadata,'$.expires_at',?) WHERE id=1").run(now()-1);
  assert.equal(await portalPostBody(env,job),null);assert.equal(await claimPortalPost(env,job),'cancel');assert.equal(sqlite.prepare('SELECT state FROM admin_posts').get().state,'expired');
 }finally{sqlite.close();}
});

for(const scenario of ['mapping','expiry'])test('final claim rejects '+scenario+' changes during its database await',async()=>{
 const {sqlite,env}=portalFixture(),originalNow=Date.now;try{
  sqlite.exec("INSERT INTO topic_map VALUES ('hongkong',25)");
  const cutoff=now()+60,q=topicContentImport([{...entry,expires_at:cutoff}],identity);sqlite.prepare(q.sql).run(...q.params);
  await changePost(env,42,1,1,'approve');await changePost(env,42,1,1,'publish');await schedulePortalPosts(env);const job=sqlite.prepare('SELECT * FROM club_jobs').get();
  assert.ok(await portalPostBody(env,job));
  const prepare=env.DB.prepare.bind(env.DB);env.DB.prepare=sql=>{
   const statement=prepare(sql);
   if(sql.startsWith("UPDATE admin_posts SET state='sending'")){
    const run=statement.run;statement.run=async()=>{
     if(scenario==='mapping')sqlite.exec("UPDATE topic_map SET thread_id=26 WHERE name='hongkong'");
     const result=await run();if(scenario==='expiry')Date.now=()=>cutoff*1000;return result;
    };
   }return statement;
  };
  assert.equal(await claimPortalPost(env,job),'cancel');
  const post=sqlite.prepare('SELECT * FROM admin_posts').get();assert.equal(post.state,scenario==='expiry'?'expired':'draft');assert.equal(post.approved_revision,null);assert.equal(post.job_id,null);
 }finally{Date.now=originalNow;sqlite.close();}
});
