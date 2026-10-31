import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {handleCoreCommand} from '../cantina-core.mjs';
import {portalFixture} from './portal-fixture.mjs';

let env,sqlite,receipts,updateId,now,realNow,realFetch;
beforeEach(()=>{
 ({env,sqlite}=portalFixture());receipts=[];updateId=1000;
 realNow=Date.now;now=Date.parse('2026-10-27T06:00:00Z');Date.now=()=>now;
 realFetch=globalThis.fetch;globalThis.fetch=async()=>assert.fail('Approval tests must not access the network');
});
afterEach(()=>{Date.now=realNow;globalThis.fetch=realFetch;sqlite.close();});
const seconds=()=>now/1000;
async function command(name,arg,user=42,say=async(_env,_id,_message,text)=>receipts.push(text)){
 return handleCoreCommand(env,{update_id:++updateId,message:{from:{id:user},chat:{id:user,type:'private'}}},{name,arg},say);
}
function seedEvent(status='draft'){
 sqlite.prepare(`INSERT INTO club_events(id,title,creator,thread_id,starts_at,location,source_url,status,created_at)
  VALUES (1,'Meetup',77,6,?,'Original room','https://example.org/original',?,?)`).run(seconds()+86400,status,seconds());
}
function seedReview(state='pending',user=77,age=0){
 sqlite.prepare(`INSERT INTO club_reviews(id,message_id,user_id,thread_id,reason,suggestion,state,created_at)
  VALUES (1,100,?,6,'Inspect the context','delete',?,?)`).run(user,state,seconds()-age);
}
const eventRow=()=>sqlite.prepare('SELECT * FROM club_events WHERE id=1').get();
const reviewRow=()=>sqlite.prepare('SELECT * FROM club_reviews WHERE id=1').get();
const jobs=()=>sqlite.prepare('SELECT * FROM club_jobs ORDER BY id').all();
const confirm=(user=42)=>command('event','confirm 1 | 2026-10-29 18:00 | New room | https://example.org/verified',user);
const approve=(action='delete',user=42)=>command('approve',`1 ${action}`,user);
// Commit a competing command after the original read, before its transaction.
// This models stale snapshots without overlapping transactions on the fixture connection.
function beforeBatchOnce(action){
 const batch=env.DB.batch.bind(env.DB);
 env.DB.batch=async statements=>{env.DB.batch=batch;await action();return batch(statements);};
}
const cases=[
 ...['draft','planning'].map(status=>({name:`${status} event`,seed:()=>seedEvent(status),run:()=>confirm(),row:eventRow,
  table:'club_events',approved:"status='confirmed'",key:'event-confirm:1',kind:'event_announcement',data:{event_id:1,requested:true},ttl:86400})),
 ...['delete','mute','ban'].map(action=>({name:`${action} review`,seed:()=>seedReview(),run:()=>approve(action),row:reviewRow,
  table:'club_reviews',approved:"state='approved'",key:'moderation:1',kind:'moderation',data:{review_id:1},ttl:3600}))
];

for(const scenario of cases)for(const timing of ['BEFORE','AFTER'])test(`${scenario.name}: ${timing.toLowerCase()} job insert failure rolls back approval and retry queues once`,async()=>{
 scenario.seed();const original=scenario.row();
 // The SQL trigger also proves approval was staged before the injected failure.
 sqlite.exec(`CREATE TEMP TRIGGER fail_enqueue ${timing} INSERT ON club_jobs BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM ${scenario.table} WHERE id=1 AND ${scenario.approved})
   THEN RAISE(ABORT,'injected enqueue failure') ELSE RAISE(ABORT,'approval was not staged') END;
 END;`);
 await assert.rejects(scenario.run(),/injected enqueue failure/);
 assert.deepEqual(scenario.row(),original);assert.deepEqual(jobs(),[]);assert.deepEqual(receipts,[]);
 sqlite.exec('DROP TRIGGER fail_enqueue');
 await scenario.run();const approved=scenario.row(),queued=jobs();
 assert.equal(queued.length,1);assert.equal(queued[0].job_key,scenario.key);assert.equal(queued[0].kind,scenario.kind);
 assert.deepEqual(JSON.parse(queued[0].data),scenario.data);assert.equal(queued[0].thread_id,6);
 assert.equal(queued[0].user_id,null);assert.equal(queued[0].state,'pending');
 assert.equal(queued[0].run_at,seconds());assert.equal(queued[0].expires_at,seconds()+scenario.ttl);
 if(scenario.table==='club_events'){
  assert.equal(approved.status,'confirmed');assert.equal(approved.confirmed_by,42);
  assert.equal(approved.location,'New room');assert.equal(approved.starts_at,Date.parse('2026-10-29T18:00:00+08:00')/1000);
  assert.equal(approved.source_url,'https://example.org/verified');
 }else{assert.equal(approved.state,'approved');assert.equal(approved.approved_by,42);assert.equal(approved.action,scenario.name.split(' ')[0]);}
 await scenario.run();assert.deepEqual(scenario.row(),approved);assert.deepEqual(jobs(),queued);
 // A repeated command must not recreate work after its job has been retired.
 sqlite.exec('DELETE FROM club_jobs');await scenario.run();assert.deepEqual(jobs(),[]);assert.deepEqual(scenario.row(),approved);
});

