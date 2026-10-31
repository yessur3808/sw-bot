import {formatSourcePost} from './source-display.mjs';
import { NEWS_SOURCES, RELEASE_CATALOG } from './source-catalog.mjs';
import { SOCIAL_SOURCES } from './source-social.mjs';

// A bounded, allowlisted discovery feed. Fetched text is evidence, never code or
// instructions. A successful HTTP request does not reverify a release claim.
const PREFIX='source-feed:', MAX_BYTES=2*1024*1024, NEWS_TTL=48*3600, CATALOG_TTL=30*86400;
const now=()=>Math.floor(Date.now()/1000);
const sourceKey=id=>PREFIX+'state:'+id;
const cacheKey=id=>PREFIX+'cache:'+id;
const parse=(value,fallback={})=>{try{return JSON.parse(value)||fallback;}catch{return fallback;}};
async function read(env,key){return (await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first())?.value;}
async function write(env,key,value){await env.DB.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,JSON.stringify(value)).run();}
async function snapshot(env){return new Map((await env.DB.prepare("SELECT key,value FROM settings WHERE key LIKE 'source-feed:%'").all()).results.map(r=>[r.key,parse(r.value)]));}
function catalogSources(r){return (r.evidence?.length?r.evidence:[{url:r.sourceUrl,all:[]}]).map((e,i)=>({id:'catalog-'+r.id+(i?'-evidence-'+i:''),title:r.title,url:e.url,markers:e.all,recordId:r.id,format:'catalog',kind:'catalog',region:r.region,intervalSeconds:86400}));}
function sources(){return [...NEWS_SOURCES,...RELEASE_CATALOG.flatMap(catalogSources)];}
function clean(value,max=240){
  return String(value||'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&#(x[\da-f]+|\d+);/gi,(_,n)=>{const code=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return code>31&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):' ';}).replace(/&(amp|quot|apos|lt|gt|nbsp);/gi,(_,n)=>({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '}[n.toLowerCase()])).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/@[a-z0-9_]+/gi,'[mention]').replace(/\s+/g,' ').trim().slice(0,max);
}
function safeUrl(value,source){
  try{
    const u=new URL(value,source.url),base=new URL(source.url);
    const hosts=source.allowedHosts||[base.hostname];
    if(u.protocol!=='https:'||u.username||u.password||u.port||!hosts.includes(u.hostname))return null;
    u.hash='';for(const k of [...u.searchParams.keys()])if(k.startsWith('utm_')||['fbclid','gclid'].includes(k))u.searchParams.delete(k);
    return u.href;
  }catch{return null;}
}
const relevant=text=>/star\s*wars|星球大戰|星際大戰|星战|星戰|mandalorian|jedi|skywalker|darth\s+vader|grogu|andor|ahsoka/i.test(text);
export function parseSourceItems(body,source,checkedAt=now()){
  const items=[],seen=new Set();
  const add=(title,url,date)=>{
    title=clean(title);url=safeUrl(clean(url,2048),source);
    if(!url||title.length<12||seen.has(url)||url===source.url)return;
    if(source.region==='HK'&&!relevant(title))return;
    // News hubs contain navigation and shopping links; retain article routes.
    const pathname=new URL(url).pathname;
    if(source.format==='html'&&new URL(source.url).pathname.startsWith('/news')&&!/^\/news\/[^/]+\/?$/.test(pathname))return;
    if(source.format==='html'&&new URL(source.url).hostname==='www.lucasfilm.com'&&!(/^\/news\/[^/]+\/?$/.test(pathname)||/^\/who-we-are\/blog\/[^/]+\/?$/.test(pathname)))return;
    if(new URL(source.url).hostname==='www.lucasfilm.com'&&!relevant(title))return;
    if(source.format==='html'&&new URL(source.url).hostname==='www.ea.com'&&!/\/news\/[^/]+\/?$/.test(pathname))return;
    // The convention homepage is a navigation/marketing hub. Its verified
    // catalog entry supplies dates/ticket status; anchors are not news stories.
    if(source.format==='html'&&new URL(source.url).hostname==='www.starwarscelebration.com')return;
    if(/^(read more|learn more|buy tickets|watch now|privacy|terms|sign in)$/i.test(title))return;
    const titleDate=title.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/i)?.[0];
    seen.add(url);const published=Date.parse(date||titleDate||'');
    items.push({id:url,title,url,sourceId:source.id,sourceTitle:source.title,region:source.region,topic:source.topic,kind:source.kind,checkedAt,publishedAt:Number.isFinite(published)&&published/1000<=checkedAt?Math.floor(published/1000):null,discoveryOnly:true});
  };
  if(source.format==='rss'){
    for(const match of body.matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi)){
      const block=match[1],value=tag=>(block.match(new RegExp('<'+tag+'\\b[^>]*>([\\s\\S]*?)<\\/'+tag+'>','i'))?.[1]||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1');
      add(value('title'),value('link')||block.match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1],value('pubDate')||value('published')||value('updated'));
      if(items.length>=20)break;
    }
  }else{
    const html=body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'');
    for(const m of html.matchAll(/<a\b([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi)){
      add(m[4]||`${m[1]} ${m[3]}`.match(/aria-label=["']([^"']+)["']/i)?.[1],m[2]);
      if(items.length>=20)break;
    }
  }
  return items;
}
async function fetchText(source){
  if(!safeUrl(source.url,source))throw Error('invalid_source');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  let reader;
  try{
    const response=await fetch(source.url,{redirect:'manual',signal:controller.signal,headers:{Accept:'text/html, application/rss+xml, application/atom+xml, application/xml;q=0.9','User-Agent':'SIU-M8-SourceFeed/1.0'}});
    if(response.status>=300&&response.status<400)throw Error('redirect_rejected');
    if(!response.ok)throw Error('http_'+response.status);
    if(response.url&&!safeUrl(response.url,source))throw Error('invalid_response_url');
    if(Number(response.headers.get('content-length'))>MAX_BYTES)throw Error('body_too_large');
    if(!/text\/(html|xml|plain)|application\/(rss\+xml|atom\+xml|xml|xhtml\+xml)/i.test(response.headers.get('content-type')||''))throw Error('unsupported_content_type');
    if(!response.body)throw Error('empty_body');
    reader=response.body.getReader();const decoder=new TextDecoder();let bytes=0,text='';
    while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>MAX_BYTES)throw Error('body_too_large');text+=decoder.decode(part.value,{stream:true});}
    return text+decoder.decode();
  }finally{clearTimeout(timer);if(reader)await reader.cancel().catch(()=>{});}
}
async function digest(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');}

export async function refreshSourceFeed(env){
  const at=now(),all=sources(),due=[],saved=await snapshot(env);
  for(const source of all){const state=saved.get(sourceKey(source.id))||{};if((state.nextDue||0)<=at&&(state.leaseUntil||0)<=at)due.push({source,state});}
  due.sort((a,b)=>(a.state.nextDue||0)-(b.state.nextDue||0));
  const outcomes=[];
  for(const {source,state} of due.slice(0,2)){
    await env.DB.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)').bind(sourceKey(source.id),'{}').run();
    const claim=await env.DB.prepare("UPDATE settings SET value=json_set(value,'$.leaseUntil',?,'$.lastAttempt',?) WHERE key=? AND COALESCE(json_extract(value,'$.nextDue'),0)<=? AND COALESCE(json_extract(value,'$.leaseUntil'),0)<=?").bind(at+60,at,sourceKey(source.id),at,at).run();
    if(!claim.meta.changes)continue;
    try{
      const body=await fetchText(source),previous=parse(await read(env,cacheKey(source.id))),hash=await digest(body);
      const normalized=clean(body,MAX_BYTES).toLowerCase();
      const markersPass=source.format==='catalog'&&source.markers?.length>0?source.markers.every(marker=>normalized.includes(clean(marker,1000).toLowerCase())):null;
      const needsReview=source.format==='catalog'&&(markersPass===false||(markersPass===null&&!!(previous.needsReview||(previous.hash&&previous.hash!==hash))));
      const items=source.format==='catalog'?[]:parseSourceItems(body,source,at);
      // Preserve original discovery times, so repeatedly seeing an old article
      // cannot keep it eligible for automatic posting indefinitely.
      for(const item of items)item.discoveredAt=previous.items?.find(old=>old.url===item.url)?.discoveredAt||at;
      await write(env,cacheKey(source.id),{hash,checkedAt:at,needsReview,markersPass,items});
      const nextDue=at+(source.intervalSeconds||21600);
      const status=needsReview?'needs_review':source.format!=='catalog'&&!items.length?'no_matching_items':'ok';
      await write(env,sourceKey(source.id),{status,lastAttempt:at,lastSuccess:at,nextDue,leaseUntil:0,failures:0,needsReview});
      outcomes.push({id:source.id,status,count:items.length});
    }catch(error){
      const failures=Math.min(8,(state.failures||0)+1),errorCode=/^(invalid_source|redirect_rejected|http_\d+|invalid_response_url|body_too_large|unsupported_content_type|empty_body)$/.test(error.message)?error.message:'fetch_failed';
      await write(env,sourceKey(source.id),{...state,status:'error',lastAttempt:at,nextDue:at+Math.min(21600,300*2**(failures-1)),leaseUntil:0,failures,error:errorCode});
      outcomes.push({id:source.id,status:'error',error:errorCode});
    }
  }
  return outcomes;
}

