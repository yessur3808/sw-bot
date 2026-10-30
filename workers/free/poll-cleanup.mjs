import {nowSeconds} from './engagement.mjs';
import {assertDeployment} from './production.mjs';

// Aggregate evidence only: never infer zero participation from missing/deleted
// member answers. Only confirmed bot sends in this deployment can be removed.
export async function trackPollCleanup(env,body,result){
 if(!result?.poll?.id || !Number.isSafeInteger(result.message_id) || result.message_id<=0 || Number(body.chat_id)!==Number(env.GROUP_ID) || !Number.isSafeInteger(body.close_date))return;
 const options=body.options.map(o=>typeof o==='string'?o:o.text);
 await env.DB.prepare(`INSERT OR IGNORE INTO poll_cleanup(poll_id,chat_id,message_id,options,created_at,closes_at) VALUES (?,?,?,?,?,?)`)
 .bind(result.poll.id,Number(body.chat_id),result.message_id,JSON.stringify(options),nowSeconds(),body.close_date).run();
 await observeCleanupPoll(env,result.poll);
}
export async function observeCleanupPoll(env,poll){
 const known=await env.DB.prepare('SELECT options FROM poll_cleanup WHERE poll_id=? AND chat_id=?').bind(poll.id,Number(env.GROUP_ID)).first();
 if(!known || !Array.isArray(poll.options))return;
 const expected=JSON.parse(known.options);
 if(poll.options.length!==expected.length || poll.options.some((p,i)=>p.text!==expected[i] || !Number.isSafeInteger(p.voter_count) || p.voter_count<0))return;
 const votes=poll.options.reduce((n,p)=>n+p.voter_count,0);
 if(!Number.isSafeInteger(votes) || (poll.total_voter_count!==undefined && poll.total_voter_count!==votes))return;
 await env.DB.prepare(`UPDATE poll_cleanup SET had_votes=MAX(had_votes,?),final_votes=CASE WHEN ? THEN MAX(COALESCE(final_votes,0),?) ELSE final_votes END WHERE poll_id=? AND chat_id=?`)
 .bind(votes>0?1:0,poll.is_closed===true?1:0,votes,poll.id,Number(env.GROUP_ID)).run();
}
export async function observeCleanupAnswer(env,answer){
 if(!answer.option_ids?.length)return;
 await env.DB.prepare('UPDATE poll_cleanup SET had_votes=1 WHERE poll_id=? AND chat_id=?').bind(answer.poll_id,Number(env.GROUP_ID)).run();
}
async function telegram(env,method,p){
 const res=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:p.chat_id,message_id:p.message_id}),signal:AbortSignal.timeout(8000)});
 return res.json();
}
export async function cleanupEmptyPolls(env){
 await assertDeployment(env);
 const now=nowSeconds();
 await env.DB.prepare("UPDATE poll_cleanup SET state='expired' WHERE state='pending' AND created_at<?").bind(now-86400).run();
 const rows=(await env.DB.prepare("SELECT * FROM poll_cleanup WHERE state='pending' AND chat_id=? AND closes_at<=? AND next_attempt_at<=? ORDER BY closes_at LIMIT 3").bind(Number(env.GROUP_ID),now,now).all()).results;
 for(const p of rows){
  const claim=await env.DB.prepare("UPDATE poll_cleanup SET next_attempt_at=? WHERE poll_id=? AND state='pending' AND next_attempt_at<=?").bind(now+60,p.poll_id,now).run();
  if(!claim.meta.changes)continue;
  try{
   if(p.had_votes || p.final_votes>0){await finish(env,p,'kept');continue;}
   if(p.final_votes===null){
    const closed=await telegram(env,'stopPoll',p);
    if(!closed.ok){await retry(env,p,closed);continue;}
    if(closed.result?.id===p.poll_id)await observeCleanupPoll(env,closed.result);
   }
   // Re-read after network work: a final webhook/answer may have arrived meanwhile.
   const fresh=await env.DB.prepare('SELECT * FROM poll_cleanup WHERE poll_id=?').bind(p.poll_id).first();
   if(fresh.had_votes || fresh.final_votes>0){await finish(env,p,'kept');continue;}
   if(fresh.final_votes!==0){await retry(env,p,{error_code:'final-results-unavailable'});continue;}
   const removed=await telegram(env,'deleteMessage',p);
   if(removed.ok || (removed.error_code===400 && /message to delete not found/i.test(removed.description||'')))await finish(env,p,'deleted');
   else await retry(env,p,removed);
  }catch{await retry(env,p,{error_code:'network-or-recording-error'});}
 }
 await env.DB.prepare('DELETE FROM poll_cleanup WHERE created_at<?').bind(now-7*86400).run();
}
async function finish(env,p,state){
 await env.DB.prepare('UPDATE poll_cleanup SET state=?,last_error=NULL WHERE poll_id=?').bind(state,p.poll_id).run();
}
async function retry(env,p,error){
 const delay=Math.max(60,Number(error.parameters?.retry_after)||300);
 await env.DB.prepare('UPDATE poll_cleanup SET next_attempt_at=?,last_error=? WHERE poll_id=?').bind(nowSeconds()+delay,String(error.error_code||'telegram-error'),p.poll_id).run();
}
