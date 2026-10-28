import { nowSeconds } from './engagement.mjs';
import { queueClub, CLUB_OFFSET, isAdmin } from './cantina-core.mjs';

export function portalError(message,status=400){return Object.assign(new Error(message),{status});}
export function validatePost(value,env){
 const {kind,text,thread_id=0}=value,options=value.options??[];
 if(!['text','poll','quiz'].includes(kind)||typeof text!=='string'||!text.trim()||text.length>(kind==='text'?3500:240))throw portalError('Enter a post (up to 3,500 characters) or a poll question (up to 240).');
 if(!Number.isSafeInteger(thread_id)||thread_id<0)throw portalError('Choose a valid topic.');
 const allow=(env.ALLOWED_THREAD_IDS||'').split(',').filter(Boolean).map(Number);
 if(allow.length&&!allow.includes(thread_id))throw portalError('This topic is outside the configured allowlist.');
 if(kind!=='text'&&(!Array.isArray(options)||options.length<2||options.length>10||options.some(o=>typeof o!=='string'||!o.trim()||o.length>100)||new Set(options.map(o=>o.trim())).size!==options.length))throw portalError('Polls need 2–10 distinct options, each up to 100 characters.');
 const correct=kind==='quiz'?value.correct:null;
 if(kind==='quiz'&&(!Number.isInteger(correct)||correct<0||correct>=options.length))throw portalError('Choose the correct quiz option.');
 return {kind,text:text.trim(),options:kind==='text'?[]:options.map(o=>o.trim()),correct,thread_id};
}
export async function audit(env,user,action,target=null){
 const r=await env.DB.prepare('INSERT INTO admin_actions(user_id,action,target_id,created_at) VALUES (?,?,?,?) RETURNING id').bind(user,action,target,nowSeconds()).first();return r.id;
}
export async function createPost(env,user,value,sourceUpdate=null){
 const p=validatePost(value,env),now=nowSeconds();
 const row=await env.DB.prepare(`INSERT OR IGNORE INTO admin_posts(kind,text,options,correct,thread_id,created_by,created_at,updated_at,source_update)
 VALUES (?,?,?,?,?,?,?,?,?) RETURNING *`).bind(p.kind,p.text,JSON.stringify(p.options),p.correct,p.thread_id,user,now,now,sourceUpdate).first();
 if(row)await audit(env,user,'post.create',row.id);return row;
}
export async function captureProactiveDraft(env,id,post,thread){
 await createPost(env,0,{kind:post.options?(post.correct===undefined?'poll':'quiz'):'text',text:post.text||post.question,options:post.options||[],correct:post.correct,thread_id:thread},id);
 await env.DB.prepare("UPDATE engagement_posts SET state='awaiting_review' WHERE update_id=? AND state<>'sent'").bind(id).run();
}
export async function changePost(env,user,id,revision,action,value={}){
 if(!Number.isSafeInteger(id)||!Number.isSafeInteger(revision))throw portalError('Invalid post or revision.');
 let row;
 if(action==='edit'){
  const p=validatePost(value,env);
  row=await env.DB.prepare(`UPDATE admin_posts SET kind=?,text=?,options=?,correct=?,thread_id=?,state='draft',revision=revision+1,
   approved_revision=NULL,approved_by=NULL,scheduled_at=NULL,job_id=NULL,updated_at=?
   WHERE id=? AND revision=? AND state IN ('draft','approved','scheduled') RETURNING *`)
   .bind(p.kind,p.text,JSON.stringify(p.options),p.correct,p.thread_id,nowSeconds(),id,revision).first();
 }else if(action==='approve'){
  row=await env.DB.prepare("UPDATE admin_posts SET state='approved',approved_revision=revision,approved_by=?,updated_at=? WHERE id=? AND revision=? AND state='draft' RETURNING *").bind(user,nowSeconds(),id,revision).first();
 }else if(action==='cancel'){
  row=await env.DB.prepare("UPDATE admin_posts SET state='cancelled',revision=revision+1,approved_revision=NULL,updated_at=? WHERE id=? AND revision=? AND state IN ('draft','approved','scheduled') RETURNING *").bind(nowSeconds(),id,revision).first();
 }else if(action==='publish'){
  const at=value.scheduled_at??nowSeconds();
  if(!Number.isSafeInteger(at)||at<nowSeconds()-60||at>nowSeconds()+90*86400)throw portalError('Choose now or a Hong Kong time within the next 90 days.');
  row=await env.DB.prepare("UPDATE admin_posts SET state='scheduled',scheduled_at=?,updated_at=? WHERE id=? AND revision=? AND state='approved' AND approved_revision=revision RETURNING *").bind(Math.max(at,nowSeconds()),nowSeconds(),id,revision).first();
  // Maintenance reconstructs the durable job if the process stops after this write.
 }else throw portalError('Unknown post action.');
 if(!row)throw portalError('This post changed or is already being delivered. Refresh before trying again.',409);
 await audit(env,user,'post.'+action,id);return row;
}
export async function schedulePortalPosts(env){
 const now=nowSeconds();
 const posts=(await env.DB.prepare("SELECT * FROM admin_posts WHERE state='scheduled' AND approved_revision=revision AND scheduled_at<=? ORDER BY scheduled_at LIMIT 20").bind(now).all()).results;
 for(const p of posts){
  if(!isAdmin(env,p.approved_by)){await env.DB.prepare("UPDATE admin_posts SET state='cancelled' WHERE id=? AND revision=? AND scheduled_at=? AND approved_by=? AND state='scheduled'").bind(p.id,p.revision,p.scheduled_at,p.approved_by).run();continue;}
  if(p.scheduled_at<now-86400){await env.DB.prepare("UPDATE admin_posts SET state='expired' WHERE id=? AND revision=? AND scheduled_at=? AND state='scheduled'").bind(p.id,p.revision,p.scheduled_at).run();continue;}
  const job=await queueClub(env,`portal:${p.id}:${p.revision}`,'portal_post',{post_id:p.id,revision:p.revision,requested:true},p.thread_id,null,p.scheduled_at,86400);
  await env.DB.prepare("UPDATE admin_posts SET job_id=? WHERE id=? AND revision=? AND state='scheduled'").bind(job.id,p.id,p.revision).run();
 }
 // Ambiguous deliveries are surfaced for manual inspection, never replayed.
 await env.DB.prepare(`UPDATE admin_posts SET state=COALESCE(
  (SELECT CASE WHEN u.state IN ('failed','uncertain') THEN u.state WHEN j.state IN ('expired','cancelled','budget_limited') THEN j.state ELSE NULL END
   FROM club_jobs j LEFT JOIN updates u ON u.id=-${CLUB_OFFSET}-j.id WHERE j.id=admin_posts.job_id),state)
  WHERE state IN ('scheduled','sending') AND job_id IS NOT NULL`).run();
 await env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at<?').bind(now).run();
 await env.DB.prepare('DELETE FROM admin_limits WHERE expires_at<?').bind(now).run();
 await env.DB.prepare('DELETE FROM admin_actions WHERE created_at<?').bind(now-90*86400).run();
}
export async function portalPostBody(env,job){
 const {post_id,revision}=JSON.parse(job.data);
 // A definite Telegram 429 is safe to retry even if releasing the post claim
 // failed. Only the leased retry can recover it; uncertain sends never qualify.
 await env.DB.prepare(`UPDATE admin_posts SET state='scheduled' WHERE id=? AND revision=? AND job_id=? AND state='sending'
  AND EXISTS(SELECT 1 FROM updates WHERE id=? AND state='processing' AND error='telegram-rate-limit')`)
  .bind(post_id,revision,job.id,-CLUB_OFFSET-job.id).run();
 const p=await env.DB.prepare("SELECT * FROM admin_posts WHERE id=? AND revision=? AND approved_revision=revision AND state='scheduled'").bind(post_id,revision).first();
 if(!p||!isAdmin(env,p.approved_by))return null;
 const validated=validatePost({...p,options:JSON.parse(p.options)},env),base={chat_id:Number(env.GROUP_ID),...(validated.thread_id?{message_thread_id:validated.thread_id}:{})};
 return p.kind==='text'?{method:'sendMessage',body:{...base,text:p.text}}:{method:'sendPoll',body:{...base,question:p.text,options:validated.options,is_anonymous:p.kind!=='quiz',...(p.kind==='quiz'?{type:'quiz',correct_option_id:p.correct,open_period:120}: {})}};
}
export async function claimPortalPost(env,job){
 const {post_id,revision}=JSON.parse(job.data);
 const p=await env.DB.prepare('SELECT approved_by FROM admin_posts WHERE id=?').bind(post_id).first();
 if(!p||!isAdmin(env,p.approved_by))return 'cancel';
 const r=await env.DB.prepare("UPDATE admin_posts SET state='sending',updated_at=? WHERE id=? AND revision=? AND approved_revision=revision AND state='scheduled' AND scheduled_at<=?").bind(nowSeconds(),post_id,revision,nowSeconds()).run();
 return r.meta.changes?'send':'cancel';
}
export async function portalPostDelivered(env,job,result){
 const {post_id,revision}=JSON.parse(job.data);
 const p=await env.DB.prepare("UPDATE admin_posts SET state='published',message_id=?,updated_at=? WHERE id=? AND revision=? AND state='sending' RETURNING source_update").bind(result?.message_id||null,nowSeconds(),post_id,revision).first();
 if(p?.source_update)await env.DB.prepare("UPDATE engagement_posts SET state='sent',message_id=? WHERE update_id=?").bind(result?.message_id||null,p.source_update).run();
}
export async function portalPostFailed(env,job,id){
 const u=await env.DB.prepare('SELECT state FROM updates WHERE id=?').bind(id).first(),{post_id,revision}=JSON.parse(job.data);
 const state=u?.state==='queued'?'scheduled':u?.state==='failed'?'failed':'uncertain';
 await env.DB.prepare("UPDATE admin_posts SET state=?,updated_at=? WHERE id=? AND revision=? AND state='sending'").bind(state,nowSeconds(),post_id,revision).run();
}
