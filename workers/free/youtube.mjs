import {assertDeployment,reserveAutomation} from './production.mjs';
import {activeHours,nowSeconds,setting,setSetting} from './engagement.mjs';
import {quiet} from './community.mjs';

export const YOUTUBE_CHANNELS=[
 {id:'UCZGYJFUizSax-yElQaFDp5Q',title:'Star Wars',url:'https://www.youtube.com/channel/UCZGYJFUizSax-yElQaFDp5Q/videos',evidence:'https://www.starwars.com/news'},
 {id:'UCOsVSkmXD1tc6uiJ2hc0wYQ',title:'EA Star Wars',url:'https://www.youtube.com/channel/UCOsVSkmXD1tc6uiJ2hc0wYQ/videos',evidence:'https://www.ea.com/games/starwars/zero-company'},
];
const MAX_VIDEO=45000000,DAY=86400,OFFSET=40000000000000;
const encoder=new TextEncoder();
const clean=value=>String(value||'').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/@[a-z0-9_]+/gi,'').replace(/\s+/g,' ').trim();
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
function fail(message,status=400){throw Object.assign(Error(message),{status});}
const channel=id=>YOUTUBE_CHANNELS.find(c=>c.id===id);
export function trailerTopic(title,description='',channelId=''){
 if(!channel(channelId))return null;
 const t=clean(title).toLowerCase(),d=clean(description).toLowerCase();
 if(!/\b(trailer|teaser)\b/.test(t)||/\b(reaction|breakdown|fan.?made|concept|recap|retrospective|tribute|anniversary|re.?release)\b/.test(t))return null;
 const game=/galactic racer|zero company|jedi:?.*(?:survivor|fallen order)|fate of the old republic|eclipse|outlaws|battlefront|squadrons|galaxy of heroes|knights of the old republic|hunters|gameplay/.test(t)||channelId===YOUTUBE_CHANNELS[1].id||/\b(?:playstation|xbox|steam|nintendo switch|video game)\b/.test(d);
 const movie=/mandalorian (?:and|&) grogu|starfighter/.test(t)||/\b(?:(?:in|to) theaters|(?:in|to) cinemas|only in theaters|feature film)\b/.test(d);
 const tv=/ahsoka|andor|skeleton crew|acolyte|bad batch|young jedi|visions|ninth jedi|maul|tales of the|book of boba fett/.test(t)||(/mandalorian/.test(t)&&!movie)||/\bseason\s+\d|\b(?:series|episodes)\b/.test(d)&&/disney\+|disney plus/.test(d);
 const topics=[game&&'gaming',movie&&'movies',tv&&'tv'].filter(Boolean);
 return topics.length===1?topics[0]:null;
}
async function authenticated(request,env){
 const token=request.headers.get('Authorization')?.replace(/^Bearer /,'')||'';
 if(!env.MEDIA_AGENT_SECRET||!/^[a-f0-9]{64}$/.test(token))return false;
 // Verify via HMAC to avoid a secret-dependent string comparison.
 const key=async s=>crypto.subtle.importKey('raw',encoder.encode(s),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
 const data=encoder.encode('sw-bot-media-auth-v1');
 return crypto.subtle.verify('HMAC',await key(env.MEDIA_AGENT_SECRET),await crypto.subtle.sign('HMAC',await key(token),data),data);
}
async function boundedJSON(request){
 if(!request.headers.get('Content-Type')?.startsWith('application/json'))fail('json_required',415);
 const reader=request.body?.getReader();if(!reader)fail('body_required');
 let text='',size=0;const decoder=new TextDecoder();
 try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>65536)fail('body_too_large',413);text+=decoder.decode(r.value,{stream:true});}text+=decoder.decode();}
 finally{await reader.cancel().catch(()=>{});}
 try{return JSON.parse(text);}catch{fail('invalid_json');}
}
async function ingest(env,data){
 if(!channel(data.channel_id)||!Array.isArray(data.items)||data.items.length>40)fail('invalid_channel_or_items');
 const now=nowSeconds(),key='youtube:channel:'+data.channel_id,previous=JSON.parse(await setting(env,key)||'null');
 if(data.status!=='ok'){
  await setSetting(env,key,JSON.stringify({...previous,lastAttempt:now,status:'error',error:['access_blocked','fetch_failed'].includes(data.error)?data.error:'fetch_failed'}));
  return {ok:true};
 }
 // Empty responses never initialise a baseline or claim successful collection.
 if(!data.items.length)fail('empty_channel',422);
 const baseline=!previous?.lastSuccess;
 for(const item of data.items){
  if(!/^[A-Za-z0-9_-]{11}$/.test(item.id)||typeof item.title!=='string'||item.title.length>500)fail('invalid_video');
  const title=clean(item.title).slice(0,240),published=Number.isSafeInteger(item.timestamp)?item.timestamp:0,duration=Math.floor(Number(item.duration)||0);
  const trailer=/\b(trailer|teaser)\b/i.test(title),topic=trailerTopic(title,String(item.description||'').slice(0,6000),data.channel_id);
  let state='skipped',reason='not_trailer';
  if(baseline)reason='initial_baseline';
  else if(trailer){
   if(item.channel_id!==data.channel_id)reason='unverified_channel';
   else if(!published||published>now||published<now-7*DAY)reason='outside_freshness_window';
   else if(duration<5||duration>600||item.is_live||item.live_status==='is_upcoming')reason='unsupported_duration_or_live';
   else if(!topic){state='review';reason='ambiguous_or_excluded_trailer';}
   else{state='pending';reason=null;}
  }
  await env.DB.prepare('INSERT OR IGNORE INTO youtube_videos(video_id,channel_id,title,topic,published_at,duration,state,reason,discovered_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(item.id,data.channel_id,title,topic,published,duration,state,reason,now).run();
 }
 await setSetting(env,key,JSON.stringify({status:'ok',lastAttempt:now,lastSuccess:now,baselineAt:previous?.baselineAt||now,count:data.items.length}));
 return {ok:true,baseline};
}
async function allowed(env,row){
 if(!row||row.state!=='pending')return {ok:false,reason:row?.state||'not_found'};
 if(row.published_at<nowSeconds()-7*DAY)return {ok:false,reason:'expired'};
 if(await setting(env,'paused')==='1'||Number(await setting(env,'quiet_until'))>nowSeconds()||!activeHours())return {ok:false,reason:'quiet_hours_or_paused'};
 if(row.ready_at>nowSeconds())return {ok:false,reason:'retry_later'};
 const mapped=await env.DB.prepare('SELECT thread_id FROM topic_map WHERE name=?').bind(row.topic).first();
 const allow=(env.ALLOWED_THREAD_IDS||'').split(',').filter(Boolean).map(Number),thread=mapped?.thread_id;
 if(!['movies','tv','gaming'].includes(row.topic)||!Number.isSafeInteger(thread)||thread<=0||allow.length&&!allow.includes(thread))return {ok:false,reason:'topic_unbound'};
 if(!await quiet(env,thread))return {ok:false,reason:'topic_busy'};
 const latest=await env.DB.prepare('SELECT MAX(attempted_at) t FROM youtube_videos WHERE id<>? AND state IN (\'sent\',\'sending\',\'uncertain\')').bind(row.id).first();
 if(latest?.t>nowSeconds()-3600)return {ok:false,reason:'trailer_spacing'};
 return {ok:true,thread};
}
export async function youtubeStatus(env){
 const channels=[];
 for(const c of YOUTUBE_CHANNELS){const state=JSON.parse(await setting(env,'youtube:channel:'+c.id)||'{"status":"not_connected"}');channels.push({...c,...state,status:state.status==='ok'&&state.lastSuccess<nowSeconds()-2700?'stale':state.status});}
 const recent=(await env.DB.prepare("SELECT video_id,title,topic,state,reason,message_id,thread_id,sent_at FROM youtube_videos WHERE state<>'skipped' ORDER BY id DESC LIMIT 20").all()).results;
 return {connected:!!env.MEDIA_AGENT_SECRET,channels,recent};
}
function multipart(request,fields,size){
 const boundary='swbot'+crypto.randomUUID();
 const prefix=encoder.encode(Object.entries(fields).map(([name,value])=>`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join('')+`--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="trailer.mp4"\r\nContent-Type: video/mp4\r\n\r\n`);
 const suffix=encoder.encode(`\r\n--${boundary}--\r\n`),reader=request.body.getReader();let started=false,bytes=0;
 const body=new ReadableStream({async pull(controller){
  try{if(!started){started=true;controller.enqueue(prefix);return;}const r=await reader.read();
   if(r.done){if(bytes!==size)throw Error('invalid_media_length');controller.enqueue(suffix);controller.close();return;}
   bytes+=r.value.length;if(bytes>size)throw Error('invalid_media_length');controller.enqueue(r.value);
  }catch(e){await reader.cancel().catch(()=>{});controller.error(e);}
 },cancel:()=>reader.cancel()});
 return {body,headers:{'Content-Type':'multipart/form-data; boundary='+boundary,'Content-Length':String(prefix.length+size+suffix.length)}};
}
async function upload(request,env,videoId){
 const size=Number(request.headers.get('Content-Length'));
 if(!Number.isSafeInteger(size)||size<1000||size>MAX_VIDEO||request.headers.get('Content-Type')!=='video/mp4'||!request.body)fail('invalid_mp4_size_or_type',413);
 let row=await env.DB.prepare('SELECT * FROM youtube_videos WHERE video_id=?').bind(videoId).first();
 let permit=await allowed(env,row);if(!permit.ok)return json(permit,409);
 if(!await reserveAutomation(env,-OFFSET-row.id))return json({ok:false,reason:'daily_budget'},409);
 // Serialise media sends across workers. A crashed sender stays ambiguous and
 // must never be retried automatically; operator inspection is required.
 await env.DB.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES ('youtube:send_lock','0')").run();
 const claim=await env.DB.prepare("UPDATE settings SET value=? WHERE key='youtube:send_lock' AND CAST(value AS INTEGER)<?").bind(String(nowSeconds()+180),nowSeconds()).run();
 if(!claim.meta.changes)return json({ok:false,reason:'busy'},409);
 try{
  row=await env.DB.prepare('SELECT * FROM youtube_videos WHERE video_id=?').bind(videoId).first();
  permit=await allowed(env,row);if(!permit.ok)return json(permit,409);
  const claimRow=await env.DB.prepare("UPDATE youtube_videos SET state='sending',attempted_at=?,thread_id=?,reason=NULL WHERE id=? AND state='pending'").bind(nowSeconds(),permit.thread,row.id).run();
  if(!claimRow.meta.changes)return json({ok:false,reason:'already_claimed'},409);
  // Re-read pause, identity, topic and time immediately before calling Telegram.
  await assertDeployment(env);
  const final=await allowed(env,{...row,state:'pending'});
  if(!final.ok||final.thread!==permit.thread||!activeHours()){
   await env.DB.prepare("UPDATE youtube_videos SET state='pending',reason='delivery_deferred' WHERE id=?").bind(row.id).run();return json({ok:false,reason:'delivery_deferred'},409);
  }
  const caption=`${row.title}\n\nOfficial ${channel(row.channel_id).title} trailer · may contain spoilers.\nhttps://www.youtube.com/watch?v=${row.video_id}`;
  const form=multipart(request,{chat_id:env.GROUP_ID,message_thread_id:permit.thread,caption,supports_streaming:true,has_spoiler:true},size);
  let result;
  try{
   const response=await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendVideo`,{method:'POST',...form,duplex:'half',signal:AbortSignal.timeout(120000)});
   result=await response.json();
  }catch{
   await env.DB.prepare("UPDATE youtube_videos SET state='uncertain',reason='telegram_delivery_uncertain' WHERE id=?").bind(row.id).run();return json({ok:false,reason:'uncertain'},202);
  }
  if(!result.ok){
   const retry=result.error_code===429,definite=Number.isInteger(result.error_code)&&result.error_code>=400&&result.error_code<500;
   await env.DB.prepare('UPDATE youtube_videos SET state=?,reason=?,ready_at=? WHERE id=?').bind(retry?'pending':definite?'failed':'uncertain',retry?'telegram_rate_limit':definite?'telegram_rejected':'telegram_delivery_uncertain',nowSeconds()+Math.max(60,Number(result.parameters?.retry_after)||60),row.id).run();
   return json({ok:false,reason:retry?'retry_later':definite?'telegram_rejected':'uncertain',error_code:result.error_code,detail:clean(result.description).replaceAll(env.BOT_TOKEN,'[redacted]').slice(0,180)},retry?429:202);
  }
  await env.DB.prepare("UPDATE youtube_videos SET state='sent',message_id=?,sent_at=?,reason=NULL WHERE id=?").bind(result.result.message_id,nowSeconds(),row.id).run();
  return json({ok:true,message_id:result.result.message_id,thread_id:permit.thread});
 }finally{await env.DB.prepare("UPDATE settings SET value='0' WHERE key='youtube:send_lock'").run();}
}
export async function mediaFetch(request,env){
 try{
  if(!await authenticated(request,env))return json({error:'unauthorized'},401);
  await assertDeployment(env);
  const path=new URL(request.url).pathname;
  if(path==='/media/monitor'&&request.method==='GET'){
   await env.DB.prepare("UPDATE youtube_videos SET state='uncertain',reason='send_interrupted' WHERE state='sending' AND attempted_at<?").bind(nowSeconds()-300).run();
   await env.DB.prepare("UPDATE youtube_videos SET state='skipped',reason='expired' WHERE state='pending' AND published_at<?").bind(nowSeconds()-7*DAY).run();
   const channels=[];for(const c of YOUTUBE_CHANNELS){const known=(await env.DB.prepare('SELECT video_id FROM youtube_videos WHERE channel_id=? ORDER BY id DESC LIMIT 200').bind(c.id).all()).results;channels.push({...c,known:known.map(r=>r.video_id)});}
   const pending=(await env.DB.prepare("SELECT * FROM youtube_videos WHERE state='pending' ORDER BY id LIMIT 20").all()).results;
   const jobs=[];for(const row of pending){const p=await allowed(env,row);if(p.ok){jobs.push({video_id:row.video_id,channel_id:row.channel_id,topic:row.topic});break;}}
   return json({channels,jobs});
  }
  if(path==='/media/scan'&&request.method==='POST')return json(await ingest(env,await boundedJSON(request)));
  const uploadPath=path.match(/^\/media\/upload\/([A-Za-z0-9_-]{11})$/);
  if(uploadPath&&request.method==='POST')return await upload(request,env,uploadPath[1]);
  if(path==='/media/failure'&&request.method==='POST'){
   const data=await boundedJSON(request),reason=['access_blocked','download_failed','invalid_media','too_large'].includes(data.reason)?data.reason:'download_failed';
   await env.DB.prepare("UPDATE youtube_videos SET state='failed',reason=? WHERE video_id=? AND state='pending'").bind(reason,String(data.video_id)).run();return json({ok:true});
  }
  return json({error:'not_found'},404);
 }catch(e){return json({error:e.status?e.message:'media_request_failed'},e.status||500);}
}