test('stale event confirmation cannot undo cancellation or enqueue an announcement',async()=>{
 seedEvent();beforeBatchOnce(()=>command('event','cancel 1'));
 await confirm();assert.equal(eventRow().status,'cancelled');assert.equal(eventRow().confirmed_by,null);
 assert.deepEqual(jobs().map(j=>j.job_key),['event-cancel:1']);assert.match(receipts.at(-1),/changed or was already handled/);
});
test('competing event confirmations retain the first details and one job',async()=>{
 seedEvent();env.ADMIN_USER_IDS='42,43';
 beforeBatchOnce(()=>command('event','confirm 1 | 2026-10-30 18:00 | Winning room | https://example.org/winner',43));
 await confirm();const row=eventRow();assert.equal(row.confirmed_by,43);assert.equal(row.location,'Winning room');
 assert.equal(row.source_url,'https://example.org/winner');assert.equal(row.starts_at,Date.parse('2026-10-30T18:00:00+08:00')/1000);
 assert.equal(jobs().length,1);assert.match(receipts.at(-1),/changed or was already handled/);
});
test('stale moderation approval cannot undo dismissal',async()=>{
 seedReview();beforeBatchOnce(()=>command('dismiss','1'));
 await approve();assert.equal(reviewRow().state,'dismissed');assert.equal(reviewRow().action,null);
 assert.deepEqual(jobs(),[]);assert.equal(receipts.at(-1),'Already handled.');
});
test('competing moderation approvals retain the first action and approver with one job',async()=>{
 seedReview();env.ADMIN_USER_IDS='42,43';beforeBatchOnce(()=>approve('mute',43));
 await approve('ban');assert.equal(reviewRow().action,'mute');assert.equal(reviewRow().approved_by,43);
 assert.equal(jobs().length,1);assert.equal(receipts.at(-1),'Already handled.');
});
test('moderation CAS rejects a newly expired review or a changed target',async()=>{
 for(const mutation of [()=>sqlite.prepare('UPDATE club_reviews SET created_at=?').run(seconds()-86401),
  ()=>sqlite.exec('UPDATE club_reviews SET user_id=42')]){
  sqlite.exec('DELETE FROM club_reviews');seedReview();beforeBatchOnce(mutation);
  await approve();assert.equal(reviewRow().state,'pending');assert.equal(reviewRow().approved_by,null);assert.deepEqual(jobs(),[]);
 }
});
test('nonadmins, invalid actions, protected admins and expired or handled reviews never queue',async()=>{
 for(const options of [
  {actor:77},{action:'kick'},{target:42},{age:86401},
  ...['approved','dismissed','executed','protected','expired','cancelled'].map(state=>({state}))
 ]){
  sqlite.exec('DELETE FROM club_reviews');seedReview(options.state,options.target,options.age);const original=reviewRow();
  await approve(options.action,options.actor);assert.deepEqual(reviewRow(),original);assert.deepEqual(jobs(),[]);
 }
});
test('nonadmins and cancelled, confirmed or unexpected event states cannot be confirmed',async()=>{
 for(const options of [{actor:77},...['cancelled','confirmed','expired'].map(status=>({status}))]){
  sqlite.exec('DELETE FROM club_events');seedEvent(options.status);const original=eventRow();
  await confirm(options.actor);assert.deepEqual(eventRow(),original);assert.deepEqual(jobs(),[]);
 }
});
test('invalid event details leave the draft and queue unchanged',async()=>{
 seedEvent();const original=eventRow();
 for(const fields of ['2026-10-26 18:00 | Room','2028-10-29 18:00 | Room','2026-10-29 18:00 | To be decided',
  '2026-10-29 18:00 | Room | http://example.org']){
  await command('event',`confirm 1 | ${fields}`);assert.deepEqual(eventRow(),original);assert.deepEqual(jobs(),[]);
 }
});
for(const scenario of [cases[0],cases[2]]){
 test(`${scenario.name}: a conflicting retired job cannot silently approve new work`,async()=>{
  scenario.seed();const original=scenario.row();
  sqlite.prepare(`INSERT INTO club_jobs(job_key,kind,data,state,run_at,expires_at) VALUES (?,?,'{}','cancelled',?,?)`)
   .run(scenario.key,scenario.kind,seconds(),seconds()+3600);const existing=jobs();
  await assert.rejects(scenario.run(),/UNIQUE constraint failed/);
  assert.deepEqual(scenario.row(),original);assert.deepEqual(jobs(),existing);assert.deepEqual(receipts,[]);
 });
 test(`${scenario.name}: a lost batch response does not duplicate the committed job on retry`,async()=>{
  scenario.seed();const batch=env.DB.batch.bind(env.DB);
  env.DB.batch=async statements=>{await batch(statements);throw Error('lost batch response');};
  await assert.rejects(scenario.run(),/lost batch response/);const approved=scenario.row(),queued=jobs();
  assert.equal(queued.length,1);env.DB.batch=batch;await scenario.run();
  assert.deepEqual(scenario.row(),approved);assert.deepEqual(jobs(),queued);
 });
}
