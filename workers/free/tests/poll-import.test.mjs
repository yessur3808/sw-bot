import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {portalFixture} from './portal-fixture.mjs';
import {pollImport,pollRows} from '../scripts/poll-import.mjs';
import {changePost,schedulePortalPosts,portalPostBody} from '../portal-content.mjs';

const entries=JSON.parse(readFileSync(new URL('../data/star-wars-polls-2026-10-28.json',import.meta.url),'utf8'));
const identity={groupId:'-100123',environment:'test',adminId:42};
test('128 polls import as inert native drafts with exact metadata and existing-topic routing',async()=>{
 const {sqlite,env}=portalFixture();try{
  sqlite.exec("INSERT INTO topic_map VALUES ('gaming',128)");
  const q=pollImport(entries,identity);assert.equal(sqlite.prepare(q.sql).run(...q.params).changes,128);
  const posts=sqlite.prepare('SELECT * FROM admin_posts ORDER BY id').all(),mapped=pollRows(entries);
  for(const [i,p] of posts.entries()){
   assert.equal(p.kind,'poll');assert.equal(p.text,entries[i].question);assert.deepEqual(JSON.parse(p.options),entries[i].options);assert.deepEqual(JSON.parse(p.import_metadata),entries[i]);
   assert.equal(p.thread_id,mapped[i].topic==='gaming'?128:mapped[i].topic==='movies'?4:6);
   assert.equal(p.state,'draft');assert.equal(p.approved_by,null);assert.equal(p.scheduled_at,null);assert.equal(p.job_id,null);
  }
  await schedulePortalPosts(env);for(const t of ['updates','club_jobs','club_memory'])assert.equal(sqlite.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n,0);
  await changePost(env,42,1,1,'approve');await changePost(env,42,1,1,'publish');await schedulePortalPosts(env);
  const body=await portalPostBody(env,sqlite.prepare('SELECT * FROM club_jobs').get());assert.equal(body.method,'sendPoll');assert.equal(body.body.question,entries[0].question);assert.deepEqual(body.body.options,entries[0].options);assert.equal(body.body.import_metadata,undefined);
 }finally{sqlite.close();}
});
test('reruns preserve edited, approved and cancelled drafts and wrong identity inserts nothing',async()=>{
 const {sqlite,env}=portalFixture();try{
  for(const override of [{groupId:'-100999'},{environment:'production'}]){const q=pollImport(entries,{...identity,...override});assert.equal(sqlite.prepare(q.sql).run(...q.params).changes,0);}
  const q=pollImport(entries,identity);sqlite.prepare(q.sql).run(...q.params);
  await changePost(env,42,1,1,'edit',{kind:'poll',text:'Edited by admin',options:['A','B'],thread_id:6});await changePost(env,42,2,1,'approve');await changePost(env,42,3,1,'cancel');
  assert.equal(sqlite.prepare(q.sql).run(...q.params).changes,0);assert.equal(sqlite.prepare('SELECT text FROM admin_posts WHERE id=1').get().text,'Edited by admin');assert.equal(sqlite.prepare('SELECT state FROM admin_posts WHERE id=2').get().state,'approved');assert.equal(sqlite.prepare('SELECT state FROM admin_posts WHERE id=3').get().state,'cancelled');
 }finally{sqlite.close();}
});
test('malformed polls and duplicate input are rejected before database mutation',()=>{
 for(const bad of [{...entries[0],options:['A','A']},{...entries[0],question:''},{...entries[0],topics:[]},{...entries[0],source:{type:''}}])assert.throws(()=>pollRows([bad]));
 assert.throws(()=>pollRows([entries[0],entries[0]]),/Duplicate/);assert.throws(()=>pollImport(entries,{...identity,adminId:0}),/identity/);
});
