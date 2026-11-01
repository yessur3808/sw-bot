import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import worker,{maintenance,processUpdate} from '../index.mjs';
import {portalFixture} from './portal-fixture.mjs';
import {portalLoginCommand} from '../admin-portal.mjs';
import {schedulePortalPosts,changePost,claimPortalPost} from '../portal-content.mjs';
import {scheduleClub} from '../cantina-jobs.mjs';
import {CLUB_OFFSET} from '../cantina-core.mjs';
let env,sqlite,sent,now,realNow,realFetch,cookie,csrf;
beforeEach(()=>{({env,sqlite}=portalFixture());realNow=Date.now;now=Date.parse('2026-10-27T06:00:00Z');Date.now=()=>now;realFetch=globalThis.fetch;sent=[];cookie='';csrf='';
 globalThis.fetch=async(url,options)=>{const method=String(url).split('/').at(-1),body=JSON.parse(options.body);sent.push({method,body});return Response.json({ok:true,result:{message_id:900+sent.length,...method==='sendPoll'?{poll:{id:'poll-'+sent.length,options:body.options.map(text=>({text,voter_count:0}))}}:{}}});};
});
afterEach(()=>{Date.now=realNow;globalThis.fetch=realFetch;sqlite.close();});
async function request(path,body,extra={}){
 return worker.fetch(new Request('https://bot.example/admin'+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...body===undefined?{}:{Origin:'https://bot.example','Content-Type':'application/json','X-Admin-Request':'1','X-Admin-CSRF':csrf},...extra},body:body===undefined?undefined:JSON.stringify(body)}),env,{waitUntil(){}});
}
async function api(path,body){const r=await request('/api'+path,body),data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data;}
async function begin(){const r=await request('/api/login',{});assert.equal(r.status,200);cookie=r.headers.get('Set-Cookie').split(';')[0];return (await r.json()).code;}
async function login(){const code=await begin();await portalLoginCommand(env,42,'login '+code);csrf=(await api('/session')).csrf;}
const draft=(overrides={})=>({kind:'text',text:'Would R2 make a good café manager?',thread_id:6,...overrides});
async function post(){return (await api('/posts',draft())).post;}
async function approved(){const p=await post();await api(`/posts/${p.id}/approve`,{revision:p.revision});return p;}
async function queued(){const p=await approved();await api(`/posts/${p.id}/publish`,{revision:p.revision});await schedulePortalPosts(env);return {...p,job:sqlite.prepare('SELECT * FROM club_jobs WHERE kind=\'portal_post\'').get()};}
async function drain(){await schedulePortalPosts(env);await scheduleClub(env);for(const u of sqlite.prepare("SELECT id FROM updates WHERE state='queued' AND ready_at<=?").all(now/1000))await processUpdate(env,u.id);}

