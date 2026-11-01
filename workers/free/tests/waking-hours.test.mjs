import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import worker,{processUpdate} from '../index.mjs';
import {activeHours,makePlan,ambientCandidate} from '../engagement.mjs';
import {clubAllowed} from '../cantina-jobs.mjs';
import {CLUB_OFFSET} from '../cantina-core.mjs';
import {createPost,changePost,schedulePortalPosts} from '../portal-content.mjs';
import {portalFixture} from './portal-fixture.mjs';

let env,sqlite,now,realNow,realFetch,sent;
beforeEach(()=>{
 ({env,sqlite}=portalFixture());realNow=Date.now;realFetch=globalThis.fetch;
 now=Date.parse('2026-10-28T23:59:59+08:00');Date.now=()=>now;sent=[];
 globalThis.fetch=async(url,options)=>{sent.push({method:String(url).split('/').at(-1),body:JSON.parse(options.body)});return Response.json({ok:true,result:{message_id:900+sent.length}});};
});
afterEach(()=>{Date.now=realNow;globalThis.fetch=realFetch;sqlite.close();});

test('Hong Kong posting window includes 08:00 and excludes midnight',()=>{
 for(const [time,expected] of [['00:00:00',false],['07:59:59',false],['08:00:00',true],['23:59:59',true]]){
  assert.equal(activeHours(Date.parse('2026-10-28T'+time+'+08:00')/1000),expected,time);
 }
 assert.equal(makePlan('2026-10-28',()=>0)[0].at,Date.parse('2026-10-28T08:00:00+08:00')/1000);
});

test('overnight background jobs wait, including requested portal schedules; direct briefings remain available',async()=>{
 now=Date.parse('2026-10-29T02:00:00+08:00');
 for(const kind of ['text','game_start','game_step','game_close','event_reminder','portal_post']){
  const job={state:'pending',kind,expires_at:now/1000+3600,data:JSON.stringify(kind==='portal_post'?{requested:true}:{})};
  assert.equal(await clubAllowed(env,job),'wait',kind);
 }
 assert.equal(await clubAllowed(env,{state:'pending',kind:'briefing',expires_at:now/1000+60,data:'{"requested":true}'}),'send');
});

test('portal rejects an overnight publication time without consuming approval',async()=>{
 const p=await createPost(env,42,{kind:'text',text:'A morning discussion',thread_id:6});
 await changePost(env,42,p.id,p.revision,'approve');
 await assert.rejects(changePost(env,42,p.id,p.revision,'publish',{scheduled_at:Date.parse('2026-10-29T02:00:00+08:00')/1000}),/08:00 and midnight/);
 assert.equal(sqlite.prepare('SELECT state FROM admin_posts WHERE id=?').get(p.id).state,'approved');
});

test('portal claim crossing midnight defers safely and publishes once after 08:00',async()=>{
 const p=await createPost(env,42,{kind:'text',text:'A queued discussion',thread_id:6});
 await changePost(env,42,p.id,p.revision,'approve');await changePost(env,42,p.id,p.revision,'publish');
 await schedulePortalPosts(env);
 const post=sqlite.prepare('SELECT * FROM admin_posts WHERE id=?').get(p.id),id=-CLUB_OFFSET-post.job_id;
 sqlite.prepare('INSERT INTO updates(id,payload,created_at) VALUES (?,?,?)').run(id,JSON.stringify({internal_club:post.job_id}),now/1000);
 const base=env.DB.prepare.bind(env.DB);let crossed=false;
 env.DB.prepare=sql=>{const s=base(sql);if(sql.startsWith("UPDATE admin_posts SET state='sending'")){const run=s.run.bind(s);s.run=async()=>{const result=await run();if(!crossed){crossed=true;now=Date.parse('2026-10-29T00:00:00+08:00');}return result;};}return s;};
 await processUpdate(env,id);
 assert.equal(crossed,true);assert.equal(sent.length,0);
 assert.equal(sqlite.prepare('SELECT state FROM updates WHERE id=?').get(id).state,'queued');
 assert.equal(sqlite.prepare('SELECT state FROM admin_posts WHERE id=?').get(p.id).state,'scheduled');
 now=Date.parse('2026-10-29T08:00:00+08:00');
 await processUpdate(env,id);await processUpdate(env,id);
 assert.equal(sent.length,1);assert.equal(sent[0].body.chat_id,-100123);
 assert.equal(sqlite.prepare('SELECT state FROM admin_posts WHERE id=?').get(p.id).state,'published');
});

test('overnight mentions receive direct replies while ambient replies are suppressed',async()=>{
 now=Date.parse('2026-10-29T02:00:00+08:00');
 const message={message_id:1,date:now/1000,from:{id:42,is_bot:false,first_name:'Admin'},chat:{id:-100123,type:'supergroup'},text:'@SIU_M8_bot Which droid would you choose?',message_thread_id:6};
 const pending=[];
 const r=await worker.fetch(new Request('https://bot.example/telegram',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':env.WEBHOOK_SECRET},body:JSON.stringify({update_id:1,message})}),env,{waitUntil(p){pending.push(p);}});
 await Promise.all(pending);assert.equal(r.status,200);assert.equal(sent.length,1);assert.equal(sent[0].body.chat_id,-100123);
 for(let id=1;id<100;id++)assert.equal(ambientCandidate({...message,text:'Which Star Wars droid would you choose?'},{...env,AMBIENT_REPLY_CHANCE:'0.4'},id),false);
});
