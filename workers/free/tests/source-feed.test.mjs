import test from 'node:test';
import assert from 'node:assert/strict';
import {portalFixture} from './portal-fixture.mjs';
import {NEWS_SOURCES,RELEASE_CATALOG} from '../source-catalog.mjs';
import {SOCIAL_SOURCES} from '../source-social.mjs';
import {parseSourceItems,refreshSourceFeed,sourceContext,sourcePost,sourceStatus} from '../source-feed.mjs';

const put=(db,key,value)=>db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(key,JSON.stringify(value));
const get=(db,key)=>JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value||'{}');
const t=()=>Math.floor(Date.now()/1000);
function onlySource(db,id){
  for(const source of NEWS_SOURCES)if(source.id!==id)put(db,'source-feed:state:'+source.id,{nextDue:t()+86400});
  for(const r of RELEASE_CATALOG)for(let i=0;i<Math.max(1,r.evidence?.length||0);i++){
    const key='catalog-'+r.id+(i?'-evidence-'+i:'');
    if(key!==id)put(db,'source-feed:state:'+key,{nextDue:t()+86400});
  }
}

test('unconnected social directory stays outside collection and content despite saved social cache',async()=>{
  const {sqlite,env}=portalFixture(),oldFetch=globalThis.fetch;
  onlySource(sqlite,'none');
  for(const source of SOCIAL_SOURCES){
    put(sqlite,'source-feed:state:'+source.id,{status:'ok',lastSuccess:t()});
    put(sqlite,'source-feed:cache:'+source.id,{items:[{title:'Unconnected social claim',url:source.url,checkedAt:t(),discoveredAt:t()}]});
  }
  globalThis.fetch=async()=>{throw new Error('No social fetch permitted');};
  try{
    assert.deepEqual(await refreshSourceFeed(env),[]);
    const status=await sourceStatus(env);
    assert.equal(status.socialCount,10);
    assert.equal(new Set(SOCIAL_SOURCES.map(s=>s.id)).size,10);
    assert.ok(status.socialSources.every(s=>s.status==='connection_required'&&s.lastSuccess===null&&s.nextDue===null));
    assert.ok(status.sources.every(s=>!s.id.startsWith('social-')));
    assert.equal(status.newsCount,0);
    assert.deepEqual(await sourceContext(env,'',{category:'news'}),[]);
    assert.equal(await sourcePost(env,'global_events',new Set(RELEASE_CATALOG.map(c=>'catalog:'+c.id))),null);
  }finally{globalThis.fetch=oldFetch;sqlite.close();}
});

test('official parsing deduplicates URLs, removes unsafe links and excludes unrelated Hong Kong events',()=>{
  const source={id:'hk',title:'Official HK events',url:'https://hk.example/events',format:'html',region:'HK',topic:'hongkong'};
  const items=parseSourceItems(`<a href="/concert">Taylor Swift concert this weekend</a>
  <a href="/wars?utm_source=feed">Star Wars &amp; friends&#58; parade</a>
  <a href="/wars">Star Wars &amp; friends: parade</a>
  <a href="https://evil.example/star-wars">Star Wars ticket scam</a>
  <a href="javascript:alert(1)">Star Wars fake event</a>
  <script><a href="/hidden">Star Wars malicious hidden content</a></script>`,source,100);
  assert.equal(items.length,1);assert.equal(items[0].title,'Star Wars & friends: parade');
  assert.equal(items[0].url,'https://hk.example/wars');assert.equal(items[0].publishedAt,null);
  const rss=parseSourceItems('<rss><item><title><![CDATA[Star Wars official announcement]]></title><link>https://hk.example/wars</link><pubDate>Thu, 29 Oct 2026 00:00:00 GMT</pubDate></item></rss>',{...source,format:'rss'},Date.parse('2026-10-29T12:00Z')/1000);
  assert.equal(rss.length,1);assert.equal(rss[0].publishedAt,Date.parse('2026-10-29T00:00Z')/1000);
  const sw={id:'sw',title:'SW',url:'https://www.starwars.com/news',format:'html',region:'global'};
  const article=parseSourceItems('<a href="/news/category/events">Global Star Wars Events</a><a href="/news/tag/grogu">Mandalorian and Grogu</a><a href="/news/ahsoka-season-2">Ahsoka Season 2 release announced</a>',sw,100);
  assert.equal(article.length,1);assert.match(article[0].url,/ahsoka-season-2$/);
  const lucas={...sw,url:'https://www.lucasfilm.com/who-we-are/blog/'};
  assert.equal(parseSourceItems('<a href="/who-we-are/blog/indy">Indiana Jones new adventure</a><a href="/who-we-are/leadership">Star Wars company leadership</a>',lucas,100).length,0);
  assert.equal(parseSourceItems('<a href="/en-us/newsletter.html">Star Wars Celebration newsletter</a>',{...sw,url:'https://www.starwarscelebration.com/'},100).length,0);
});

