import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {portalFixture} from './portal-fixture.mjs';
import {trackPollCleanup,observeCleanupPoll,observeCleanupAnswer,cleanupEmptyPolls} from '../poll-cleanup.mjs';
import {receivePoll,recordPoll,scheduleFollowups} from '../community.mjs';
let sqlite,env,now,realNow,realFetch,calls,respond;
const snapshot=(votes=0,closed=true)=>({id:'p1',is_closed:closed,total_voter_count:votes,options:[{text:'R2',voter_count:votes},{text:'Chopper',voter_count:0}]});
async function track(type='quiz'){
 const body={chat_id:-100123,message_thread_id:6,question:'Choose',options:['R2','Chopper'],type,close_date:now/1000+7200};
 const result={message_id:42,poll:snapshot(0,false)};
 await trackPollCleanup(env,body,result);return {body,result};
}
const row=()=>sqlite.prepare('SELECT * FROM poll_cleanup').get();
beforeEach(()=>{
 ({sqlite,env}=portalFixture());now=Date.parse('2026-10-30T14:00:00Z');realNow=Date.now;realFetch=globalThis.fetch;Date.now=()=>now;
 calls=[];respond=(method)=>method==='stopPoll'?{ok:true,result:snapshot()}:{ok:true,result:true};
 globalThis.fetch=async(url,request)=>{const method=String(url).split('/').at(-1),body=JSON.parse(request.body);calls.push({method,body});return Response.json(await respond(method,body));};
});
afterEach(()=>{Date.now=realNow;globalThis.fetch=realFetch;sqlite.close();});
test('empty quiz gets its full window, then its complete message is deleted once even at midnight',async()=>{
 await track();now+=7199000;await cleanupEmptyPolls(env);assert.equal(calls.length,0);
 now+=1000;await cleanupEmptyPolls(env);await cleanupEmptyPolls(env);
 assert.deepEqual(calls,[{method:'stopPoll',body:{chat_id:-100123,message_id:42}},{method:'deleteMessage',body:{chat_id:-100123,message_id:42}}]);
 assert.equal(row().state,'deleted');
});
test('a closed empty poll webhook avoids another stop call and zero-vote follow-ups stay silent',async()=>{
 const {body,result}=await track('regular');await recordPoll(env,1,body,result);
 now+=7200000;await receivePoll(env,snapshot());await scheduleFollowups(env);await cleanupEmptyPolls(env);
 assert.deepEqual(calls.map(x=>x.method),['deleteMessage']);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM updates').get().n,0);
});
test('final votes preserve the poll, even if no individual answer was recorded',async()=>{
 await track();now+=7200000;respond=()=>({ok:true,result:snapshot(1)});await cleanupEmptyPolls(env);
 assert.equal(row().state,'kept');assert.deepEqual(calls.map(x=>x.method),['stopPoll']);
});
test('an observed answer or withdrawn vote preserves the message without storing voter identities',async()=>{
 await track();await observeCleanupAnswer(env,{poll_id:'p1',option_ids:[1],user:{id:99}});await observeCleanupPoll(env,snapshot());now+=7200000;await cleanupEmptyPolls(env);
 assert.equal(row().state,'kept');assert.equal(calls.length,0);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM answers').get().n,0);
});
test('open zero totals, mismatched options and unknown polls cannot authorize deletion',async()=>{
 await track();now+=7200000;
 await observeCleanupPoll(env,{...snapshot(),id:'unknown'});
 await observeCleanupPoll(env,{...snapshot(),options:[{text:'Different',voter_count:0}]});
 await observeCleanupPoll(env,{...snapshot(),total_voter_count:1});
 respond=()=>({ok:true,result:snapshot(0,false)});await cleanupEmptyPolls(env);
 assert.equal(row().final_votes,null);assert.equal(row().state,'pending');assert.ok(calls.every(c=>c.method==='stopPoll'));
});
test('missing final totals remain pending and an eventual final webhook safely enables cleanup',async()=>{
 await track();now+=7200000;respond=()=>({ok:false,error_code:400,description:'poll has already been closed'});
 await cleanupEmptyPolls(env);assert.equal(row().state,'pending');assert.equal(row().final_votes,null);
 await cleanupEmptyPolls(env);assert.equal(calls.length,1);
 await observeCleanupPoll(env,snapshot());now+=300000;respond=()=>({ok:true,result:true});await cleanupEmptyPolls(env);
 assert.equal(row().state,'deleted');assert.deepEqual(calls.map(c=>c.method),['stopPoll','deleteMessage']);
});
test('delete rate limits retry at retry_after, and an already removed message completes cleanup',async()=>{
 await track();await observeCleanupPoll(env,snapshot());now+=7200000;
 respond=()=>({ok:false,error_code:429,parameters:{retry_after:120}});await cleanupEmptyPolls(env);
 now+=119000;await cleanupEmptyPolls(env);assert.equal(calls.length,1);
 now+=1000;respond=()=>({ok:false,error_code:400,description:'Bad Request: message to delete not found'});await cleanupEmptyPolls(env);
 assert.equal(row().state,'deleted');
});
test('concurrent maintenance claims only one deletion and rechecks votes arriving during stopPoll',async()=>{
 await track();now+=7200000;
 respond=async(method)=>{if(method==='stopPoll'){await observeCleanupAnswer(env,{poll_id:'p1',option_ids:[0]});return {ok:true,result:snapshot()};}throw Error('must not delete');};
 await Promise.all([cleanupEmptyPolls(env),cleanupEmptyPolls(env)]);
 assert.equal(calls.length,1);assert.equal(row().state,'kept');
});
test('foreign group, disabled deployment, old messages and non-bot input are excluded',async()=>{
 await trackPollCleanup(env,{chat_id:-100999,options:['A','B'],close_date:now/1000+7200},{message_id:1,poll:{id:'foreign'}});
 assert.equal(row(),undefined);await track();env.DEPLOYMENT_ENABLED='false';await assert.rejects(cleanupEmptyPolls(env),/deployment-disabled/);
 env.DEPLOYMENT_ENABLED='true';now+=86401000;await cleanupEmptyPolls(env);
 assert.equal(row().state,'expired');assert.equal(calls.length,0);
});
