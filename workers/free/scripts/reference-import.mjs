import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const categories=new Set(['lore_fact','movie_fact','tv_series_fact','legends_lore_fact','game_fact','comic_series_fact']);
const validText=(s,max)=>typeof s==='string'&&s.trim().length>0&&s.length<=max;
export function referenceRows(entries){
 if(!Array.isArray(entries)||!entries.length||entries.length>100)throw Error('Supply 1–100 reference entries.');
 const seen=new Set();
 return entries.map(e=>{
  if(!categories.has(e.category)||!validText(e.text,600)||!validText(e.source?.title,160)||!validText(e.source?.type,40)||
     !Array.isArray(e.topics)||!e.topics.length||e.topics.length>10||e.topics.some(t=>!validText(t,60)))throw Error('Invalid reference entry.');
  const title=`${e.source.title} · ${e.topics[0]}`.slice(0,100);
  const body=[e.text,'',`Source: ${e.source.title}`,`Source type: ${e.source.type}`,`Category: ${e.category}`,`Topics: ${e.topics.join(', ')}`,'',
   'User-supplied reference; not independently fact-checked. Includes interpretation and may contain plot spoilers.'].join('\n');
  if(body.length>1200)throw Error('Reference body exceeds the knowledge limit.');
  const key=JSON.stringify([title,body,e.category]);if(seen.has(key))throw Error('Duplicate reference entry.');seen.add(key);
  return {title,body,kind:e.category};
 });
}

// Returns a parameterized D1 API request. It never connects, posts to Telegram,
// or changes an existing row's approval/removal status. One INSERT is atomic.
export function referenceImport(entries,{groupId,environment,adminId,approved=false}){
 if(!/^-100\d+$/.test(String(groupId))||!['test','production'].includes(environment)||!Number.isSafeInteger(adminId)||adminId<=0||typeof approved!=='boolean')throw Error('Explicit group identity and numeric approving admin are required.');
 const rows=referenceRows(entries);
 return {sql:`INSERT INTO club_memory(title,body,kind,proposed_by,approved_by,status,created_at)
SELECT json_extract(j.value,'$.title'),json_extract(j.value,'$.body'),json_extract(j.value,'$.kind'),?,
 CASE WHEN ?='approved' THEN ? ELSE NULL END,?,unixepoch()
FROM json_each(?) j
WHERE EXISTS(SELECT 1 FROM deployment_identity WHERE id=1 AND group_id=? AND environment=?)
AND NOT EXISTS(SELECT 1 FROM club_memory m WHERE m.title=json_extract(j.value,'$.title')
 AND m.body=json_extract(j.value,'$.body') AND m.kind=json_extract(j.value,'$.kind'))`,
 params:[String(adminId),approved?'approved':'pending',String(adminId),approved?'approved':'pending',JSON.stringify(rows),String(groupId),environment]};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [file,groupId,environment,admin,mode]=process.argv.slice(2);
 if(!file||!['pending','approved'].includes(mode))throw Error('Usage: node reference-import.mjs FILE GROUP_ID test|production ADMIN_ID pending|approved');
 console.log(JSON.stringify(referenceImport(JSON.parse(readFileSync(file,'utf8')),{groupId,environment,adminId:Number(admin),approved:mode==='approved'})));
}
