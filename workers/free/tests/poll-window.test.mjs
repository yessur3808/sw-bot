import test from 'node:test';
import assert from 'node:assert/strict';
import {portalFixture} from './portal-fixture.mjs';
import {recordPoll,scheduleFollowups} from '../community.mjs';

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