test('portal shell is public but data requires authentication and responses prohibit caching/framing',async()=>{
 const page=await request('');assert.equal(page.status,200);assert.match(await page.text(),/Cantina control/);assert.equal(page.headers.get('Cache-Control'),'no-store');assert.match(page.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);
 assert.equal((await request('/api/state')).status,401);assert.equal((await request('/api/posts',draft())).status,401);
});
test('Telegram approves only its bound browser, code is not a bearer token, and approval is one-time',async()=>{
 const code=await begin(),first=cookie;assert.match(first,/__Host-sw_admin=/);
 assert.match(await portalLoginCommand(env,77,'login '+code),/configured admins/);
 cookie='';const secondCode=await begin(),second=cookie;await portalLoginCommand(env,42,'login '+code);
 assert.equal((await api('/session')).state,'pending');cookie='__Host-sw_admin='+code;assert.equal((await api('/session')).state,'signed_out');
 cookie=first;const s=await api('/session');assert.equal(s.state,'active');assert.equal(s.user_id,42);assert.ok(s.csrf);assert.notEqual(s.csrf,first.split('=')[1]);
 assert.match(await portalLoginCommand(env,42,'login '+code),/expired or already used/);cookie=second;assert.equal((await api('/session')).state,'pending');assert.ok(secondCode);
 const rows=sqlite.prepare('SELECT * FROM admin_sessions').all();assert.ok(rows.every(r=>r.token_hash!==first.split('=')[1]&&r.code_hash!==code));
});
test('sign-in cookies have host-only Secure HttpOnly SameSite protection',async()=>{
 const r=await request('/api/login',{}),c=r.headers.get('Set-Cookie');assert.match(c,/Secure/);assert.match(c,/HttpOnly/);assert.match(c,/SameSite=Strict/);assert.match(c,/Path=\//);assert.doesNotMatch(c,/Domain=/);
});
test('Telegram webhook authentication protects portal login without a group receipt',async()=>{
 const code=await begin(),pending=[];
 const payload={update_id:99,message:{message_id:99,from:{id:42,is_bot:false,first_name:'Admin'},chat:{id:42,type:'private'},text:'/admin login '+code}};
 const webhook=secret=>worker.fetch(new Request('https://bot.example/telegram',{method:'POST',headers:{'Content-Type':'application/json','X-Telegram-Bot-Api-Secret-Token':secret},body:JSON.stringify(payload)}),env,{waitUntil(p){pending.push(p);}});
 assert.equal((await webhook('wrong')).status,401);assert.equal((await api('/session')).state,'pending');
 assert.equal((await webhook(env.WEBHOOK_SECRET)).status,200);await Promise.all(pending);
 assert.equal((await api('/session')).state,'active');assert.equal(sent.length,0);
});
test('expired challenges, expired sessions and removed admins cannot authenticate',async()=>{
 const code=await begin();now+=601000;assert.match(await portalLoginCommand(env,42,'login '+code),/expired/);await login();now+=8*3600000+1;assert.equal((await request('/api/state')).status,401);
 await login();env.ADMIN_USER_IDS='43';assert.equal((await request('/api/state')).status,401);
});
test('mutations reject cross-origin requests and missing or wrong CSRF headers',async()=>{
 await login();for(const h of [{Origin:'https://evil.example'},{'X-Admin-CSRF':''},{'X-Admin-CSRF':'wrong'},{'X-Admin-Request':''}])assert.equal((await request('/api/posts',draft(),h)).status,403);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM admin_posts').get().n,0);
});
test('logout and Telegram revoke-all invalidate sessions',async()=>{
 await login();await api('/logout',{});assert.equal((await request('/api/state')).status,401);await login();await portalLoginCommand(env,42,'logout');assert.equal((await request('/api/state')).status,401);
});
test('login creation is rate-limited without exposing credentials in errors',async()=>{
 for(let n=0;n<5;n++)await begin();const r=await request('/api/login',{});assert.equal(r.status,429);assert.doesNotMatch(await r.text(),/123:fake|test-secret/);
});
test('new posts remain drafts, approval is separate, and state endpoint shows safe records',async()=>{
 await login();const p=await post();assert.equal(p.state,'draft');await drain();assert.equal(sent.length,0);
 assert.equal((await request(`/api/posts/${p.id}/publish`,{revision:1})).status,409);
 const state=await api('/state');assert.equal(state.posts[0].text,p.text);assert.equal(state.environment,'test');assert.ok(state.topics.length);assert.doesNotMatch(JSON.stringify(state),/123:fake|test-secret|token_hash|code_hash/);
});
test('approved text and poll posts deliver exactly once to the chosen topic',async()=>{
 await login();const p=await queued();await drain();await drain();assert.equal(sent.length,1);assert.equal(sent[0].body.chat_id,-100123);assert.equal(sent[0].body.message_thread_id,6);assert.equal(sqlite.prepare('SELECT state FROM admin_posts WHERE id=?').get(p.id).state,'published');
 const poll=(await api('/posts',draft({kind:'poll',text:'Who gets the job?',options:['R2','Chopper'],thread_id:4}))).post;
 await api(`/posts/${poll.id}/approve`,{revision:1});await api(`/posts/${poll.id}/publish`,{revision:1});await drain();assert.equal(sent.at(-1).method,'sendPoll');assert.equal(sent.at(-1).body.message_thread_id,4);
 assert.equal(sqlite.prepare('SELECT thread_id FROM community_polls').get().thread_id,4);
});
test('invalid settings do not partially change posting controls',async()=>{
 await login();assert.equal((await request('/api/settings',{paused:true,starter_mode:'invalid'})).status,400);
 assert.equal((await api('/state')).paused,false);
 assert.equal((await request('/api/settings',{paused:'false'})).status,400);
});
test('edits revoke approval and stale browser revisions cannot approve or publish',async()=>{
 await login();const p=await approved();await api(`/posts/${p.id}/edit`,{...draft({text:'Edited question?'}),revision:1});
 for(const a of ['approve','publish'])assert.equal((await request(`/api/posts/${p.id}/${a}`,{revision:1})).status,409);
 const row=sqlite.prepare('SELECT * FROM admin_posts').get();assert.equal(row.state,'draft');assert.equal(row.approved_revision,null);assert.equal(row.revision,2);
});
test('editing or cancelling queued content invalidates the old job',async()=>{
 await login();const p=await queued();await api(`/posts/${p.id}/edit`,{...draft({text:'Replacement draft?'}),revision:1});await drain();assert.equal(sent.length,0);
 const q=await approved();await api(`/posts/${q.id}/publish`,{revision:1});await schedulePortalPosts(env);await api(`/posts/${q.id}/cancel`,{revision:1});await drain();assert.equal(sent.length,0);
});
test('last-moment edit wins before delivery claim, and a claimed post cannot be edited',async()=>{
 await login();const p=await queued(),prepare=env.DB.prepare.bind(env.DB);let edited=false;
 env.DB.prepare=sql=>{const s=prepare(sql);if(sql.startsWith("UPDATE updates SET state='sending'")){const run=s.run;s.run=async()=>{const r=await run();if(!edited){edited=true;await changePost(env,42,p.id,1,'edit',draft({text:'A revised idea?'}));}return r;};}return s;};
 await drain();assert.ok(edited);assert.equal(sent.length,0);
 env.DB.prepare=prepare;await api(`/posts/${p.id}/approve`,{revision:2});await api(`/posts/${p.id}/publish`,{revision:2});await schedulePortalPosts(env);const job=sqlite.prepare("SELECT * FROM club_jobs WHERE job_key=?").get(`portal:${p.id}:2`);assert.equal(await claimPortalPost(env,job),'send');
 assert.equal((await request(`/api/posts/${p.id}/edit`,{...draft(),revision:2})).status,409);
});
test('scheduling uses Hong Kong time and reconstructs jobs after an interrupted enqueue',async()=>{
 await login();const p=await approved();await api(`/posts/${p.id}/publish`,{revision:1,schedule_hk:'2026-10-27T15:00'});await drain();assert.equal(sent.length,0);
 now=Date.parse('2026-10-27T07:00:01Z');await drain();assert.equal(sent.length,1);assert.equal(sqlite.prepare('SELECT scheduled_at FROM admin_posts').get().scheduled_at,Date.parse('2026-10-27T07:00:00Z')/1000);
});
test('invalid text, duplicate poll options, invalid topics and invalid schedule dates are rejected',async()=>{
 await login();for(const bad of [draft({text:''}),draft({thread_id:-1}),draft({kind:'poll',options:['same','same']}),draft({kind:'quiz',options:['a','b'],correct:4})])assert.equal((await request('/api/posts',bad)).status,400);
 const p=await approved();assert.equal((await request(`/api/posts/${p.id}/publish`,{revision:1,schedule_hk:'2026-02-30T12:00'})).status,400);
});
test('rate-limited portal delivery releases its claim and retries once without duplication',async()=>{
 await login();const p=await queued();const good=globalThis.fetch;globalThis.fetch=async()=>Response.json({ok:false,error_code:429,parameters:{retry_after:2}});await drain();assert.equal(sqlite.prepare('SELECT state FROM admin_posts').get().state,'scheduled');
 globalThis.fetch=good;now+=3000;await drain();await drain();assert.equal(sent.length,1);assert.equal(sqlite.prepare('SELECT state FROM admin_posts').get().state,'published');assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM automated_budget').get().n,0);
});
test('ambiguous sends are surfaced and never automatically repeated',async()=>{
 await login();await queued();let tries=0;globalThis.fetch=async()=>{tries++;throw Error('lost response');};await drain();await drain();assert.equal(tries,1);assert.equal(sqlite.prepare('SELECT state FROM admin_posts').get().state,'uncertain');
});
test('paused bot holds approved content and removed approver cancels it',async()=>{
 await login();await queued();await api('/settings',{paused:true});await drain();assert.equal(sent.length,0);env.ADMIN_USER_IDS='43';await schedulePortalPosts(env);assert.equal(sqlite.prepare('SELECT state FROM admin_posts').get().state,'cancelled');
});
test('proactive approval mode saves generated content without publishing it',async()=>{
 await login();await api('/settings',{starter_mode:'review'});
 sqlite.prepare('INSERT INTO updates(id,payload,created_at) VALUES (?,?,?)').run(-600,JSON.stringify({internal_post:{kind:'question',scheduled_at:now/1000}}),now/1000);await processUpdate(env,-600);
 assert.equal(sent.length,0);const p=sqlite.prepare('SELECT * FROM admin_posts').get();assert.equal(p.state,'draft');assert.equal(p.created_by,0);assert.equal(p.source_update,-600);
});
test('portal memory proposals and approvals reuse existing admin rules and keep receipts in browser',async()=>{
 await login();await api('/command',{name:'remember',arg:'rule|Spoilers|Hide plot spoilers.'});const m=sqlite.prepare('SELECT * FROM club_memory').get();assert.equal(m.status,'pending');assert.equal(m.source_message,null);
 await api('/command',{name:'approve',arg:'memory '+m.id});assert.equal(sqlite.prepare('SELECT status FROM club_memory').get().status,'approved');assert.equal(sent.length,0);
});
test('disabled production cannot expose portal data or accept login',async()=>{
 env.DEPLOYMENT_ENABLED='false';assert.equal((await request('')).status,503);assert.equal((await request('/api/login',{})).status,503);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM admin_sessions').get().n,0);
});
test('portal event drafts require confirmation and announce in the selected topic at Hong Kong time',async()=>{
 await login();await api('/command',{name:'event',arg:'create Café meetup|2026-11-07 18:00|Community café|lore|https://example.org/event'});
 const event=sqlite.prepare('SELECT * FROM club_events').get();assert.equal(event.status,'draft');assert.equal(event.thread_id,6);assert.equal(event.starts_at,Date.parse('2026-11-07T10:00:00Z')/1000);
 await drain();assert.equal(sent.length,0);
 await api('/command',{name:'event',arg:'confirm '+event.id});await drain();assert.equal(sent.length,1);assert.equal(sent[0].body.message_thread_id,6);assert.match(sent[0].body.text,/Café meetup/);assert.match(sent[0].body.text,/RSVP/);
});
test('portal moderation only queues an explicit approval and rejects unsupported commands',async()=>{
 await login();sqlite.prepare("INSERT INTO club_reviews(message_id,user_id,thread_id,reason,suggestion,created_at) VALUES (100,77,6,'Repeated promotion','delete',?)").run(now/1000);
 const review=(await api('/state')).reviews[0];await drain();assert.equal(sent.length,0);
 assert.equal((await request('/api/command',{name:'rsvp',arg:'1 yes remind'})).status,400);
 await api('/command',{name:'approve',arg:review.id+' delete'});
 const r=sqlite.prepare('SELECT * FROM club_reviews').get();assert.equal(r.approved_by,42);assert.equal(r.state,'approved');assert.equal(r.action,'delete');
 assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM club_jobs WHERE kind='moderation'").get().n,1);assert.equal(sent.length,0);
});

test('a definite 429 recovers even when releasing the portal claim fails once',async()=>{
 await login();const p=await queued(),id=-CLUB_OFFSET-p.job.id;await scheduleClub(env);
 const prepare=env.DB.prepare.bind(env.DB);let fail=true,attempts=0;
 env.DB.prepare=sql=>{const stmt=prepare(sql);if(sql.startsWith('UPDATE admin_posts SET state=?,updated_at=?')){const run=stmt.run;stmt.run=async()=>{if(fail){fail=false;throw Error('transient claim release failure');}return run();};}return stmt;};
 globalThis.fetch=async()=>{attempts++;return Response.json({ok:false,error_code:429,parameters:{retry_after:2}});};
 await processUpdate(env,id);assert.equal(sqlite.prepare('SELECT state FROM admin_posts').get().state,'sending');assert.equal(sqlite.prepare('SELECT state FROM updates WHERE id=?').get(id).state,'queued');
 env.DB.prepare=prepare;now+=3000;globalThis.fetch=async()=>{attempts++;return Response.json({ok:true,result:{message_id:901}});};
 await processUpdate(env,id);await processUpdate(env,id);assert.equal(attempts,2);assert.equal(sqlite.prepare('SELECT state FROM admin_posts').get().state,'published');
});
for(const reason of ['expired','removed approver'])test(`stale scheduler ${reason} snapshot cannot invalidate a new scheduled revision`,async()=>{
 await login();const p=await queued();if(reason==='expired')now+=86401000;else env.ADMIN_USER_IDS='43';
 const prepare=env.DB.prepare.bind(env.DB);let changed=false;
 env.DB.prepare=sql=>{const stmt=prepare(sql);if(sql.startsWith("SELECT * FROM admin_posts WHERE state='scheduled'")){const all=stmt.all;stmt.all=async()=>{const rows=await all();if(!changed){changed=true;await changePost(env,43,p.id,1,'edit',draft({text:'New future revision'}));await changePost(env,43,p.id,2,'approve');await changePost(env,43,p.id,2,'publish',{scheduled_at:now/1000+3600});}return rows;};}return stmt;};
 await schedulePortalPosts(env);const current=sqlite.prepare('SELECT * FROM admin_posts').get();assert.equal(current.revision,2);assert.equal(current.state,'scheduled');assert.equal(current.scheduled_at,now/1000+3600);
});

test('knowledge pagination reaches all records beyond 100 and rejects invalid offsets',async()=>{
 await login();
 const insert=sqlite.prepare("INSERT INTO club_memory(title,body,kind,proposed_by,status,created_at) VALUES (?,'Reference body','movie_quote',42,'approved',1)");
 for(let i=1;i<=211;i++)insert.run('Entry '+i);
 const pages=[];for(const offset of [0,100,200])pages.push(await api('/state?memory_offset='+offset));
 assert.deepEqual(pages.map(p=>p.memory.length),[100,100,11]);assert.equal(new Set(pages.flatMap(p=>p.memory.map(r=>r.id))).size,211);
 assert.deepEqual(pages[2].memory_page,{offset:200,limit:100,total:211});assert.equal(pages[2].memory.at(-1).title,'Entry 1');
 for(const offset of ['-1','1.5','Infinity','1000001','abc'])assert.equal((await request('/api/state?memory_offset='+offset)).status,400);
 cookie='';assert.equal((await request('/api/state?memory_offset=100')).status,401);
});

test('post pagination filters the full library and counts drafts across every page',async()=>{
 await login();const insert=sqlite.prepare("INSERT INTO admin_posts(kind,text,options,state,created_by,created_at,updated_at) VALUES ('poll',?,'[\"A\",\"B\"]',?,42,1,1)");
 for(let i=1;i<=128;i++)insert.run('Imported poll '+i,'draft');for(let i=1;i<=5;i++)insert.run('Published '+i,'published');
 const first=await api('/state'),second=await api('/state?post_offset=100');assert.equal(first.posts.length,100);assert.equal(second.posts.length,33);assert.equal(new Set([...first.posts,...second.posts].map(p=>p.id)).size,133);assert.equal(first.post_counts.draft,128);
 const drafts=await api('/state?post_state=draft&post_offset=100');assert.equal(drafts.posts.length,28);assert.equal(drafts.post_page.total,128);assert.ok(drafts.posts.every(p=>p.state==='draft'));
 assert.equal((await api('/state?post_state=published')).posts.length,5);
 for(const q of ['post_offset=-1','post_offset=abc','post_offset=1.5','post_state=unknown'])assert.equal((await request('/api/state?'+q)).status,400);
});
