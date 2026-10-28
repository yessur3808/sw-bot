import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {portalFixture} from './portal-fixture.mjs';
import {referenceImport,referenceRows} from '../scripts/reference-import.mjs';
import {memoryContext} from '../cantina-core.mjs';

const entries=JSON.parse(readFileSync(new URL('../data/star-wars-reference-2026-10-28.json',import.meta.url),'utf8'));
const options={groupId:'-100123',environment:'test',adminId:42,approved:true};
test('all 85 supplied references import without posting and are available to knowledge retrieval',async()=>{
 const {sqlite,env}=portalFixture();try{
  const request=referenceImport(entries,options);sqlite.prepare(request.sql).run(...request.params);
  const rows=sqlite.prepare('SELECT * FROM club_memory ORDER BY id').all();assert.equal(rows.length,85);
  for(const [i,r] of rows.entries()){
   assert.equal(r.kind,entries[i].category);assert.equal(r.status,'approved');assert.equal(r.approved_by,42);
   assert.ok(r.body.startsWith(entries[i].text+'\n'));assert.ok(r.body.includes(`Source: ${entries[i].source.title}\n`));
   assert.ok(r.body.includes(`Source type: ${entries[i].source.type}\n`));assert.ok(r.body.includes(`Topics: ${entries[i].topics.join(', ')}`));
   assert.match(r.body,/not independently fact-checked/);assert.equal(r.source_message,null);
  }
  for(const query of ['Death Star','Mara Jade','Kreia','Ben Burtt','Geonosis'])assert.ok((await memoryContext(env,query)).some(r=>r.text.toLowerCase().includes(query.toLowerCase())));
  for(const table of ['updates','club_jobs','admin_posts'])assert.equal(sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
 }finally{sqlite.close();}
});
test('reimport is idempotent and cannot reapprove a removed entry',()=>{
 const {sqlite}=portalFixture();try{
  const request=referenceImport(entries,options);sqlite.prepare(request.sql).run(...request.params);
  sqlite.exec("UPDATE club_memory SET status='removed' WHERE id=1");
  assert.equal(sqlite.prepare(request.sql).run(...request.params).changes,0);
  assert.equal(sqlite.prepare('SELECT status FROM club_memory WHERE id=1').get().status,'removed');
 }finally{sqlite.close();}
});
test('identity mismatch imports nothing; approval is explicit; malformed or duplicate input fails',()=>{
 const {sqlite}=portalFixture();try{
  for(const override of [{groupId:'-100999'},{environment:'production'}]){
   const r=referenceImport(entries,{...options,...override});assert.equal(sqlite.prepare(r.sql).run(...r.params).changes,0);
  }
  const r=referenceImport(entries,{...options,approved:false});sqlite.prepare(r.sql).run(...r.params);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM club_memory WHERE status='pending' AND approved_by IS NULL").get().n,85);
  assert.throws(()=>referenceRows([entries[0],entries[0]]),/Duplicate/);
  assert.throws(()=>referenceRows([{...entries[0],category:'rule'}]),/Invalid/);
  assert.throws(()=>referenceImport(entries,{...options,adminId:0}),/admin/);
 }finally{sqlite.close();}
});
