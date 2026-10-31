import test from 'node:test';
import assert from 'node:assert/strict';
import {portalFixture} from './portal-fixture.mjs';
import {recordPoll,scheduleFollowups,pollWithDeadline} from '../community.mjs';

test('poll deadline labels use Hong Kong date rollover and preserve complete long questions',()=>{
 const now=Date.parse('2026-12-31T23:30:00+08:00')/1000;
 const body={question:'Choose a droid',options:['R2','Chopper']};
 const poll=pollWithDeadline(body,true,now);
 assert.equal(poll.question,'Choose a droid\n\nEnds at 01:30:00 HKT · 1 Jan');
 assert.equal(poll.close_date,now+7200);assert.equal(body.close_date,undefined);
 const long=pollWithDeadline({...body,question:'x'.repeat(300)},true,now);
 assert.equal(long.question.length,300);assert.equal(long.description,'Ends at 01:30:00 HKT · 1 Jan');
 const quiz=pollWithDeadline({...body,type:'quiz',open_period:120},false,now);
 assert.equal(quiz.close_date,now+7200);assert.equal(quiz.open_period,undefined);
 assert.match(quiz.question,/Ends at 01:30:00 HKT · 1 Jan$/);
 assert.equal(pollWithDeadline(body,false,now).close_date,now+7200);
 assert.equal(pollWithDeadline({...body,close_date:now+60},false,now).close_date,now+7200);
});

test('discussion polls allow two hours before closing and queue one verified follow-up',async()=>{
 const {sqlite,env}=portalFixture(),realNow=Date.now,realFetch=globalThis.fetch;
 const start=Date.parse('2026-10-29T09:00:00+08:00');let now=start,closes=0;
 Date.now=()=>now;
 const body={question:'Pick a droid',options:['R2-D2','Chopper'],message_thread_id:6};
 globalThis.fetch=async(url,request)=>{
  assert.ok(url.endsWith('/stopPoll'));
  assert.deepEqual(JSON.parse(request.body),{chat_id:-100123,message_id:100});closes++;
  return Response.json({ok:true,result:{id:'discussion',is_closed:true,options:[{text:'R2-D2',voter_count:3},{text:'Chopper',voter_count:2}]}});
 };
 try{
  await recordPoll(env,1,body,{message_id:100,poll:{id:'discussion'}});
  await recordPoll(env,2,{...body,type:'quiz'},{message_id:101,poll:{id:'quiz'}});
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM community_polls').get().n,1);
  now=start+7199*1000;await scheduleFollowups(env);
  assert.equal(closes,0);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM updates').get().n,0);
  now=start+7200*1000;await scheduleFollowups(env);await scheduleFollowups(env);
  assert.equal(closes,1);
  const poll=sqlite.prepare('SELECT * FROM community_polls').get();
  assert.equal(poll.closed,1);assert.equal(JSON.parse(poll.options)[0].voter_count,3);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM updates').get().n,1);
 }finally{Date.now=realNow;globalThis.fetch=realFetch;sqlite.close();}
});
