import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import worker,{processUpdate} from '../index.mjs';
import {portalFixture} from './portal-fixture.mjs';
import {createPost,changePost,schedulePortalPosts,portalPostBody} from '../portal-content.mjs';
import {scheduleClub} from '../cantina-jobs.mjs';
import {CLUB_OFFSET} from '../cantina-core.mjs';

let env,sqlite,sent,now,realNow,realFetch,nextId,telegram;
beforeEach(()=>{
 ({env,sqlite}=portalFixture());
 realNow=Date.now;now=Date.parse('2026-10-28T06:00:00Z');Date.now=()=>now;
 realFetch=globalThis.fetch;sent=[];nextId=100;
 telegram=async(method,body)=>Response.json({ok:true,result:{message_id:900+sent.length,
  ...method==='sendPoll'?{poll:{id:'poll-'+sent.length,options:body.options.map(text=>({text,voter_count:0}))}}:{}}});
 globalThis.fetch=async(url,options)=>{
  assert.ok(String(url).startsWith('https://api.telegram.org/'),'All network calls must use the Telegram mock');
  const method=String(url).split('/').at(-1),body=JSON.parse(options.body);
  const diagnostics={getMe:{username:env.BOT_USERNAME},getChat:{id:Number(env.GROUP_ID),is_forum:true},
   getChatMember:{status:'administrator',can_delete_messages:true,can_restrict_members:true},
   getWebhookInfo:{url:env.EXPECTED_WEBHOOK_URL,allowed_updates:['message','poll','poll_answer','message_reaction']}};
  if(diagnostics[method])return Response.json({ok:true,result:diagnostics[method]});
  sent.push({method,body});return telegram(method,body);
 };
});
afterEach(()=>{Date.now=realNow;globalThis.fetch=realFetch;sqlite.close();});
async function webhook(text,{privateChat=false,user=42,extra={},secret=env.WEBHOOK_SECRET}={}){
 const id=nextId++,pending=[];
 const payload={update_id:id,...extra,message:{message_id:id,from:{id:user,is_bot:false,first_name:'Member'},
  chat:{id:privateChat?user:Number(env.GROUP_ID),type:privateChat?'private':'supergroup'},
  message_thread_id:privateChat?777:6,text,...extra.message}};
 const response=await worker.fetch(new Request('https://bot.example/telegram',{method:'POST',
  headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify(payload)}),env,{waitUntil(p){pending.push(p);}});
 await Promise.all(pending);return {id,response};
}
function privateReceipt(recipient=42){
 assert.equal(sent.length,1);assert.equal(sent[0].method,'sendMessage');
 const body=sent[0].body;assert.equal(body.chat_id,recipient);
 for(const field of ['message_thread_id','reply_parameters','reply_to_message_id','direct_messages_topic_id'])assert.equal(body[field],undefined);
 assert.doesNotMatch(JSON.stringify(body),/123:fake|test-secret/);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM club_messages WHERE user_id=0').get().n,0);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM context').get().n,0);
}
function seedRecords(){
 sqlite.prepare(`INSERT INTO club_events(id,title,creator,thread_id,starts_at,location,status,created_at)
  VALUES (10,'Watch party',42,6,?,'Community room','draft',?)`).run(now/1000+86400,now/1000);
 sqlite.prepare(`INSERT INTO club_memory(id,title,body,kind,proposed_by,created_at)
  VALUES (20,'Spoilers','Hide spoilers','rule',42,?)`).run(now/1000);
 sqlite.prepare(`INSERT INTO club_reviews(id,message_id,user_id,thread_id,reason,suggestion,created_at)
  VALUES (30,70,77,6,'Repeated promotion','delete',?)`).run(now/1000);
}
const operational=[
 '/admin','/admin login invalid','/admin login 000000000000000000000000',
 '/pause','/resume','/status','/whereami','/readiness','/bindtopic gaming','/topics',
 '/pending','/approve 30 delete','/dismiss 30','/approve memory 20','/dismiss memory 20',
 '/quiet 60','/quiet invalid','/settings','/remember rule|Kindness|Be kind.',
 '/remember invalid','/memory show 20','/memory remove 20',
 '/event create Café meetup|2026-11-07 18:00|Community café|lore|https://example.org/event',
 '/event plan Weekend meetup','/event confirm 10','/event cancel 10',
 '/event create invalid','/event confirm 999',
];
for(const privateChat of [false,true])for(const cmd of operational)test(`${privateChat?'DM':'group'} ${cmd.split('|')[0]} sends only a private admin receipt`,async()=>{
 seedRecords();await webhook(cmd,{privateChat});privateReceipt();
});
test('receipts go to the requesting configured admin, not the first admin or the source chat',async()=>{
 env.ADMIN_USER_IDS='42,43';await webhook('/status@SIU_M8_bot',{user:43});privateReceipt(43);
});
async function begin(){
 const r=await worker.fetch(new Request('https://bot.example/admin/api/login',{method:'POST',
  headers:{Origin:'https://bot.example','Content-Type':'application/json','X-Admin-Request':'1'},body:'{}'}),env,{});
 assert.equal(r.status,200);return {code:(await r.json()).code,cookie:r.headers.get('Set-Cookie').split(';')[0]};
}
async function session(cookie){
 return (await worker.fetch(new Request('https://bot.example/admin/api/session',{headers:{Cookie:cookie}}),env,{})).json();
}
for(const privateChat of [false,true])test(`successful portal login/logout are silent from ${privateChat?'DM':'group'} and the browser observes both`,async()=>{
 const {code,cookie}=await begin();assert.equal((await session(cookie)).state,'pending');
 const rejected=await webhook('/admin login '+code,{privateChat,secret:'wrong'});
 assert.equal(rejected.response.status,401);assert.equal((await session(cookie)).state,'pending');
 const login=await webhook('/admin login '+code,{privateChat});
 assert.equal((await session(cookie)).state,'active');assert.equal(sent.length,0);
 assert.equal(sqlite.prepare('SELECT state FROM updates WHERE id=?').get(login.id).state,'done');
 await webhook('/admin logout',{privateChat});assert.equal((await session(cookie)).state,'signed_out');assert.equal(sent.length,0);
});
for(const cmd of ['Which droid runs the best cantina?','/ask Which droid runs the best cantina?',
 '/discuss','/poll','/trivia','/post question','/help','/privacy','/memory Spoilers','/rules','/event show 10']){
 test(`private content stays public: ${cmd}`,async()=>{
  seedRecords();env.PRIVATE_THREAD_ID='6';await webhook(cmd,{privateChat:true});
  assert.ok(sent.length);for(const {body} of sent){assert.equal(body.chat_id,Number(env.GROUP_ID));assert.equal(body.reply_parameters,undefined);}
 });
}
test('ordinary group answers retain their group topic and reply target',async()=>{
 const {id}=await webhook('/ask Which droid?');assert.equal(sent.length,1);
 assert.equal(sent[0].body.chat_id,Number(env.GROUP_ID));assert.equal(sent[0].body.message_thread_id,6);
 assert.equal(sent[0].body.reply_parameters.message_id,id);
});
test('unknown private users and untrusted routing flags cannot authorize private receipts',async()=>{
 await webhook('/status',{privateChat:true,user:77,extra:{private_admin_receipt:true,recipient:42}});
 assert.equal(sent.length,0);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM updates').get().n,0);
 await webhook('/ask Which droid?',{privateChat:true,extra:{private_admin_receipt:true,recipient:77,
  message:{private_admin_receipt:true,recipient:77}}});
 assert.equal(sent.length,1);assert.equal(sent[0].body.chat_id,Number(env.GROUP_ID));
});
test('a group nonadmin cannot obtain admin operations or receive a private receipt',async()=>{
 await webhook('/pause',{user:77});assert.equal(sent.length,1);assert.equal(sent[0].body.chat_id,Number(env.GROUP_ID));
 assert.match(sent[0].body.text,/configured admins/);assert.equal(sqlite.prepare("SELECT value FROM settings WHERE key='paused'").get(),undefined);
});
for(const cmd of ['/pause','/remember rule|Kindness|Be kind.'])for(const privateChat of [false,true]){
 test(`429 retries preserve private ${cmd.split(' ')[0]} destination from ${privateChat?'DM':'group'}`,async()=>{
  const success=telegram;telegram=async()=>Response.json({ok:false,error_code:429,parameters:{retry_after:2}});
  const {id}=await webhook(cmd,{privateChat});privateReceipt();
  assert.equal(sqlite.prepare('SELECT state FROM updates WHERE id=?').get(id).state,'queued');
  telegram=success;now+=3000;await processUpdate(env,id);await processUpdate(env,id);
  assert.equal(sent.length,2);assert.ok(sent.every(s=>s.body.chat_id===42&&!s.body.reply_parameters&&!s.body.message_thread_id));
  assert.equal(sqlite.prepare('SELECT state FROM updates WHERE id=?').get(id).state,'done');
  if(cmd.startsWith('/remember'))assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM club_memory').get().n,1);
 });
}
for(const cmd of ['/status','/admin'])test(`queued ${cmd} preserves the command's opt-out policy`,async()=>{
 const success=telegram;telegram=async()=>Response.json({ok:false,error_code:429,parameters:{retry_after:2}});
 const {id}=await webhook(cmd);sqlite.prepare('INSERT INTO preferences VALUES (42,1)').run();
 telegram=success;now+=3000;await processUpdate(env,id);
 assert.equal(sent.length,cmd==='/admin'?2:1);assert.ok(sent.every(s=>s.body.chat_id===42));
 assert.equal(sqlite.prepare('SELECT state FROM updates WHERE id=?').get(id).state,'done');
});
for(const privateChat of [false,true])for(const failure of ['removed admin','wrong recipient']){
 test(`queued receipt fails closed after ${failure}, originating in ${privateChat?'DM':'group'}`,async()=>{
  telegram=async()=>Response.json({ok:false,error_code:429,parameters:{retry_after:2}});
  const {id}=await webhook('/status',{privateChat});assert.equal(sent.length,1);
  if(failure==='removed admin')env.ADMIN_USER_IDS='43';else{
   env.ADMIN_USER_IDS='42,43';const body=JSON.parse(sqlite.prepare('SELECT outbound FROM updates WHERE id=?').get(id).outbound);
   body.chat_id=43;sqlite.prepare('UPDATE updates SET outbound=? WHERE id=?').run(JSON.stringify(body),id);
  }
  now+=3000;await processUpdate(env,id);now+=61000;await processUpdate(env,id);
  assert.equal(sent.length,1);assert.equal(sqlite.prepare('SELECT state FROM updates WHERE id=?').get(id).state,'failed');
 });
}
for(const boundary of ['receipt preparation','send write'])test(`admin removal at ${boundary} cannot fall back to a group send`,async()=>{
 const prepare=env.DB.prepare.bind(env.DB);let changed=false;
 env.DB.prepare=sql=>{const stmt=prepare(sql),match=boundary==='receipt preparation'?sql.startsWith('SELECT COUNT(*) AS n FROM updates'):sql.startsWith("UPDATE updates SET state='sending'");
  if(match){const method=boundary==='receipt preparation'?'first':'run',original=stmt[method];stmt[method]=async()=>{const result=await original();if(!changed){changed=true;env.ADMIN_USER_IDS='43';}return result;};}return stmt;};
 await webhook('/status');assert.ok(changed);assert.equal(sent.length,0);
});
for(const failure of ['blocked','uncertain'])test(`a ${failure} private Telegram receipt never falls back to the group`,async()=>{
 telegram=async()=>{if(failure==='uncertain')throw Error('lost response');return Response.json({ok:false,error_code:403});};
 const {id}=await webhook('/status');now+=120000;await processUpdate(env,id);
 assert.equal(sent.length,1);assert.equal(sent[0].body.chat_id,42);
 assert.equal(sqlite.prepare('SELECT state FROM updates WHERE id=?').get(id).state,failure==='uncertain'?'uncertain':'failed');
});
async function drainKind(kind){
 await scheduleClub(env);
 const jobs=sqlite.prepare('SELECT id FROM club_jobs WHERE kind=?').all(kind);
 assert.ok(jobs.length);for(const job of jobs)await processUpdate(env,-CLUB_OFFSET-job.id);
}
for(const [cmd,kind,method] of [['/event confirm 10','event_announcement','sendMessage'],
 ['/event plan Weekend meetup','event_poll','sendPoll'],['/event cancel 10','text','sendMessage']]){
 test(`${cmd} receipt is private but its ${kind} remains public`,async()=>{
  seedRecords();await webhook(cmd,{privateChat:true});privateReceipt();
  await drainKind(kind);assert.equal(sent.length,2);assert.equal(sent[1].method,method);
  assert.equal(sent[1].body.chat_id,Number(env.GROUP_ID));
 });
}
async function queuedPost(){
 const post=await createPost(env,42,{kind:'text',text:'An approved public question?',thread_id:6});
 await changePost(env,42,post.id,1,'approve');await changePost(env,42,post.id,1,'publish');
 await schedulePortalPosts(env);await scheduleClub(env);
 const job=sqlite.prepare("SELECT * FROM club_jobs WHERE kind='portal_post'").get();return {job,id:-CLUB_OFFSET-job.id};
}
test('approved portal posts still publish to the group',async()=>{
 const {id}=await queuedPost();await processUpdate(env,id);assert.equal(sent.length,1);
 assert.equal(sent[0].body.chat_id,Number(env.GROUP_ID));assert.equal(sent[0].body.message_thread_id,6);
 assert.equal(sqlite.prepare('SELECT state FROM admin_posts').get().state,'published');
});
for(const outcome of ['success','uncertain'])test(`429 plus failed claim release plus failed recovery retains safe evidence until the third ${outcome} attempt`,async()=>{
 const {id}=await queuedPost(),prepare=env.DB.prepare.bind(env.DB);let releaseFailure=true,recoveryFailure=false;
 env.DB.prepare=sql=>{const stmt=prepare(sql);
  if(sql.startsWith('UPDATE admin_posts SET state=?,updated_at=?')){const run=stmt.run;stmt.run=async()=>{if(releaseFailure){releaseFailure=false;throw Error('claim release failed');}return run();};}
  if(sql.startsWith("UPDATE admin_posts SET state='scheduled' WHERE")){const run=stmt.run;stmt.run=async()=>{if(recoveryFailure){recoveryFailure=false;throw Error('claim recovery failed');}return run();};}
  return stmt;
 };
 telegram=async()=>Response.json({ok:false,error_code:429,parameters:{retry_after:2}});
 await processUpdate(env,id);
 const update=()=>sqlite.prepare('SELECT state,error,attempts FROM updates WHERE id=?').get(id);
 assert.equal(sqlite.prepare('SELECT state FROM admin_posts').get().state,'sending');
 assert.deepEqual({...update()},{state:'queued',error:'telegram-rate-limit',attempts:1});
 recoveryFailure=true;now+=3000;await processUpdate(env,id);
 assert.equal(sent.length,1);assert.deepEqual({...update()},{state:'queued',error:'telegram-rate-limit',attempts:2});
 assert.equal(sqlite.prepare('SELECT state FROM admin_posts').get().state,'sending');
 telegram=async()=>{
  assert.equal(update().state,'sending');assert.equal(update().error,null,'non-delivery evidence must end before another external send');
  if(outcome==='uncertain')throw Error('response lost after possible delivery');
  return Response.json({ok:true,result:{message_id:950}});
 };
 now+=61000;await processUpdate(env,id);now+=120000;await processUpdate(env,id);
 assert.equal(sent.length,2);assert.ok(sent.every(s=>s.body.chat_id===Number(env.GROUP_ID)));
 assert.equal(update().state,outcome==='success'?'done':'uncertain');
 assert.equal(sqlite.prepare('SELECT state FROM admin_posts').get().state,outcome==='success'?'published':'uncertain');
 assert.equal(sqlite.prepare('SELECT message_id FROM admin_posts').get().message_id,outcome==='success'?950:null);
});
for(const [state,error] of [['sending','telegram-rate-limit'],['uncertain','telegram-rate-limit'],
 ['failed','telegram-rate-limit'],['queued','telegram-rate-limit'],['processing','processing-failed'],['processing',null]]){
 test(`portal sending claim cannot recover from ${state}/${error}`,async()=>{
  const {id,job}=await queuedPost();sqlite.exec("UPDATE admin_posts SET state='sending'");
  sqlite.prepare('UPDATE updates SET state=?,error=? WHERE id=?').run(state,error,id);
  assert.equal(await portalPostBody(env,job),null);assert.equal(sent.length,0);
  assert.equal(sqlite.prepare('SELECT state FROM admin_posts').get().state,'sending');
 });
}
