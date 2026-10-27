// Deployment isolation and a shared Hong Kong calendar-day automation budget.
// Identity is provisioned explicitly; never adopt a new group automatically.
export const hkDay = () => new Date(Date.now()+8*3600000).toISOString().slice(0,10);
export function automatedCap(env) {
 const n=Number(env.AUTOMATED_DAILY_CAP ?? 20);
 if(!Number.isInteger(n)||n<5||n>100)throw Error('invalid-automated-daily-cap');
 return n;
}
export async function assertDeployment(env) {
 if(env.DEPLOYMENT_ENABLED==='false')throw Error('deployment-disabled');
 if(!/^-100\d+$/.test(String(env.GROUP_ID)))throw Error('invalid-group-id');
 if(!env.ADMIN_USER_IDS||!env.ADMIN_USER_IDS.split(',').every(id=>/^\d+$/.test(id.trim())&&Number(id)>0))throw Error('invalid-admin-list');
 automatedCap(env);
 const allow=(env.ALLOWED_THREAD_IDS||'').split(',').filter(v=>v.trim()).map(Number);
 const thread=Number(env.PRIVATE_THREAD_ID??env.PROACTIVE_THREAD_ID??allow[0]??0);
 if(!Number.isSafeInteger(thread)||thread<0||allow.some(n=>!Number.isSafeInteger(n)||n<0)||allow.length&&!allow.includes(thread))throw Error('invalid-topic-routing');
 const identity=await env.DB.prepare('SELECT group_id,environment FROM deployment_identity WHERE id=1').first();
 if(!identity||identity.group_id!==String(env.GROUP_ID)||identity.environment!==(env.DEPLOYMENT_ENV||'test'))throw Error('database-group-mismatch');
}
export async function budgetStatus(env) {
 return {used:(await env.DB.prepare('SELECT COUNT(*) n FROM automated_budget WHERE day=?').bind(hkDay()).first()).n,cap:automatedCap(env)};
}
export function automaticDelivery(payload,job,username,botId) {
 if(job){
  const data=JSON.parse(job.data);
  if(job.kind==='moderation'||job.job_key.startsWith('moderation-result:'))return false;
  if(data.requested&&['briefing','event_poll','event_announcement','text'].includes(job.kind))return false;
  return true;
 }
 if(payload.internal_post)return !payload.internal_post.requested;
 if(payload.internal_followup)return true;
 const m=payload.message;
 if(!m||m.chat?.type==='private'||String(m.text||'').startsWith('/'))return false;
 const escaped=String(username).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 return !(escaped&&new RegExp(`@${escaped}\\b`,'i').test(m.text||''))&&m.reply_to_message?.from?.id!==botId;
}
export async function reserveAutomation(env,id) {
 const day=hkDay();
 if(await env.DB.prepare('SELECT 1 FROM automated_budget WHERE day=? AND update_id=?').bind(day,id).first())return true;
 const result=await env.DB.prepare(`INSERT OR IGNORE INTO automated_budget(day,update_id) SELECT ?,? WHERE
 (SELECT COUNT(*) FROM automated_budget WHERE day=?)<?`).bind(day,id,day,automatedCap(env)).run();
 return Boolean(result.meta.changes);
}
export async function readiness(env) {
 const issues=[],notes=[];
 try{await assertDeployment(env);}catch(e){issues.push(e.message);}
 const required=(env.REQUIRED_TOPICS||'gaming,movies,lore').split(',').map(s=>s.trim()).filter(Boolean);
 const topics=(await env.DB.prepare('SELECT name,thread_id FROM topic_map').all()).results;
 const allow=(env.ALLOWED_THREAD_IDS||'').split(',').filter(Boolean).map(Number);
 for(const name of required){const row=topics.find(t=>t.name===name);if(!row||row.thread_id<=0)issues.push(`Bind topic: ${name}`);else if(allow.length&&!allow.includes(row.thread_id))issues.push(`Topic outside allowlist: ${name}`);}
 if(!await env.DB.prepare("SELECT 1 FROM club_memory WHERE kind='rule' AND status='approved' LIMIT 1").first())issues.push('Add and approve the real group rules');
 for(const [method,body] of [['getMe',{}],['getChat',{chat_id:Number(env.GROUP_ID)}],['getChatMember',{chat_id:Number(env.GROUP_ID),user_id:Number((env.BOT_TOKEN||'').split(':')[0])}],['getWebhookInfo',{}]]){
  try{
   const response=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
   const r=await response.json();if(!r.ok){issues.push(`${method}: verification failed`);continue;}
   if(method==='getMe'&&r.result.username?.toLowerCase()!==env.BOT_USERNAME?.toLowerCase())issues.push('Bot username/token mismatch');
   if(method==='getChat'&&(r.result.id!==Number(env.GROUP_ID)||!r.result.is_forum))issues.push('Target must be the configured forum group');
   if(method==='getChatMember'){
    if(!['administrator','creator'].includes(r.result.status))issues.push('Bot needs group administrator access');
    if(!r.result.can_delete_messages)issues.push('Missing delete-messages permission');
    if(!r.result.can_restrict_members)issues.push('Missing restrict-members permission');
   }
   if(method==='getWebhookInfo'){
    if(!env.EXPECTED_WEBHOOK_URL||r.result.url!==env.EXPECTED_WEBHOOK_URL)issues.push('Confirm EXPECTED_WEBHOOK_URL matches Telegram');
    for(const type of ['message','poll','poll_answer','message_reaction'])if(!r.result.allowed_updates?.includes(type))issues.push(`Missing webhook update type: ${type}`);
    if(r.result.pending_update_count)notes.push(`Pending Telegram updates: ${r.result.pending_update_count}`);
   }
  }catch{issues.push(`${method}: network verification failed`);}
 }
 // The allowlist grants bot privileges; confirm each listed person is a real group admin.
 for(const user_id of (env.ADMIN_USER_IDS||'').split(',').map(Number).filter(n=>n>0)){
  try{const r=await (await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getChatMember`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:Number(env.GROUP_ID),user_id}),signal:AbortSignal.timeout(8000)})).json();if(!r.ok||!['administrator','creator'].includes(r.result.status))issues.push(`Configured admin ${user_id} is not verified as a group admin`);}catch{issues.push(`Could not verify admin ${user_id}`);}
 }
 const b=await budgetStatus(env);
 notes.push(`Automated sends reserved today: ${b.used}/${b.cap} (HKT)`,'Admin reports and private-request answers are public in the group.','Events require admin confirmation; sources are not independently verified.');
 return {issues,notes};
}
