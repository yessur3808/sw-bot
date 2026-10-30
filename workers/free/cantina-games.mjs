import {nowSeconds,localDay,cleanAnswer} from './engagement.mjs';
import {topicThread,POLL_ANSWER_SECONDS} from './community.mjs';
import {queueClub,clubQuota,out,messageLink,hkTime} from './cantina-core.mjs';
const TRIVIA=[
 {question:'Which planet is the Wookiee homeworld?',options:['Kashyyyk','Corellia','Naboo','Hoth'],correct:0},
 {question:'What colour is Mace Windu’s lightsaber?',options:['Green','Blue','Purple','Yellow'],correct:2},
 {question:'What is Han Solo’s best-known ship?',options:['Ghost','Millennium Falcon','Razor Crest','Tantive IV'],correct:1},
 {question:'Who trained Obi-Wan Kenobi as a Padawan?',options:['Yoda','Mace Windu','Qui-Gon Jinn','Ki-Adi-Mundi'],correct:2},
 {question:'Who built C-3PO?',options:['Han Solo','Anakin Skywalker','Obi-Wan Kenobi','Luke Skywalker'],correct:1},
 {question:'In canon, what rank does Thrawn hold in the Empire?',options:['Moff','Grand Admiral','Commander','General'],correct:1}
];
const CHARACTERS=[
 {answer:'r2d2',display:'R2-D2',clues:['I am built for practical work, not polite conversation.','My paint scheme includes blue and white.','I am an astromech who often travels with C-3PO.']},
 {answer:'yoda',display:'Yoda',clues:['Judge me by my size, you should not.','A small green Jedi Master, I am.','On Dagobah, Luke trains with me.']},
 {answer:'chewbacca',display:'Chewbacca',aliases:['chewie'],clues:['Many cockpits feel a little cramped to me.','A bowcaster is my weapon of choice.','I am Han Solo’s Wookiee co-pilot.']}
];
const CAPTIONS=['A stormtrooper asks IT why the login button keeps moving.','A droid discovers the cantina has a no-charging policy.','A Jedi opens the bill after saying credits are no object.'];
const norm=s=>String(s).toLowerCase().replace(/[^a-z0-9]/g,'');
const gameTitle=kind=>({character:'🧩 Who am I?',trivia:'🎲 Cantina trivia',caption:'✍️ Caption challenge'})[kind];
const displayName=(name,fallback='Player')=>cleanAnswer(name||fallback,40).replace(/\s+/g,' ');
async function currentGame(env,m,kind){
 const thread=m.chat.type==='private'?await topicThread(env,kind==='caption'?'memes':'lore'):m.message_thread_id||0;
 const reply=m.reply_to_message?.message_id;
 if(reply){const found=await env.DB.prepare(`SELECT g.* FROM club_games g WHERE g.state='open' AND g.ends_at>? AND (? IS NULL OR g.kind=?)
  AND (g.message_id=? OR EXISTS(SELECT 1 FROM club_jobs j WHERE j.message_id=? AND json_extract(j.data,'$.game_id')=g.id)) LIMIT 1`)
  .bind(nowSeconds(),kind,kind,reply,reply).first();if(found)return found;}
 return env.DB.prepare("SELECT * FROM club_games WHERE state='open' AND ends_at>? AND thread_id=? AND (? IS NULL OR kind=?) ORDER BY opened_at DESC,id DESC LIMIT 1").bind(nowSeconds(),thread,kind,kind).first();
}
export const season=()=>localDay().slice(0,7);
export async function gamePoints(env,key,user,points,kind){
 if(await out(env,user))return;
 const team=(await env.DB.prepare('SELECT team FROM club_teams WHERE user_id=?').bind(user).first())?.team||null,n=nowSeconds();
 await env.DB.prepare(`INSERT OR IGNORE INTO club_points(event_key,user_id,team,points,kind,season,created_at)
 SELECT ?,?,?,?,?,?,? WHERE (SELECT COALESCE(SUM(points),0) FROM club_points WHERE user_id=? AND created_at>?) + ? <=20`).bind(key,user,team,points,kind,season(),n,user,n-86400,points).run();
}
export async function startGame(env,id,kind,thread,user=null){
 if(!['trivia','character','caption'].includes(kind))return;
 const n=nowSeconds(),payload=kind==='character'?CHARACTERS[Math.abs(id)%CHARACTERS.length]:kind==='caption'?{prompt:CAPTIONS[Math.abs(id)%CAPTIONS.length]}:{questions:Array.from({length:3},(_,i)=>TRIVIA[(Math.floor(n/604800)+i)%TRIVIA.length])};
 await env.DB.prepare('INSERT OR IGNORE INTO club_games(id,kind,thread_id,opened_at,ends_at,payload,step) VALUES (?,?,?,?,?,?,-1)').bind(id,kind,thread,n,n+3600,JSON.stringify(payload)).run();
 await queueClub(env,`game:${id}:0`,'game_step',{game_id:id,step:0,requested:Boolean(user)},thread,user,n,3600);
}
export async function gameCommand(env,u,cmd,say){
 const m=u.message,id=u.update_id,user=m.from.id,name=cmd?.name,arg=cmd?.arg||'';
 if(!['game','answer','caption','vote','team','season'].includes(name))return false;
 const respond=t=>say(env,id,m,t);
 if(name==='team'){
  if(!['rebels','empire','scoundrels','off'].includes(arg)){await respond('Choose /team rebels, empire or scoundrels to opt into team scoring. /team off removes membership; existing earned points keep their original team.');return true;}
  if(arg==='off')await env.DB.prepare('DELETE FROM club_teams WHERE user_id=?').bind(user).run();else await env.DB.prepare('INSERT INTO club_teams VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET team=excluded.team').bind(user,arg).run();await respond(arg==='off'?'Team membership removed.':`Team ${arg} selected for future points.`);return true;
 }
 if(name==='season'){
  const teams=(await env.DB.prepare('SELECT COALESCE(team,\'unassigned\') team,SUM(points) points FROM club_points WHERE season=? GROUP BY team ORDER BY points DESC').bind(season()).all()).results;
  const people=(await env.DB.prepare('SELECT p.user_id,COALESCE(m.name,\'Member\') name,SUM(p.points) points FROM club_points p LEFT JOIN members m ON m.user_id=p.user_id WHERE season=? GROUP BY p.user_id ORDER BY points DESC LIMIT 10').bind(season()).all()).results;
  await respond(`Season ${season()} (Hong Kong calendar month)\nTeams: ${teams.map(t=>t.team+' '+t.points).join(', ')||'no scores yet'}\n${people.map((p,i)=>`${i+1}. ${p.name}: ${p.points}`).join('\n')}\nPoints come from games and peer votes, not message volume.`);return true;
 }
 if(name==='game'){
  const [kind,key]=arg.split(/\s+/);
  if(kind==='show'){
   const game=key?await env.DB.prepare('SELECT * FROM club_games WHERE id=?').bind(Number(key)||0).first():await currentGame(env,m,null);if(!game){await respond('There is no active game in this topic. Try /game character, /game trivia or /game caption.');return true;}
   const entries=(await env.DB.prepare(`SELECT c.rowid entry,c.text,(SELECT COUNT(*) FROM club_caption_votes v WHERE v.game_id=c.game_id AND v.candidate=c.user_id AND NOT EXISTS(SELECT 1 FROM preferences p WHERE p.user_id=v.user_id AND p.opted_out=1)) votes
    FROM club_captions c WHERE game_id=? AND NOT EXISTS(SELECT 1 FROM preferences p WHERE p.user_id=c.user_id AND p.opted_out=1) ORDER BY c.rowid LIMIT 12`).bind(game.id).all()).results;
   await respond(`${gameTitle(game.kind)}\n${game.state==='open'?'Closes':'Closed'} ${hkTime(game.ends_at)}\n\n${entries.map(e=>`#${e.entry} · ${e.text}\n${e.votes} vote(s)`).join('\n\n')}${entries.length?'\n\n':''}${messageLink(env,game.message_id,game.thread_id)}${game.kind==='caption'?'\n\nVote with /vote followed by an entry number.':''}`);return true;
  }
  if(!['trivia','character','caption'].includes(kind)){await respond('Play /game trivia, /game character or /game caption. /game show displays the active game here. /team chooses a team; /season shows scores.');return true;}
  if(!await clubQuota(env,user,'club-game',2)){await respond('Game creation limit reached today.');return true;}
  const open=await env.DB.prepare("SELECT id FROM club_games WHERE state='open' AND kind=? AND ends_at>? LIMIT 1").bind(kind,nowSeconds()).first();if(open){await respond('A round is already running. Open its topic and use /game show.');return true;}
  await startGame(env,id,kind,await topicThread(env,kind==='caption'?'memes':'lore'),user);return true; // The game itself is the group announcement; no queue-status chatter.
 }
 let rest=arg.trim().split(/\s+/),game=null,legacy=false;
 if(rest.length>1&&/^\d+$/.test(rest[0])){game=await env.DB.prepare("SELECT * FROM club_games WHERE id=? AND state='open' AND ends_at>?").bind(Number(rest[0]),nowSeconds()).first();if(game){legacy=true;rest.shift();}}
 if(!game)game=await currentGame(env,m,name==='answer'?'character':'caption');
 if(!game){await respond('There is no active round for that command in this topic. Reply to a game post, or start one with /game character or /game caption.');return true;}
 if(name==='answer'){
  if(game.kind!=='character'){await respond('Use /answer only for a character-clue game.');return true;}
  const payload=JSON.parse(game.payload),answer=norm(rest.join(' '));if(![payload.answer,...payload.aliases||[]].includes(answer)){await respond('Not the character I have in mind. Another clue will follow if the game stays unsolved.');return true;}
  const claimed=await env.DB.prepare("UPDATE club_games SET state='solved',payload=? WHERE id=? AND state='open'").bind(JSON.stringify({...payload,winner:user}),game.id).run();
  if(claimed.meta.changes){await gamePoints(env,`character:${game.id}`,user,5,'character');await respond(`Correct: ${payload.display}! You earned five seasonal points.`);}else await respond('Another player already solved this round.');return true;
 }
 if(game.kind!=='caption'){await respond('This command is for caption contests.');return true;}
 if(name==='caption'){
  const text=rest.join(' ').trim();if(text.length<5||text.length>240){await respond('Send /caption followed by your original line (5–240 characters).');return true;}
  const inserted=await env.DB.prepare('INSERT OR IGNORE INTO club_captions SELECT ?,?,? WHERE (SELECT COUNT(*) FROM club_captions WHERE game_id=?)<12').bind(game.id,user,text,game.id).run();if(inserted.meta.changes)await gamePoints(env,`caption-entry:${game.id}:${user}`,user,1,'creative-entry');const entry=await env.DB.prepare('SELECT rowid entry FROM club_captions WHERE game_id=? AND user_id=?').bind(game.id,user).first();await respond(inserted.meta.changes?`Your caption is entry #${entry.entry}. Use /game show to see the entries and vote.`:'One entry per person; this contest accepts up to 12 entries.');return true;
 }
 if(name==='vote'){
  const entry=await env.DB.prepare(`SELECT user_id FROM club_captions WHERE game_id=? AND ${legacy?'user_id':'rowid'}=? AND NOT EXISTS(SELECT 1 FROM preferences p WHERE p.user_id=club_captions.user_id AND p.opted_out=1)`).bind(game.id,Number(rest[0])||0).first(),candidate=entry?.user_id;
  if(!entry||candidate===user){await respond('Choose another member’s entry from /game show.');return true;}
  const inserted=await env.DB.prepare('INSERT OR IGNORE INTO club_caption_votes VALUES (?,?,?)').bind(game.id,user,candidate).run();if(inserted.meta.changes)await gamePoints(env,`caption-vote:${game.id}:${user}`,candidate,1,'peer-vote');await respond(inserted.meta.changes?'Vote recorded. One vote per person per contest.':'You already voted in this contest.');return true;
 }
 return false;
}
export async function gameVote(env,a){
 const round=await env.DB.prepare('SELECT * FROM club_game_polls WHERE poll_id=? AND expires_at>=?').bind(a.poll_id,nowSeconds()).first();if(!round)return false;
 if(!a.user||a.user.is_bot||a.option_ids.length!==1||!Number.isInteger(a.option_ids[0])||a.option_ids[0]<0||a.option_ids[0]>3||await out(env,a.user.id))return true;
 const correct=a.option_ids[0]===round.correct?1:0;
 const inserted=await env.DB.prepare('INSERT OR IGNORE INTO club_game_answers VALUES (?,?,?,?)').bind(round.game_id,round.round,a.user.id,correct).run();
 if(inserted.meta.changes)await gamePoints(env,`trivia:${round.game_id}:${round.round}:${a.user.id}`,a.user.id,correct?3:1,'team-trivia');return true;
}
export const gameInterval=kind=>kind==='trivia'?POLL_ANSWER_SECONDS+30:300;
async function closingScores(env,game){
 if(game.kind==='trivia')return (await env.DB.prepare(`SELECT a.user_id,COALESCE(m.name,'Player') name,SUM(CASE WHEN correct=1 THEN 3 ELSE 1 END) points FROM club_game_answers a LEFT JOIN members m ON m.user_id=a.user_id
  WHERE game_id=? AND NOT EXISTS(SELECT 1 FROM preferences p WHERE p.user_id=a.user_id AND p.opted_out=1)
  GROUP BY a.user_id ORDER BY points DESC,a.user_id LIMIT 5`).bind(game.id).all()).results;
 if(game.kind==='caption')return (await env.DB.prepare(`SELECT v.candidate,c.rowid entry,COUNT(*) n FROM club_caption_votes v JOIN club_captions c ON c.game_id=v.game_id AND c.user_id=v.candidate WHERE v.game_id=?
  AND NOT EXISTS(SELECT 1 FROM preferences p WHERE p.opted_out=1 AND p.user_id IN (v.user_id,v.candidate))
  GROUP BY candidate ORDER BY n DESC,candidate`).bind(game.id).all()).results;
 return [];
}
export async function gameDeliveryStatus(env,job){
 const {game_id,step}=JSON.parse(job.data);
 const game=await env.DB.prepare('SELECT * FROM club_games WHERE id=?').bind(game_id).first();
 if(!game||game.state!=='open')return 'cancel';
 if(job.kind==='game_close')return !game.message_id?'cancel':game.ends_at>nowSeconds()?'wait':'send';
 if(!Number.isInteger(step)||step<0||step>(game.kind==='caption'?0:2)||step<=game.step||nowSeconds()>=game.ends_at)return 'cancel';
 if(step>game.step+1)return 'wait'; // Hold legacy/future jobs until their predecessor is delivered.
 if(game.last_step_at!==null&&nowSeconds()<game.last_step_at+gameInterval(game.kind))return 'wait';
 return 'send';
}
export async function gameBody(env,job){
 if(await gameDeliveryStatus(env,job)!=='send')return null;
 const {game_id,step}=JSON.parse(job.data),game=await env.DB.prepare('SELECT * FROM club_games WHERE id=?').bind(game_id).first();if(!game||game.state!=='open')return null;
 const payload=JSON.parse(game.payload),base={chat_id:Number(env.GROUP_ID),...(game.thread_id?{message_thread_id:game.thread_id}:{})};
 if(job.kind==='game_close'){
  let result='';const scores=await closingScores(env,game),snapshot=JSON.stringify(scores);
  if(game.kind==='character')result=`The character was ${payload.display}. No correct guess was recorded this round.`;
  if(game.kind==='trivia'){
   result=scores.length?'Round scores\n'+scores.map((x,i)=>`${i+1}. ${displayName(x.name)} · ${x.points} points`).join('\n'):'No answers this round. The next quiz is a fresh chance.';
  }
  if(game.kind==='caption'){
   const votes=scores;
   const winners=votes.filter(v=>v.n===votes[0]?.n);
   result=winners.length?'Community vote winner'+(winners.length>1?'s (tie)':'')+': '+winners.map(w=>`entry #${w.entry} (${w.n} votes)`).join(', ')+'. Five bonus points each.':'No votes recorded; no winner was invented.';
  }
  return {method:'sendMessage',body:{...base,text:`${gameTitle(game.kind)} — finished\n\n${result}\n\nSee the monthly leaderboard with /season.`},
   deliveryGuard:async()=>{
    if(JSON.stringify(await closingScores(env,game))!==snapshot)return 'wait';
    if(game.kind==='caption'){
     const winners=scores.filter(v=>v.n===scores[0]?.n).map(v=>v.candidate);
     const saved=await env.DB.prepare("UPDATE club_jobs SET data=json_set(data,'$.closing_winners',json(?)) WHERE id=? AND state='pending'").bind(JSON.stringify(winners),job.id).run();
     if(!saved.meta.changes)return 'cancel';
     if(JSON.stringify(await closingScores(env,game))!==snapshot)return 'wait';
    }
    return 'send';
   }};
 }
 if(game.kind==='trivia'){
  const q=payload.questions[step];if(!q)return null;
  return {method:'sendPoll',body:{...base,question:`Cantina trivia · Round ${step+1} of 3\n${q.question}`,options:q.options,type:'quiz',correct_option_id:q.correct,is_anonymous:false,open_period:POLL_ANSWER_SECONDS,explanation:`Answer: ${q.options[q.correct]}. First answer counts; /team chooses your team.`}};
 }
 if(game.kind==='character')return {method:'sendMessage',body:{...base,text:`🧩 Who am I?\nClue ${step+1} of 3\n\n${payload.clues[step]}\n\nSend /answer followed by your guess.\nFirst correct guess earns 5 points.`}};
 return {method:'sendMessage',body:{...base,text:`✍️ Caption challenge\n\n${payload.prompt}\n\nAdd yours with /caption followed by your line.\nSee entries and vote: /game show\n\nCloses ${hkTime(nowSeconds()+86400)}.`}};
}
export async function gameDelivered(env,job,result){
 const {game_id,step}=JSON.parse(job.data),game=await env.DB.prepare('SELECT * FROM club_games WHERE id=?').bind(game_id).first();if(!game)return;
 if(job.kind==='game_close'){
  if(game.kind==='caption')for(const user of JSON.parse(job.data).closing_winners||[])await gamePoints(env,`caption-win:${game.id}:${user}`,user,5,'caption-winner');
  await env.DB.prepare("UPDATE club_games SET state='closed' WHERE id=? AND state='open'").bind(game.id).run();return;
 }
 // Only a confirmed, sequential delivery advances the game or its clocks.
 // Leave unfinished trivia rounds time to resume after overnight quiet hours.
 const closes=result.poll?.close_date||nowSeconds()+POLL_ANSWER_SECONDS;
 const remaining=game.kind==='caption'?86400:game.kind==='character'?(3-step)*300:step<2?86400:closes-nowSeconds()+60;
 const advanced=await env.DB.prepare(`UPDATE club_games SET step=?,message_id=COALESCE(message_id,?),last_step_at=?,
 opened_at=CASE WHEN step=-1 THEN ? ELSE opened_at END,ends_at=? WHERE id=? AND state='open' AND step=?`)
 .bind(step,result.message_id||null,nowSeconds(),nowSeconds(),nowSeconds()+remaining,game.id,step-1).run();
 if(!advanced.meta.changes)return;
 if(game.kind==='trivia'&&result.poll?.id){const q=JSON.parse(game.payload).questions[step];await env.DB.prepare('INSERT OR IGNORE INTO club_game_polls VALUES (?,?,?,?,?)').bind(result.poll.id,game.id,step,q.correct,closes+5).run();}
}
export async function scheduleGames(env){
 const games=(await env.DB.prepare("SELECT * FROM club_games WHERE state='open'").all()).results;
 for(const g of games){
  // A confirmed delivery is durable even if scoring/closing failed afterward.
  const deliveredClose=await env.DB.prepare("SELECT * FROM club_jobs WHERE job_key=? AND state='sent'").bind(`game:${g.id}:close`).first();
  if(deliveredClose){await gameDelivered(env,deliveredClose,{});continue;}
  if(g.ends_at<nowSeconds()-(g.kind==='trivia'?12*3600:3600)){await env.DB.prepare("UPDATE club_games SET state='expired' WHERE id=? AND state='open'").bind(g.id).run();continue;}
  if(g.ends_at<=nowSeconds()&&!g.message_id){await env.DB.prepare("UPDATE club_games SET state='expired' WHERE id=? AND state='open'").bind(g.id).run();continue;}
  if(g.ends_at<=nowSeconds()){await queueClub(env,`game:${g.id}:close`,'game_close',{game_id:g.id},g.thread_id,null,nowSeconds(),g.kind==='trivia'?12*3600:3600);continue;}
  if(g.kind==='caption'||g.step<0||g.step>=2||g.last_step_at===null||nowSeconds()<g.last_step_at+gameInterval(g.kind))continue;
  const step=g.step+1;
  await queueClub(env,`game:${g.id}:${step}`,'game_step',{game_id:g.id,step},g.thread_id,null,nowSeconds(),g.kind==='trivia'?12*3600:1800);
 }
}