export async function sourceContext(env,query='',options={}){
  query=String(query).replace(/@[a-z0-9_]+/gi,' ');
  const at=now(),cards=[],saved=await snapshot(env);
  if(options.category!=='news')for(const r of RELEASE_CATALOG){
    const pages=catalogSources(r).map(s=>saved.get(cacheKey(s.id))||{});
    const rechecked=pages.length&&pages.every(p=>p.markersPass===true&&at-p.checkedAt<48*3600);
    const verifiedAt=rechecked?new Date(Math.min(...pages.map(p=>p.checkedAt))*1000).toISOString():r.verifiedAt;
    const age=at-Date.parse(verifiedAt)/1000,needsReview=pages.some(p=>p.needsReview);
    // An announced date passing never becomes proof of a release. A current
    // status requires a separately verified "released" catalog record.
    const elapsedAnnouncement=r.status!=='released'&&r.datePrecision==='day'&&r.releaseDate&&Date.parse(r.releaseDate+'T23:59:59Z')<at*1000;
    const availabilitySensitive=r.hkAvailability==='confirmed'||r.status==='released'||r.access==='ticket';
    const freshness=needsReview||elapsedAnnouncement?'needs_review':Number.isFinite(age)&&age>=0&&age<(availabilitySensitive?48*3600:CATALOG_TTL)?'fresh':'stale';
    cards.push({...r,category:'releases',url:r.sourceUrl,verifiedAt,checkedAt:verifiedAt,freshness,availabilityFresh:freshness==='fresh'&&age<48*3600,evidence:rechecked?'official pages still contain every required evidence marker; no new claims inferred':'dated verified catalog snapshot; HTTP success alone does not reverify claims',untrusted:true});
  }
  if(options.category!=='releases')for(const s of NEWS_SOURCES){
    const cache=saved.get(cacheKey(s.id))||{};
    for(const item of (cache.items||[]).slice(0,20))cards.push({...item,category:'news',freshness:at-item.checkedAt<NEWS_TTL?'fresh':'stale',evidence:'official headline discovery; article claims, event dates and local availability are not independently verified',untrusted:true});
  }
  const generic=/news|event|release|available|availability|watch|stream|movie|film|show|series|game|coming|upcoming|上映|新聞|新闻|活動|活动|電影|电影|遊戲|游戏|影集|劇集|剧集/i.test(query);
  const stops=new Set('the and for with this that what which when where how can could would should will are was has have does from about please latest recent new upcoming coming release releases released date dates available availability watch stream streaming news event events movie movies film films show shows series game games star wars hong kong hongkong global local any some now already yet on in of to a is it me us you i do today tomorrow yesterday day days week weeks month months year years next last soon'.split(' '));
  const terms=(String(query).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)||[]).filter(t=>!stops.has(t));
  const score=c=>terms.reduce((n,t)=>n+(JSON.stringify([c.title,c.kind,c.platforms,c.summary,c.notes]).toLowerCase().includes(t)?1:0),0);
  const seen=new Set();
  return cards.filter(c=>{
    if(c.category==='news'){if(seen.has(c.url))return false;seen.add(c.url);}
    if(String(query).trim()&&(terms.length?(generic?score(c)===0:!terms.some(term=>c.title.toLowerCase().includes(term))):!generic))return false;
    return (!options.region||c.region===options.region||(options.region==='HK'&&c.category==='releases'&&c.hkAvailability==='confirmed'))&&(!options.kind||c.kind===options.kind);
  }).sort((a,b)=>score(b)-score(a)||(a.freshness==='fresh'?-1:1)-(b.freshness==='fresh'?-1:1)).slice(0,Math.min(20,Math.max(1,options.limit||8)));
}