test('collector rejects redirects without fetching their target, persists retry and preserves last good evidence',async()=>{
  const {sqlite,env}=portalFixture(),oldFetch=globalThis.fetch,source=NEWS_SOURCES[0];
  onlySource(sqlite,source.id);const previous={checkedAt:t()-100,items:[{title:'old'}]};put(sqlite,'source-feed:cache:'+source.id,previous);
  let calls=0;globalThis.fetch=async(url,options)=>{calls++;assert.equal(url,source.url);assert.equal(options.redirect,'manual');return new Response(null,{status:302,headers:{location:'http://169.254.169.254/latest/meta-data'}});};
  try{
    const out=await refreshSourceFeed(env);assert.equal(calls,1);assert.equal(out[0].error,'redirect_rejected');
    assert.deepEqual(get(sqlite,'source-feed:cache:'+source.id),previous);
    const state=get(sqlite,'source-feed:state:'+source.id);assert.equal(state.lastSuccess,undefined);assert.ok(state.nextDue>t());
    await refreshSourceFeed(env);assert.equal(calls,1);
  }finally{globalThis.fetch=oldFetch;sqlite.close();}
});

test('streamed oversized responses are cancelled before parse and are not cached',async()=>{
  const {sqlite,env}=portalFixture(),oldFetch=globalThis.fetch,source=NEWS_SOURCES[0];onlySource(sqlite,source.id);
  let cancelled=false;
  globalThis.fetch=async()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(256*1024));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/html'}});
  try{const result=await refreshSourceFeed(env);assert.equal(result[0].error,'body_too_large');assert.equal(cancelled,true);assert.equal(get(sqlite,'source-feed:cache:'+source.id).checkedAt,undefined);}
  finally{globalThis.fetch=oldFetch;sqlite.close();}
});

test('concurrent cron refresh uses persistent leases and bounds each invocation to two requests',async()=>{
  const {sqlite,env}=portalFixture(),oldFetch=globalThis.fetch;
  let calls=0,release;const wait=new Promise(resolve=>{release=resolve;});
  globalThis.fetch=async()=>{calls++;await wait;return new Response('<html></html>',{headers:{'content-type':'text/html'}});};
  try{
    const first=refreshSourceFeed(env);await new Promise(resolve=>setTimeout(resolve,10));
    const second=refreshSourceFeed(env);await new Promise(resolve=>setTimeout(resolve,10));release();
    const results=await Promise.all([first,second]);assert.ok(results.every(r=>r.length<=2));
    assert.equal(new Set(results.flat().map(r=>r.id)).size,results.flat().length);assert.ok(calls<=4);
  }finally{globalThis.fetch=oldFetch;sqlite.close();}
});

test('source context never fetches; stale snapshots and elapsed announcements are explicit, not invented released status',async()=>{
  const {sqlite,env}=portalFixture(),oldFetch=globalThis.fetch,oldNow=Date.now;
  globalThis.fetch=()=>{throw Error('read path must not fetch');};Date.now=()=>Date.parse('2036-01-01T00:00:00Z');
  try{
    const rows=await sourceContext(env,'',{category:'releases',limit:20});assert.equal(rows.length,Math.min(20,RELEASE_CATALOG.length));
    assert.ok(rows.every(r=>r.freshness!=='fresh'));
    for(const row of rows)assert.equal(row.status,RELEASE_CATALOG.find(r=>r.id===row.id).status);
    assert.ok(rows.every(r=>r.untrusted&&r.url&&r.verifiedAt));
  }finally{globalThis.fetch=oldFetch;Date.now=oldNow;sqlite.close();}
});

test('Hong Kong release filtering includes verified local streaming without relabelling the global release date',async()=>{
  const {sqlite,env}=portalFixture();
  try{
    const rows=await sourceContext(env,'',{category:'releases',region:'HK',kind:'series',limit:20});
    assert.ok(rows.length>0);assert.ok(rows.every(r=>r.hkAvailability==='confirmed'));
    for(const row of rows)assert.equal(row.region,RELEASE_CATALOG.find(r=>r.id===row.id).region);
  }finally{sqlite.close();}
});

