import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {validatePost} from '../portal-content.mjs';
import {insertDrafts} from './poll-import.mjs';

export function topicContentRows(entries){
 if(!Array.isArray(entries)||!entries.length||entries.length>1000)throw Error('Supply 1–1000 topic entries.');
 const seen=new Set();
 return entries.map(e=>{
  if(!['wallpapers','memes','global_events','hongkong'].includes(e.topic)||!e.source?.title||!e.source?.type||!Array.isArray(e.topics)||!e.topics.length)throw Error('Topic and source metadata required.');
  if(e.source.url&&(!/^https:\/\//.test(e.source.url)||new URL(e.source.url).username||new URL(e.source.url).password))throw Error('Use a public HTTPS source.');
  if(e.expires_at!==undefined&&(!Number.isSafeInteger(e.expires_at)||e.expires_at<=0))throw Error('Expiry must be a Unix timestamp.');
  const p=validatePost(e,{}),metadata={...e,category:e.topic+'_content',required_topic:e.topic};
  const key=createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
  if(seen.has(key))throw Error('Duplicate content.');seen.add(key);
  return {key,kind:p.kind,correct:p.correct,text:p.text,options:p.options,metadata,topic:e.topic};
 });
}
export const topicContentImport=(entries,identity)=>insertDrafts(topicContentRows(entries),identity);
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [file,groupId,environment,admin]=process.argv.slice(2);
 console.log(JSON.stringify(topicContentImport(JSON.parse(readFileSync(file,'utf8')),{groupId,environment,adminId:Number(admin)})));
}