export async function sourcePost(env,kind,usedSeeds=new Set()){
  const topic={movie:'movies',game:'gaming',tv:'tv',hongkong:'hongkong',global_events:'global_events'}[kind];
  if(!topic)return null;
  const at=now(),saved=await snapshot(env);
  for(const source of NEWS_SOURCES.filter(s=>s.topic===topic)){
    const cache=saved.get(cacheKey(source.id))||{};
    for(const item of cache.items||[]){
      const seed='source:'+item.url;
      if(usedSeeds.has(seed)||at-item.checkedAt>=NEWS_TTL||at-(item.publishedAt||item.discoveredAt)>=NEWS_TTL||item.publishedAt>at)continue;
      const formatted=formatSourcePost(item,{news:true,sourceName:source.title});
      if(formatted)return {generation:'source',seed,...formatted};
    }
  }
  const categoryKind={movie:'movie',game:'game',tv:'series',hongkong:'event',global_events:'event'}[kind];
  for(const card of await sourceContext(env,'',{category:'releases',kind:categoryKind,limit:20})){
    const seed='catalog:'+card.id;
    if(card.freshness!=='fresh'||usedSeeds.has(seed)||(kind==='hongkong'?card.region!=='HK':kind==='global_events'&&card.region==='HK'))continue;
    const formatted=formatSourcePost(card);
    if(formatted)return {generation:'source',seed,...formatted};
  }
  return null;
}

export async function sourceStatus(env){
  const out=[],saved=await snapshot(env);let newsCount=0;
  for(const source of sources()){
    const state=saved.get(sourceKey(source.id))||{},cache=saved.get(cacheKey(source.id))||{};
    newsCount+=(cache.items||[]).length;
    out.push({id:source.id,title:source.title,url:source.url,status:state.status||'pending',lastSuccess:state.lastSuccess||null,nextDue:state.nextDue||0,needsReview:!!cache.needsReview,error:state.error||null});
  }
  // Directory entries never enter the fetch queue, news cache or AI context.
  const social=SOCIAL_SOURCES.map(s=>({...s,status:'connection_required',lastSuccess:null,nextDue:null,needsReview:false}));
  return {sources:out,socialSources:social,socialCount:social.length,catalogCount:RELEASE_CATALOG.length,newsCount};
}
