import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {portalFixture} from './portal-fixture.mjs';
import {pollImport,pollRows} from '../scripts/poll-import.mjs';
import {changePost,schedulePortalPosts,portalPostBody} from '../portal-content.mjs';

let realNow;
beforeEach(()=>{
 realNow=Date.now;
 // Keep publish tests in waking hours, after SQLite's real wall clock.
 const at=Math.floor((realNow()+28800000)/86400000)*86400000+86400000+14400000;
 Date.now=()=>at;
});
afterEach(()=>{Date.now=realNow;});

const entries=JSON.parse(readFileSync(new URL('../data/star-wars-polls-2026-10-28.json',import.meta.url),'utf8'));
const identity={groupId:'-100123',environment:'test',adminId:42};
test('adding quiz support keeps existing opinion-poll import fingerprints stable',()=>{
 for(const [i,row] of pollRows(entries).entries()){
  const e=entries[i],original={category:e.category,question:e.question,options:e.options,source:e.source,topics:e.topics};
  assert.equal(row.key,createHash('sha256').update(JSON.stringify(original)).digest('hex'));
  assert.equal(row.kind,'poll');assert.equal(row.correct,null);
 }
});
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


test('trivia preserves zero-based answers and becomes a native Telegram quiz only after approval',async()=>{
 const {sqlite,env}=portalFixture();try{
  const entry={category:'movie_trivia',question:'Which planet is the ice world?',options:['Hoth','Naboo','Mustafar','Tatooine'],correct:0,source:{title:'The Empire Strikes Back',type:'movie'},topics:['planets']};
  const q=pollImport([entry],identity);sqlite.prepare(q.sql).run(...q.params);let p=sqlite.prepare('SELECT * FROM admin_posts').get();assert.equal(p.kind,'quiz');assert.equal(p.correct,0);assert.equal(p.state,'draft');assert.deepEqual(JSON.parse(p.import_metadata),entry);
  await schedulePortalPosts(env);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM club_jobs').get().n,0);
  await changePost(env,42,p.id,1,'approve');await changePost(env,42,p.id,1,'publish');await schedulePortalPosts(env);
  const rendered=await portalPostBody(env,sqlite.prepare('SELECT * FROM club_jobs').get());assert.equal(rendered.method,'sendPoll');assert.equal(rendered.body.type,'quiz');assert.equal(rendered.body.correct_option_id,0);assert.equal(rendered.body.is_anonymous,false);assert.equal(rendered.body.open_period,120);
  assert.equal(sqlite.prepare(q.sql).run(...q.params).changes,0);
  for(const correct of [-1,4,1.5,'0',true,undefined])assert.throws(()=>pollRows([{...entry,correct}]));
  assert.throws(()=>pollRows([{...entry,category:'movie_poll'}]),/correct answer/);
 }finally{sqlite.close();}
});

test('110-question library imports every answer and source without scheduling or duplicating quizzes',async()=>{
 const trivia=JSON.parse(readFileSync(new URL('../data/star-wars-trivia-2026-10-28.json',import.meta.url),'utf8'));
 const evidence=JSON.parse(readFileSync(new URL('../data/star-wars-trivia-2026-10-28.sources.json',import.meta.url),'utf8'));
 assert.equal(trivia.length,110);assert.equal(evidence.length,110);
 assert.equal(new Set(trivia.map(e=>e.question.trim().toLowerCase())).size,110);
 assert.deepEqual(trivia.slice(0,10).map(e=>e.correct),[2,1,1,2,0,1,1,1,2,2]);
 const {sqlite,env}=portalFixture();try{
  sqlite.exec("INSERT INTO topic_map VALUES ('gaming',128)");
  const q=pollImport(trivia,identity);assert.equal(sqlite.prepare(q.sql).run(...q.params).changes,110);
  const posts=sqlite.prepare('SELECT * FROM admin_posts ORDER BY id').all(),mapped=pollRows(trivia);
  for(const [i,p] of posts.entries()){
   const e=trivia[i];assert.equal(e.options.length,4);assert.equal(new Set(e.options).size,4);
   assert.equal(p.kind,'quiz');assert.equal(p.correct,e.correct);assert.equal(p.text,e.question);assert.deepEqual(JSON.parse(p.options),e.options);assert.deepEqual(JSON.parse(p.import_metadata),e);
   assert.equal(evidence[i].question,e.question);assert.equal(evidence[i].answer,e.options[e.correct]);assert.ok(evidence[i].url.startsWith('https://'));
   if(i>=10)assert.equal(e.source.url,evidence[i].url);
   assert.equal(p.thread_id,mapped[i].topic==='gaming'?128:mapped[i].topic==='movies'?4:6);
   assert.equal(p.state,'draft');assert.equal(p.approved_by,null);assert.equal(p.scheduled_at,null);assert.equal(p.job_id,null);
  }
  await schedulePortalPosts(env);for(const t of ['updates','club_jobs','club_memory'])assert.equal(sqlite.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n,0);
  assert.equal(sqlite.prepare(q.sql).run(...q.params).changes,0);
 }finally{sqlite.close();}
});
