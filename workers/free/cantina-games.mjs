import {nowSeconds,localDay} from './engagement.mjs';
import {topicThread} from './community.mjs';
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
 await env.DB.prepare('INSERT OR IGNORE INTO club_games(id,kind,thread_id,opened_at,ends_at,payload) VALUES (?,?,?,?,?,?)').bind(id,kind,thread,n,n+(kind==='caption'?86400:kind==='character'?900:480),JSON.stringify(payload)).run();
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
   const game=await env.DB.prepare('SELECT * FROM club_games WHERE id=?').bind(Number(key)||0).first();if(!game){await respond('Game not found.');return true;}
   const entries=(await env.DB.prepare('SELECT c.user_id,c.text,(SELECT COUNT(*) FROM club_caption_votes v WHERE v.game_id=c.game_id AND v.candidate=c.user_id) votes FROM club_captions c WHERE game_id=? ORDER BY votes DESC LIMIT 12').bind(game.id).all()).results;
   await respond(`Game ${game.id}: ${game.kind} (${game.state}); ends ${hkTime(game.ends_at)}\n${messageLink(env,game.message_id,game.thread_id)}\n${entries.map(e=>`${e.user_id}: ${e.text} (${e.votes} votes)`).join('\n')}\n${game.kind==='caption'?`Vote: /vote ${game.id} <entry number>`:''}`);return true;
  }
  if(!['trivia','character','caption'].includes(kind)){await respond('Play /game trivia, /game character or /game caption. /game show ID displays an active game. /team chooses a team; /season shows scores.');return true;}
  if(!await clubQuota(env,user,'club-game',2)){await respond('Game creation limit reached today.');return true;}
  const open=await env.DB.prepare("SELECT id FROM club_games WHERE state='open' AND kind=? AND ends_at>? LIMIT 1").bind(kind,nowSeconds()).first();if(open){await respond(`There is already an open ${kind} game: /game show ${open.id}.`);return true;}
  await startGame(env,id,kind,await topicThread(env,kind==='caption'?'memes':'lore'),user);await respond(`Game ${id} queued. Use /team rebels|empire|scoundrels to join a team; participation and correct answers earn seasonal points.`);return true;
 }
 const [key,...rest]=arg.split(' '),game=await env.DB.prepare("SELECT * FROM club_games WHERE id=? AND state='open' AND ends_at>?").bind(Number(key)||0,nowSeconds()).first();
 if(!game){await respond('No open game with that ID.');return true;}
 if(name==='answer'){
  if(game.kind!=='character'){await respond('Use /answer only for a character-clue game.');return true;}
  const payload=JSON.parse(game.payload),answer=norm(rest.join(' '));if(![payload.answer,...payload.aliases||[]].includes(answer)){await respond('Not the character I have in mind. Another clue will follow if the game stays unsolved.');return true;}
  const claimed=await env.DB.prepare("UPDATE club_games SET state='solved',payload=? WHERE id=? AND state='open'").bind(JSON.stringify({...payload,winner:user}),game.id).run();
  if(claimed.meta.changes){await gamePoints(env,`character:${game.id}`,user,5,'character');await respond(`Correct: ${payload.display}! You earned five seasonal points.`);}else await respond('Another player already solved this round.');return true;
 }
 if(game.kind!=='caption'){await respond('This command is for caption contests.');return true;}
 if(name==='caption'){
  const text=rest.join(' ').trim();if(text.length<5||text.length>240){await respond('Submit one original caption, 5–240 characters: /caption ID your caption.');return true;}
  const inserted=await env.DB.prepare('INSERT OR IGNORE INTO club_captions SELECT ?,?,? WHERE (SELECT COUNT(*) FROM club_captions WHERE game_id=?)<12').bind(game.id,user,text,game.id).run();if(inserted.meta.changes)await gamePoints(env,`caption-entry:${game.id}:${user}`,user,1,'creative-entry');await respond(inserted.meta.changes?`Caption submitted. Your entry number is ${user}. /game show ${game.id} lists entries for voting.`:'One entry per person; this contest accepts up to 12 entries.');return true;
 }
 if(name==='vote'){
  const candidate=Number(rest[0]);const entry=await env.DB.prepare('SELECT 1 FROM club_captions WHERE game_id=? AND user_id=?').bind(game.id,candidate||0).first();
  if(!entry||candidate===user){await respond('Choose another member’s entry from /game show ID.');return true;}
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
export async function gameBody(env,job){
 const {game_id,step}=JSON.parse(job.data),game=await env.DB.prepare('SELECT * FROM club_games WHERE id=?').bind(game_id).first();if(!game||game.state!=='open')return null;
 const payload=JSON.parse(game.payload),base={chat_id:Number(env.GROUP_ID),...(game.thread_id?{message_thread_id:game.thread_id}:{})};
 if(job.kind==='game_close'){
  let result='';
  if(game.kind==='character')result=`The character was ${payload.display}. No correct guess was recorded this round.`;
  if(game.kind==='trivia'){
   const scores=(await env.DB.prepare('SELECT user_id,SUM(CASE WHEN correct=1 THEN 3 ELSE 1 END) points FROM club_game_answers WHERE game_id=? GROUP BY user_id ORDER BY points DESC LIMIT 5').bind(game.id).all()).results;
   result=scores.length?'Round scores: '+scores.map(x=>`player ${x.user_id}: ${x.points}`).join('; '):'No answers recorded this round.';
  }
  if(game.kind==='caption'){
   const votes=(await env.DB.prepare('SELECT candidate,COUNT(*) n FROM club_caption_votes WHERE game_id=? GROUP BY candidate ORDER BY n DESC').bind(game.id).all()).results;
   const winners=votes.filter(v=>v.n===votes[0]?.n);
   for(const w of winners)await gamePoints(env,`caption-win:${game.id}:${w.candidate}`,w.candidate,5,'caption-winner');
   result=winners.length?'Community vote winner'+(winners.length>1?'s (tie)':'')+': '+winners.map(w=>`entry ${w.candidate} (${w.n} votes)`).join(', ')+'. Five bonus points each.':'No votes recorded; no winner was invented.';
  }
  return {method:'sendMessage',body:{...base,text:`Game ${game.id} finished. ${result}\n/season shows the monthly leaderboard.`}};
 }
 if(game.kind==='trivia'){
  const q=payload.questions[step];if(!q)return null;
  return {method:'sendPoll',body:{...base,question:`Team trivia ${game.id}, round ${step+1}/3: ${q.question}`,options:q.options,type:'quiz',correct_option_id:q.correct,is_anonymous:false,open_period:120,explanation:`Answer: ${q.options[q.correct]}. First answer counts; /team chooses your team.`}};
 }
 if(game.kind==='character')return {method:'sendMessage',body:{...base,text:`Character game ${game.id} — clue ${step+1}/3\n${payload.clues[step]}\nGuess with /answer ${game.id} <character>. First correct answer earns five points.`}};
 return {method:'sendMessage',body:{...base,text:`Caption contest ${game.id}\n${payload.prompt}\nOne original entry: /caption ${game.id} <caption>\nRead and vote: /game show ${game.id}\nEnds ${hkTime(game.ends_at)}. Peer votes and creativity earn seasonal points.`}};
}
export async function gameDelivered(env,job,result){
 const {game_id,step}=JSON.parse(job.data),game=await env.DB.prepare('SELECT * FROM club_games WHERE id=?').bind(game_id).first();if(!game)return;
 if(job.kind==='game_close'){await env.DB.prepare("UPDATE club_games SET state='closed' WHERE id=? AND state='open'").bind(game.id).run();return;}
 await env.DB.prepare('UPDATE club_games SET step=?,message_id=COALESCE(message_id,?) WHERE id=?').bind(step,result.message_id||null,game.id).run();
 if(game.kind==='trivia'&&result.poll?.id){const q=JSON.parse(game.payload).questions[step];await env.DB.prepare('INSERT OR IGNORE INTO club_game_polls VALUES (?,?,?,?,?)').bind(result.poll.id,game.id,step,q.correct,nowSeconds()+125).run();}
}
export async function scheduleGames(env){
 const games=(await env.DB.prepare("SELECT * FROM club_games WHERE state='open'").all()).results;
 for(const g of games){
  if(g.ends_at<nowSeconds()-3600){await env.DB.prepare("UPDATE club_games SET state='expired' WHERE id=? AND state='open'").bind(g.id).run();continue;}
  if(g.ends_at<=nowSeconds()){await queueClub(env,`game:${g.id}:close`,'game_close',{game_id:g.id},g.thread_id,null,nowSeconds(),3600);continue;}
  if(g.kind==='caption')continue;
  const step=Math.min(2,Math.floor((nowSeconds()-g.opened_at)/(g.kind==='trivia'?150:300)));
  if(step>g.step)await queueClub(env,`game:${g.id}:${step}`,'game_step',{game_id:g.id,step},g.thread_id,null,nowSeconds(),1800);
 }
}
