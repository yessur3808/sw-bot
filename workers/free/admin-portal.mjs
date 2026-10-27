import { assertDeployment, readiness, budgetStatus } from './production.mjs';
import { nowSeconds, setting, setSetting, PERSONALITY, cleanAnswer } from './engagement.mjs';
import { isAdmin, handleCoreCommand, parseHK, messageLink, clubQuota } from './cantina-core.mjs';
import { topicName } from './community.mjs';
import { audit, createPost, changePost, portalError } from './portal-content.mjs';
import { PORTAL_HTML, PORTAL_CSS, PORTAL_JS } from './portal-ui.mjs';

const COOKIE='__Host-sw_admin';
const hex=b=>Array.from(new Uint8Array(b),v=>v.toString(16).padStart(2,'0')).join('');
const random=n=>hex(crypto.getRandomValues(new Uint8Array(n)));
export const digest=async s=>hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
const headers={ 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
 'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
 'Permissions-Policy':'camera=(), microphone=(), geolocation=()','X-Frame-Options':'DENY' };
const json=(data,status=200,extra={})=>Response.json(data,{status,headers:{...headers,...extra}});
const cookie=(value,age)=>`${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`;
const tokenFrom=request=>request.headers.get('Cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)||'';
async function session(request,env){
 const token=tokenFrom(request);if(!/^[a-f0-9]{64}$/.test(token))return null;
 const s=await env.DB.prepare('SELECT * FROM admin_sessions WHERE token_hash=? AND expires_at>?').bind(await digest(token),nowSeconds()).first();
 return s?{...s,csrf:await digest('csrf:'+token)}:null;
}
async function limit(env,key,max,seconds){
 const now=nowSeconds(),r=await env.DB.prepare(`INSERT INTO admin_limits(key,hits,expires_at) VALUES (?,1,?)
 ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN expires_at<=? THEN 1 ELSE hits+1 END,expires_at=CASE WHEN expires_at<=? THEN ? ELSE expires_at END
 WHERE expires_at<=? OR hits<? RETURNING hits`).bind(key,now+seconds,now,now,now+seconds,now,max).first();
 if(!r)throw portalError('Too many requests. Please try again later.',429);
}
async function input(request){
 if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw portalError('Use JSON.',415);
 if(Number(request.headers.get('Content-Length')||0)>16384)throw portalError('Request too large.',413);
 const reader=request.body?.getReader();if(!reader)throw portalError('Missing request body.');
 const chunks=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16384){await reader.cancel();throw portalError('Request too large.',413);}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
 try{const data=JSON.parse(new TextDecoder().decode(bytes));if(!data||typeof data!=='object'||Array.isArray(data))throw Error();return data;}catch{throw portalError('Invalid JSON.');}
}
export async function portalLoginCommand(env,user,arg){
 if(!isAdmin(env,user))return 'This command is for configured admins.';
 if(arg==='logout'){
  await env.DB.prepare('DELETE FROM admin_sessions WHERE user_id=?').bind(user).run();await audit(env,user,'session.revoke_all');return 'All your admin portal sessions have been signed out.';
 }
 if(!/^login [a-f0-9]{24}$/i.test(arg))return 'Open '+String(env.EXPECTED_WEBHOOK_URL||'').replace(/\/telegram$/,'/admin')+' to sign in. Only approve a code displayed in your own browser. /admin logout signs out all your portal sessions.';
 await limit(env,'login-user:'+user,10,600);
 const code=arg.slice(6).toLowerCase();
 const row=await env.DB.prepare('UPDATE admin_sessions SET user_id=?,code_hash=NULL,expires_at=? WHERE code_hash=? AND user_id IS NULL AND expires_at>? RETURNING token_hash').bind(user,nowSeconds()+8*3600,await digest(code),nowSeconds()).first();
 if(!row)return 'That sign-in code is expired or already used. Start again in the portal.';
 await audit(env,user,'session.approve');return 'Admin portal sign-in approved for your browser. Return to the portal. Only approve sign-ins you started yourself; /admin logout revokes your sessions.';
}
export async function portalFetch(request,env){
 const url=new URL(request.url),path=url.pathname;
 if(path!=='/admin'&&!path.startsWith('/admin/'))return null;
 try{
  await assertDeployment(env);
  if(request.method==='GET'&&['/admin','/admin/','/admin/app.js','/admin/app.css'].includes(path)){
   const [body,type]=path.endsWith('.js')?[PORTAL_JS,'text/javascript']:path.endsWith('.css')?[PORTAL_CSS,'text/css']:[PORTAL_HTML,'text/html'];
   return new Response(body,{headers:{...headers,'Content-Type':type+'; charset=utf-8'}});
  }
  if(!path.startsWith('/admin/api/'))return json({error:'Not found'},404);
  const mutating=request.method!=='GET';
  if(mutating&&(request.method!=='POST'||request.headers.get('Origin')!==url.origin||request.headers.get('X-Admin-Request')!=='1'))throw portalError('Request origin rejected.',403);
  if(path==='/admin/api/login'&&request.method==='POST'){
   const old=await session(request,env);if(old?.user_id&&isAdmin(env,old.user_id))return json({state:'active'});
   await limit(env,'login-ip:'+await digest(request.headers.get('CF-Connecting-IP')||'unknown'),5,900);
   await limit(env,'login-global',100,900);
   const token=random(32),code=random(12),now=nowSeconds();
   if(old)await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash=? AND user_id IS NULL').bind(old.token_hash).run();
   await env.DB.prepare('INSERT INTO admin_sessions(token_hash,code_hash,created_at,expires_at) VALUES (?,?,?,?)').bind(await digest(token),await digest(code),now,now+600).run();
   return json({code,bot:env.BOT_USERNAME,expires_at:now+600},200,{'Set-Cookie':cookie(token,8*3600)});
  }
  const s=await session(request,env),active=s?.user_id&&isAdmin(env,s.user_id);
  if(path==='/admin/api/session'&&request.method==='GET')return json(active?{state:'active',csrf:s.csrf,user_id:s.user_id,expires_at:s.expires_at}:{state:s&&!s.user_id?'pending':'signed_out'});
  if(!active)throw portalError('Sign in with your Telegram admin account.',401);
  if(mutating&&request.headers.get('X-Admin-CSRF')!==s.csrf)throw portalError('Session verification failed. Refresh the page.',403);
  const data=mutating?await input(request):null;
  if(path==='/admin/api/logout'&&mutating){await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash=?').bind(s.token_hash).run();return json({ok:true},200,{'Set-Cookie':cookie('',0)});}
  if(path==='/admin/api/state'&&request.method==='GET'){
   const results=await env.DB.batch([
    env.DB.prepare('SELECT * FROM admin_posts ORDER BY id DESC LIMIT 100'),env.DB.prepare('SELECT * FROM topic_map ORDER BY name'),
    env.DB.prepare("SELECT * FROM club_memory WHERE status IN ('pending','approved') ORDER BY id DESC LIMIT 100"),
    env.DB.prepare("SELECT * FROM club_events WHERE status<>'cancelled' AND (starts_at IS NULL OR starts_at>?) ORDER BY created_at DESC LIMIT 50").bind(nowSeconds()),
    env.DB.prepare("SELECT * FROM club_reviews WHERE state='pending' ORDER BY id DESC LIMIT 50"),
    env.DB.prepare('SELECT * FROM admin_actions ORDER BY id DESC LIMIT 50'),
    env.DB.prepare("SELECT id,kind,state,run_at,message_id FROM club_jobs WHERE state IN ('pending','uncertain','failed') ORDER BY run_at LIMIT 50")]);
   const [posts,topics,memory,events,reviews,actions,jobs]=results.map(r=>r.results);
   return json({posts:posts.map(p=>({...p,options:JSON.parse(p.options),link:messageLink(env,p.message_id,p.thread_id)})),topics,memory:memory.map(m=>({...m,link:messageLink(env,m.source_message,m.source_thread)})),events,reviews:reviews.map(r=>({...r,link:messageLink(env,r.message_id,r.thread_id)})),actions,jobs,
    environment:env.DEPLOYMENT_ENV||'test',group_id:env.GROUP_ID,paused:await setting(env,'paused')==='1',quiet_until:Number(await setting(env,'quiet_until')||0),starter_mode:await setting(env,'portal_starter_approval')==='1'?'review':'automatic',budget:await budgetStatus(env),readiness:JSON.parse(await setting(env,'launch_readiness')||'null')});
  }
  if(path==='/admin/api/posts'&&mutating){await limit(env,'posts:'+s.user_id,30,3600);return json({post:await createPost(env,s.user_id,data)},201);}
  const postPath=path.match(/^\/admin\/api\/posts\/(\d+)\/(edit|approve|publish|cancel)$/);
  if(postPath&&mutating){
   if(postPath[2]==='publish'&&data.schedule_hk){const t=parseHK(String(data.schedule_hk).replace('T',' '));if(!t)throw portalError('Invalid Hong Kong date/time.');data.scheduled_at=t;}
   return json({post:await changePost(env,s.user_id,Number(postPath[1]),data.revision,postPath[2],data)});
  }
  if(path==='/admin/api/generate'&&mutating){
   if(typeof data.prompt!=='string'||data.prompt.length<5||data.prompt.length>1000)throw portalError('Describe the draft in 5–1,000 characters.');
   if(!await clubQuota(env,s.user_id,'portal-ai',10))throw portalError('Daily draft generation limit reached.',429);
   const r=await env.AI.run(env.AI_MODEL,{messages:[{role:'system',content:PERSONALITY+' Write an unpublished draft for admin review. No invented news, dates, links or group consensus. Return only the draft text, under 1200 characters.'},{role:'user',content:data.prompt}],max_tokens:450,temperature:0.8},{signal:AbortSignal.timeout(15000)});
   const text=cleanAnswer(r.response,1500);if(!text)throw portalError('No draft returned. Please try again.',502);
   await audit(env,s.user_id,'draft.generate');return json({text});
  }
  if(path==='/admin/api/command'&&mutating){
   if(!['remember','memory','approve','dismiss','event','briefing','quiet'].includes(data.name)||typeof data.arg!=='string'||data.arg.length>1800)throw portalError('Unsupported admin action.');
   const id=700000000000000+await audit(env,s.user_id,'command.'+data.name),messages=[];
   // Trusted portal action, not an inbound Telegram update. Reuse the same
   // permission and validation rules; return receipts privately to the portal.
   await handleCoreCommand(env,{update_id:id,message:{from:{id:s.user_id,is_bot:false},chat:{id:s.user_id,type:'private'},text:''}},{name:data.name,arg:data.arg},async(_env,_id,_m,text)=>messages.push(text));
   return json({messages});
  }
  if(path==='/admin/api/settings'&&mutating){
   if(data.starter_mode!==undefined&&!['review','automatic'].includes(data.starter_mode))throw portalError('Choose an approval mode.');
   if(data.paused!==undefined&&typeof data.paused!=='boolean')throw portalError('Choose whether to pause the bot.');
   if(typeof data.paused==='boolean'){
    if(!data.paused&&env.DEPLOYMENT_ENV==='production'){const r=await readiness(env);if(r.issues.length)throw portalError('Readiness checks must pass before resuming production.',409);}
    await setSetting(env,'paused',data.paused?1:0);
   }
   if(data.starter_mode!==undefined)await setSetting(env,'portal_starter_approval',data.starter_mode==='review'?1:0);
   await audit(env,s.user_id,'settings.update');return json({ok:true});
  }
  if(path==='/admin/api/topics'&&mutating){
   const name=topicName(data.name),id=data.thread_id,allow=(env.ALLOWED_THREAD_IDS||'').split(',').filter(Boolean).map(Number);
   if(!name||!Number.isSafeInteger(id)||id<0||allow.length&&!allow.includes(id))throw portalError('Enter a valid topic name and Telegram topic ID.');
   await env.DB.prepare('INSERT INTO topic_map(name,thread_id) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET thread_id=excluded.thread_id').bind(name,id).run();await audit(env,s.user_id,'topic.bind',id);return json({ok:true});
  }
  if(path==='/admin/api/readiness'&&mutating){await limit(env,'readiness:'+s.user_id,5,600);const report={checked_at:nowSeconds(),...await readiness(env)};await setSetting(env,'launch_readiness',JSON.stringify(report));return json(report);}
  return json({error:'Not found'},404);
 }catch(error){return json({error:error.status?error.message:'The request could not be completed. Please try again.'},error.status||503);}
}