test('unrelated conversation and unknown titles receive no irrelevant release cards',async()=>{
  const {sqlite,env}=portalFixture();
  try{
    assert.deepEqual(await sourceContext(env,'Which droid would take R2 on a road trip?'),[]);
    assert.deepEqual(await sourceContext(env,'When is Darth Flibbertigibbet released?'),[]);
    assert.ok((await sourceContext(env,'What new shows are coming?',{category:'releases',kind:'series'})).length>0);
    assert.ok((await sourceContext(env,'@SIU_M8_bot what new movies are coming this year?',{category:'releases',kind:'movie'})).length>0);
  }finally{sqlite.close();}
});

test('old and reused news does not become new again after a successful refresh',async()=>{
  const {sqlite,env}=portalFixture(),oldFetch=globalThis.fetch,source=NEWS_SOURCES.find(s=>s.topic==='global_events');
  assert.ok(source);onlySource(sqlite,source.id);
  const url=new URL('/news/star-wars-fixture',source.url).href;
  const used=new Set(RELEASE_CATALOG.map(r=>'catalog:'+r.id));
  put(sqlite,'source-feed:cache:'+source.id,{items:[{url,discoveredAt:t()-3*86400}]});
  globalThis.fetch=async()=>new Response(`<a href="${url}">Star Wars official fixture announcement</a>`,{headers:{'content-type':'text/html'}});
  try{
    await refreshSourceFeed(env);assert.equal(await sourcePost(env,'global_events',used),null);
    const cache=get(sqlite,'source-feed:cache:'+source.id);cache.items[0].discoveredAt=t();put(sqlite,'source-feed:cache:'+source.id,cache);
    const post=await sourcePost(env,'global_events',used);assert.match(post.text,/Official source spotlight/);assert.ok(post.text.includes(url));
    used.add(post.seed);assert.equal(await sourcePost(env,'global_events',used),null);
  }finally{globalThis.fetch=oldFetch;sqlite.close();}
});

test('catalog evidence markers must all pass across every source before refreshing verification',async()=>{
  const {sqlite,env}=portalFixture(),oldFetch=globalThis.fetch,oldNow=Date.now;
  const record=RELEASE_CATALOG.find(r=>r.evidence?.length&&r.status==='released');assert.ok(record);
  Date.now=()=>Date.parse('2026-11-01T10:00:00Z');
  globalThis.fetch=async url=>new Response('<html>'+record.evidence.find(e=>e.url===url).all.join(' | ')+'</html>',{headers:{'content-type':'text/html'}});
  try{
    for(let i=0;i<record.evidence.length;i++){
      const id='catalog-'+record.id+(i?'-evidence-'+i:'');onlySource(sqlite,id);put(sqlite,'source-feed:state:'+id,{});await refreshSourceFeed(env);
    }
    const row=(await sourceContext(env,record.title,{category:'releases',limit:20})).find(r=>r.id===record.id);
    assert.equal(row.freshness,'fresh');assert.match(row.verifiedAt,/2026-11-01/);
    const id='catalog-'+record.id;put(sqlite,'source-feed:state:'+id,{});onlySource(sqlite,id);
    globalThis.fetch=async()=>new Response('<html>Information changed. More soon.</html>',{headers:{'content-type':'text/html'}});
    await refreshSourceFeed(env);
    const changed=(await sourceContext(env,record.title,{category:'releases',limit:20})).find(r=>r.id===record.id);
    assert.equal(changed.freshness,'needs_review');assert.equal(changed.verifiedAt,record.verifiedAt);
    assert.ok((await sourceStatus(env)).sources.find(s=>s.id===id).needsReview);
  }finally{globalThis.fetch=oldFetch;Date.now=oldNow;sqlite.close();}
});

test('failed availability rechecks cannot extend a two-day availability claim',async()=>{
  const {sqlite,env}=portalFixture(),oldFetch=globalThis.fetch,oldNow=Date.now;
  const record=RELEASE_CATALOG.find(r=>r.hkAvailability==='confirmed'&&r.status==='released');assert.ok(record);
  Date.now=()=>Date.parse(record.verifiedAt)+3*86400000;onlySource(sqlite,'catalog-'+record.id);
  globalThis.fetch=async()=>{throw Error('offline');};
  try{
    await refreshSourceFeed(env);
    const row=(await sourceContext(env,record.title,{category:'releases',limit:20})).find(r=>r.id===record.id);
    assert.equal(row.verifiedAt,record.verifiedAt);assert.equal(row.freshness,'stale');assert.equal(row.availabilityFresh,false);
  }finally{globalThis.fetch=oldFetch;Date.now=oldNow;sqlite.close();}
});
