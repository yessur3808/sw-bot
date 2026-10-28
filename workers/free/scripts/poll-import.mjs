import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {validatePost} from '../portal-content.mjs';

const text=(s,n)=>typeof s==='string'&&s.trim().length>0&&s.length<=n;
export function pollRows(entries){
 if(!Array.isArray(entries)||!entries.length||entries.length>1000)throw Error('Supply 1–1000 polls.');
 const seen=new Set();
 return entries.map(e=>{
  if(!e||!/^\w+_poll$/.test(e.category)||!text(e.category,60)||!text(e.source?.type,80)||
   (e.source.title!==undefined&&!text(e.source.title,160))||!Array.isArray(e.topics)||!e.topics.length||e.topics.length>10||e.topics.some(t=>!text(t,60)))throw Error('Invalid poll metadata.');
  const p=validatePost({kind:'poll',text:e.question,options:e.options},{});
  const metadata={category:e.category,question:e.question,options:e.options,source:e.source,topics:e.topics};
  const key=createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
  if(seen.has(key))throw Error('Duplicate poll.');seen.add(key);
  // Specific media categories route to their topic; mixed lore stays in Lore.
  const topic=e.category==='game_poll'||e.source.type==='game'?'gaming':
   ['watch_party_poll','rewatch_poll','music_poll','scene_poll','ranking_poll'].includes(e.category)||e.source.type==='movie'?'movies':
   ['meme_poll','humor_poll'].includes(e.category)?'memes':e.source.type==='series'?'tv':'lore';
  return {key,text:p.text,options:p.options,metadata,topic};
 });
}

// Produces a parameterized single INSERT; never approves, schedules or sends.
export function pollImport(entries,{groupId,environment,adminId}){
 if(!/^-100\d+$/.test(String(groupId))||!['test','production'].includes(environment)||!Number.isSafeInteger(adminId)||adminId<=0)throw Error('Explicit group identity and admin required.');
 const rows=pollRows(entries);
 return {sql:`INSERT INTO admin_posts(kind,text,options,thread_id,state,created_by,created_at,updated_at,import_key,import_metadata)
 SELECT 'poll',json_extract(j.value,'$.text'),json_extract(j.value,'$.options'),
 COALESCE((SELECT thread_id FROM topic_map WHERE name=json_extract(j.value,'$.topic')),
          (SELECT thread_id FROM topic_map WHERE name='lore'),0),
 'draft',?,unixepoch(),unixepoch(),json_extract(j.value,'$.key'),json_extract(j.value,'$.metadata')
 FROM json_each(?) j
 WHERE EXISTS(SELECT 1 FROM deployment_identity WHERE id=1 AND group_id=? AND environment=?)
 ON CONFLICT(import_key) DO NOTHING`,params:[String(adminId),JSON.stringify(rows),String(groupId),environment]};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [file,groupId,environment,admin]=process.argv.slice(2);
 if(!file)throw Error('Usage: node poll-import.mjs FILE GROUP_ID test|production ADMIN_ID');
 console.log(JSON.stringify(pollImport(JSON.parse(readFileSync(file,'utf8')),{groupId,environment,adminId:Number(admin)})));
}
