import {nowSeconds,localDay,activeHours,setting,setSetting,cleanAnswer} from './engagement.mjs';
import {quiet,defer,topicThread} from './community.mjs';
import {CLUB_OFFSET,queueClub,clubPaused,out,isAdmin,prepareBriefing,briefingSourcesAllowed,messageLink,hkTime} from './cantina-core.mjs';
import {startGame,gameBody,gameDelivered,scheduleGames,gameDeliveryStatus} from './cantina-games.mjs';
import {portalPostBody,claimPortalPost,portalPostDelivered,portalPostFailed} from './portal-content.mjs';
export async function clubJob(env,updateId){return env.DB.prepare('SELECT * FROM club_jobs WHERE id=?').bind(-updateId-CLUB_OFFSET).first();}
export async function clubAllowed(env,job){
 if(!job||job.state!=='pending')return 'cancel';
 if(job.expires_at<nowSeconds()){await env.DB.prepare("UPDATE club_jobs SET state='expired' WHERE id=?").bind(job.id).run();return 'cancel';}
 const data=JSON.parse(job.data);
 if(job.user_id&&await out(env,job.user_id))return 'cancel';
 if(data.welcomed)for(const user of data.welcomed)if(await out(env,user))return 'cancel';
 if(job.kind==='moderation')return 'send';
 if(await setting(env,'paused')==='1')return 'wait';
 // Background jobs, including portal schedules and later game rounds, respect
 // waking hours. Explicitly requested replies retain their existing exception.
 if(!activeHours()&&(!data.requested||job.kind==='portal_post'))return 'wait';
 if(Number(await setting(env,'quiet_until')||0)>nowSeconds()&&!data.requested)return 'wait';
 if(['event_announcement','event_poll','event_reminder'].includes(job.kind)){
  const e=await env.DB.prepare('SELECT status,starts_at FROM club_events WHERE id=?').bind(data.event_id).first();if(!e||e.status==='cancelled')return 'cancel';
  if(job.kind==='event_reminder'&&(e.status!=='confirmed'||e.starts_at<=nowSeconds()))return 'cancel';
 }
 if(job.kind==='host'){
  const source=await env.DB.prepare('SELECT * FROM club_messages WHERE message_id=?').bind(data.message_id).first();if(!source||!source.recap_safe||source.kind==='resolved'||await out(env,source.user_id))return 'cancel';
  const controls=await env.DB.prepare('SELECT * FROM club_controls WHERE user_id=?').bind(source.user_id).first();if(controls?.prompts===0||controls?.last_nudge>nowSeconds()-604800)return 'cancel';
  const replies=await env.DB.prepare('SELECT 1 FROM club_messages WHERE parent_id=? AND user_id<>? LIMIT 1').bind(source.message_id,source.user_id).first();if(replies)return 'cancel';
 }
 const spontaneous=job.kind==='host'||job.kind==='briefing'&&!data.requested||job.kind==='game_start';
 if(spontaneous&&(!activeHours()||!await quiet(env,job.thread_id)))return 'wait';
 return 'send';
}
export async function handleClubJob(env,id,send){
 const job=await clubJob(env,id),allowed=await clubAllowed(env,job);
 if(allowed==='wait'){await defer(env,id);return;}
 if(allowed==='cancel'){if(job)await env.DB.prepare("UPDATE club_jobs SET state='cancelled' WHERE id=? AND state='pending'").bind(job.id).run();return;}
 const data=JSON.parse(job.data),base={chat_id:Number(env.GROUP_ID),...(job.thread_id?{message_thread_id:job.thread_id}:{})};
 let method='sendMessage',body={...base},deliveryGuard;
 if(job.kind==='briefing'){
  const briefing=await prepareBriefing(env);
  if(!briefing){await env.DB.prepare("UPDATE club_jobs SET state='skipped' WHERE id=?").bind(job.id).run();return;}
  body.text=briefing.text;
  deliveryGuard=async()=>await briefingSourcesAllowed(env,briefing.sources)?'send':'cancel';
 }
 else if(job.kind==='text')body.text=data.text;
 else if(job.kind==='host'){
  const source=await env.DB.prepare('SELECT * FROM club_messages WHERE message_id=?').bind(data.message_id).first();
  body.text=`${source.kind==='suggestion'?'This idea picked up interest. Is there a useful next step?':'This question has no recorded reply yet. Does anyone have a useful answer?'}\n${cleanAnswer(source.text,180)}\n${messageLink(env,source.message_id,source.thread_id)}\nThe author can use /prompts off to stop these follow-ups.`;
  body.reply_parameters={message_id:source.message_id,allow_sending_without_reply:true};
 }
 else if(job.kind.startsWith('event_')){
  const e=await env.DB.prepare('SELECT * FROM club_events WHERE id=?').bind(data.event_id).first();if(!e)return;
  if(job.kind==='event_poll'){
   method='sendPoll';body={...base,question:`Availability only — ${e.title} (#${e.id})`.slice(0,240),options:JSON.parse(e.date_options).map(hkTime),is_anonymous:false,open_period:600};
  }else if(job.kind==='event_announcement')body.text=`Event ${e.id}: ${e.title}\n${hkTime(e.starts_at)}\n${e.location}\nAdmin-confirmed community activity.${e.source_url?'\nSource supplied and checked by the confirming admin: '+e.source_url:''}\nRSVP: /rsvp ${e.id} yes remind (or yes silent / maybe / no). Reminders appear in this group.`;
  else {
   const people=(await env.DB.prepare("SELECT r.user_id,COALESCE(m.name,'Member') name FROM club_rsvps r LEFT JOIN members m ON m.user_id=r.user_id WHERE event_id=? AND response='yes' AND remind=1 AND NOT EXISTS(SELECT 1 FROM preferences p WHERE p.user_id=r.user_id AND p.opted_out=1) LIMIT 30").bind(e.id).all()).results;
   if(!people.length){await defer(env,id);return;}
   let text=`Opt-in reminder: ${e.title}\n${hkTime(e.starts_at)} — ${e.location}\n${messageLink(env,e.message_id,e.thread_id)}\n`,entities=[];
   for(const person of people){const name=cleanAnswer(person.name,40);entities.push({type:'text_mention',offset:text.length,length:name.length,user:{id:person.user_id,is_bot:false,first_name:name}});text+=name+' ';}
   body={...base,text,entities};
   deliveryGuard=async()=>{
    const current=(await env.DB.prepare("SELECT user_id FROM club_rsvps r WHERE event_id=? AND response='yes' AND remind=1 AND NOT EXISTS(SELECT 1 FROM preferences p WHERE p.user_id=r.user_id AND p.opted_out=1)").bind(e.id).all()).results;
    // Rebuild the body on retry if any already-rendered mention lost consent.
    return people.every(person=>current.some(r=>r.user_id===person.user_id))?'send':current.length?'wait':'cancel';
   };
  }
 }
 else if(job.kind==='moderation'){
  const review=await env.DB.prepare("SELECT * FROM club_reviews WHERE id=? AND state='approved'").bind(data.review_id).first();
  if(!review||!isAdmin(env,review.approved_by)||isAdmin(env,review.user_id)||review.user_id===Number(env.BOT_TOKEN.split(':')[0]))return;
  const res=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getChatMember`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:Number(env.GROUP_ID),user_id:review.user_id}),signal:AbortSignal.timeout(8000)});
  const member=await res.json();if(!member.ok)throw Error('cannot-verify-moderation-target');
  if(['administrator','creator'].includes(member.result.status)){await env.DB.prepare("UPDATE club_reviews SET state='protected' WHERE id=?").bind(review.id).run();await env.DB.prepare("UPDATE club_jobs SET state='cancelled' WHERE id=?").bind(job.id).run();return;}
  if(review.action==='delete'){method='deleteMessage';body={chat_id:Number(env.GROUP_ID),message_id:review.message_id};}
  else if(review.action==='mute'){method='restrictChatMember';body={chat_id:Number(env.GROUP_ID),user_id:review.user_id,permissions:{can_send_messages:false,can_send_audios:false,can_send_documents:false,can_send_photos:false,can_send_videos:false,can_send_video_notes:false,can_send_voice_notes:false,can_send_polls:false,can_send_other_messages:false,can_add_web_page_previews:false},use_independent_chat_permissions:true,until_date:nowSeconds()+3600};}
  else if(review.action==='ban'){method='banChatMember';body={chat_id:Number(env.GROUP_ID),user_id:review.user_id,revoke_messages:false};}
  else return;
 }
 else if(job.kind==='game_start'){
  await startGame(env,-id,data.kind,job.thread_id);await env.DB.prepare("UPDATE club_jobs SET state='sent' WHERE id=?").bind(job.id).run();return;
 }
 else if(job.kind==='portal_post'){
  const generated=await portalPostBody(env,job);
  if(!generated){await env.DB.prepare("UPDATE club_jobs SET state='cancelled' WHERE id=?").bind(job.id).run();return;}
  ({method,body}=generated);deliveryGuard=()=>claimPortalPost(env,job);
 }
 else if(job.kind==='game_step'||job.kind==='game_close'){
  const status=await gameDeliveryStatus(env,job);
  if(status==='wait'){await defer(env,id);return;}
  const generated=await gameBody(env,job);if(!generated){await env.DB.prepare("UPDATE club_jobs SET state='cancelled' WHERE id=?").bind(job.id).run();return;}({method,body}=generated);
  deliveryGuard=async()=>{const current=await gameDeliveryStatus(env,job);return current==='send'&&generated.deliveryGuard?generated.deliveryGuard():current;};
 }
 else return;
 const recheck=await clubAllowed(env,job);if(recheck==='wait'){await defer(env,id);return;}if(recheck==='cancel')return;
 try{await send(env,id,method,{...body,...method==='sendMessage'?{link_preview_options:{is_disabled:true}}:{}},async()=>{
  // Reload after queue writes: forget, opt-out, pause or cancellation may have
  // changed eligibility while the outgoing body was being prepared.
  const current=await clubAllowed(env,await clubJob(env,id));
  if(current!=='send')return current;
  return deliveryGuard?deliveryGuard():'send';
 });}catch(error){if(job.kind==='portal_post')await portalPostFailed(env,job,id);throw error;}
}
export async function clubDelivered(env,id,method,body,result){
 const job=await clubJob(env,id);if(!job)return;
 await env.DB.prepare("UPDATE club_jobs SET state='sent',message_id=? WHERE id=?").bind(result?.message_id||null,job.id).run();
 const data=JSON.parse(job.data);
 if(job.kind==='portal_post')await portalPostDelivered(env,job,result);
 if(job.kind==='event_poll')await env.DB.prepare('UPDATE club_events SET poll_id=?,message_id=? WHERE id=?').bind(result.poll?.id||null,result.message_id||null,data.event_id).run();
 if(job.kind==='event_announcement')await env.DB.prepare('UPDATE club_events SET message_id=? WHERE id=?').bind(result.message_id||null,data.event_id).run();
 if(job.kind==='host')await env.DB.prepare('INSERT INTO club_controls(user_id,last_nudge) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET last_nudge=excluded.last_nudge').bind(job.user_id,nowSeconds()).run();
 if(job.kind==='moderation'){
  await env.DB.prepare("UPDATE club_reviews SET state='executed' WHERE id=?").bind(data.review_id).run(); // Completion is visible in the admin portal, without group status chatter.
 }
 if(job.kind==='game_step'||job.kind==='game_close')await gameDelivered(env,job,result);
}
export async function scheduleClub(env){
 const now=nowSeconds(),day=localDay(),date=new Date((now+28800)*1000),hour=date.getUTCHours(),minute=date.getUTCMinutes();
 if(!await clubPaused(env)){
  if(hour===21&&minute<30)await queueClub(env,`daily-briefing:${day}`,'briefing',{},await topicThread(env,'general'),null,now,7200);
  const weekKind={1:'trivia',3:'character',5:'caption'}[date.getUTCDay()];
  if(weekKind&&hour===19&&minute<30)await queueClub(env,`recurring-game:${day}`,'game_start',{kind:weekKind},await topicThread(env,weekKind==='caption'?'memes':'lore'),null,now,3600);
  if(activeHours()){
   const recent=await env.DB.prepare("SELECT 1 FROM club_jobs WHERE kind='host' AND run_at>? LIMIT 1").bind(now-86400).first();
   if(!recent){
    const candidate=await env.DB.prepare(`SELECT m.* FROM club_messages m WHERE m.user_id<>0 AND m.recap_safe=1 AND m.created_at>? AND m.created_at<? AND (kind='question' OR (kind='suggestion' AND (SELECT COUNT(*) FROM club_reactions r WHERE r.message_id=m.message_id)>=2))
     AND NOT EXISTS(SELECT 1 FROM club_messages r WHERE r.parent_id=m.message_id AND r.user_id<>m.user_id)
     AND NOT EXISTS(SELECT 1 FROM club_controls c WHERE c.user_id=m.user_id AND (c.prompts=0 OR c.last_nudge>?))
     AND NOT EXISTS(SELECT 1 FROM preferences p WHERE p.user_id=m.user_id AND p.opted_out=1)
     ORDER BY m.created_at LIMIT 1`).bind(now-20*3600,now-7200,now-604800).first();
    if(candidate)await queueClub(env,`host:${candidate.message_id}`,'host',{message_id:candidate.message_id},candidate.thread_id,candidate.user_id,now,3600);
   }
  }
 }
 const events=(await env.DB.prepare("SELECT id,thread_id,starts_at FROM club_events WHERE status='confirmed' AND starts_at>? AND starts_at<=?").bind(now,now+1800).all()).results;
 for(const event of events)await queueClub(env,`reminder:${event.id}`,'event_reminder',{event_id:event.id},event.thread_id,null,now,event.starts_at-now);
 await scheduleGames(env);
 const jobs=(await env.DB.prepare("SELECT id FROM club_jobs WHERE state='pending' AND run_at<=? AND expires_at>? ORDER BY run_at LIMIT 20").bind(now,now).all()).results;
 for(const j of jobs)await env.DB.prepare('INSERT OR IGNORE INTO updates(id,payload,created_at) VALUES (?,?,?)').bind(-CLUB_OFFSET-j.id,JSON.stringify({internal_club:j.id}),now).run();
 await env.DB.batch([
  env.DB.prepare('DELETE FROM club_reactions WHERE message_id IN (SELECT message_id FROM club_messages WHERE created_at<?)').bind(now-86400),
  env.DB.prepare('DELETE FROM club_messages WHERE created_at<?').bind(now-86400),
  env.DB.prepare("UPDATE club_jobs SET state='expired',data='{}' WHERE state='pending' AND expires_at<?").bind(now),
  env.DB.prepare('DELETE FROM club_jobs WHERE expires_at<?').bind(now-7*86400),
  env.DB.prepare('DELETE FROM club_reviews WHERE created_at<?').bind(now-30*86400),
  env.DB.prepare('DELETE FROM club_date_votes WHERE event_id IN (SELECT id FROM club_events WHERE created_at<?)').bind(now-30*86400),
  env.DB.prepare('DELETE FROM club_rsvps WHERE event_id IN (SELECT id FROM club_events WHERE COALESCE(starts_at,created_at)<?)').bind(now-30*86400),
  env.DB.prepare('DELETE FROM club_events WHERE COALESCE(starts_at,created_at)<?').bind(now-30*86400),
  env.DB.prepare('DELETE FROM club_points WHERE created_at<?').bind(now-120*86400),
  ...['club_game_polls','club_game_answers','club_captions','club_caption_votes'].map(table=>env.DB.prepare(`DELETE FROM ${table} WHERE game_id IN (SELECT id FROM club_games WHERE ends_at<?)`).bind(now-30*86400)),
  env.DB.prepare('DELETE FROM club_games WHERE ends_at<?').bind(now-30*86400),
  env.DB.prepare("DELETE FROM club_memory WHERE status<>'approved' AND created_at<?").bind(now-30*86400)
 ]);
}
export async function forgetClub(env,user){
 await env.DB.prepare('DELETE FROM club_reactions WHERE message_id IN (SELECT message_id FROM club_messages WHERE user_id=?)').bind(user).run();
 for(const table of ['club_reviews','club_messages','club_reactions','club_controls','fan_interests','club_rsvps','club_date_votes','club_teams','club_points','club_game_answers','club_captions','club_caption_votes'])await env.DB.prepare(`DELETE FROM ${table} WHERE user_id=?`).bind(user).run();
 await env.DB.prepare('DELETE FROM club_caption_votes WHERE candidate=?').bind(user).run();
 // Confirmed activities are shared community records; remove the member link.
 await env.DB.prepare("UPDATE club_events SET creator=0 WHERE creator=? AND status='confirmed'").bind(user).run();
 await env.DB.prepare('UPDATE club_events SET confirmed_by=0 WHERE confirmed_by=?').bind(user).run();
 await env.DB.prepare('DELETE FROM club_rsvps WHERE event_id IN (SELECT id FROM club_events WHERE creator=?)').bind(user).run();
 await env.DB.prepare('DELETE FROM club_date_votes WHERE event_id IN (SELECT id FROM club_events WHERE creator=?)').bind(user).run();
 await env.DB.prepare('DELETE FROM club_events WHERE creator=?').bind(user).run();
 await env.DB.prepare("UPDATE club_games SET payload=json_remove(payload,'$.winner') WHERE json_extract(payload,'$.winner')=?").bind(user).run();
 await env.DB.prepare(`UPDATE club_jobs SET data=json_set(data,'$.closing_winners',
  (SELECT json_group_array(value) FROM json_each(data,'$.closing_winners') WHERE value<>?))
  WHERE kind='game_close' AND json_type(data,'$.closing_winners')='array'`).bind(user).run();
 await env.DB.prepare("UPDATE club_jobs SET state='cancelled',data='{}' WHERE user_id=? AND state='pending'").bind(user).run();
 await env.DB.prepare("UPDATE club_jobs SET state='cancelled',data='{}' WHERE EXISTS(SELECT 1 FROM json_each(data,'$.welcomed') WHERE value=?)").bind(user).run();
 await env.DB.prepare("DELETE FROM club_memory WHERE proposed_by=? AND status<>'approved'").bind(user).run();
}
