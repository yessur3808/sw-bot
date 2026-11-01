import { nowSeconds, localDay } from './engagement.mjs';
export const MAX_STARTERS = 10;
export function dayStart(now=nowSeconds()) {
  return Date.parse(`${localDay(now)}T00:00:00+08:00`)/1000;
}
// Reuse the existing expiring, erasable quota metadata; never store message text.
// One contribution per member per five-minute bucket prevents rapid-fire messages
// or repeated quiz votes from inflating interest.
export async function recordEngagement(env,user,thread,reply=false) {
  const now=nowSeconds();
  await env.DB.prepare(`INSERT OR IGNORE INTO quota(event_key,user_id,thread_id,kind,created_at)
    VALUES (?,?,?,?,?)`).bind(`engagement:${user}:${Math.floor(now/300)}`,user,thread,reply?'engagement_reply':'engagement_chat',now).run();
}
export async function postingPolicy(env) {
  const now=nowSeconds();
  const signals=await env.DB.prepare(`SELECT COUNT(DISTINCT q.user_id) participants,
    COALESCE(SUM(CASE WHEN q.kind='engagement_reply' THEN 2 ELSE 1 END),0) score
    FROM quota q WHERE q.kind IN ('engagement_reply','engagement_chat') AND q.created_at>?
    AND NOT EXISTS(SELECT 1 FROM preferences p WHERE p.user_id=q.user_id AND p.opted_out=1)`)
    .bind(now-4*3600).first();
  const polls=(await env.DB.prepare('SELECT options FROM community_polls WHERE closed=1 AND closes_at>? AND closes_at<=?').bind(now-4*3600,now).all()).results;
  const votes=polls.map(p=>JSON.parse(p.options).reduce((sum,o)=>sum+o.voter_count,0));
  const voters=Math.max(0,...votes);
  const participants=Math.max(signals.participants,voters);
  const score=signals.score+Math.min(10,votes.reduce((sum,n)=>sum+n,0));
  const target=participants>=3 && score>=20 ? 10 : participants>=2 && score>=8 ? 7 : 5;
  return {target,gap:target===10?3600:target===7?5400:7200,participants,score,window_hours:4};
}
export async function starterCount(env,excludeId=0) {
  return (await env.DB.prepare('SELECT COUNT(*) n FROM engagement_posts WHERE created_at>=? AND update_id<>?').bind(dayStart(),excludeId).first()).n;
}
export async function starterSpacingBlocked(env,id) {
  const {gap}=await postingPolicy(env);
  return Boolean(await env.DB.prepare('SELECT 1 FROM engagement_posts WHERE update_id<>? AND created_at>? LIMIT 1').bind(id,nowSeconds()-gap).first());
}
