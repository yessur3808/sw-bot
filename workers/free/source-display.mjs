// Telegram text views of source data; no network access and no inferred availability.
export function sourceQuery(command,arg=''){
 const q=arg.trim(),local=/hong\s*kong|\bhk\b|香港|local/i.test(q);
 const kind=/games?|gaming|遊戲/i.test(q)?'game':/movies?|films?|電影/i.test(q)?'movie':/shows?|series|\btv\b|劇集/i.test(q)?'series':/events?|活動/i.test(q)?'event':undefined;
 const query=q.replace(/\b(?:hong\s*kong|hongkong|hk|local|global|games?|gaming|movies?|films?|shows?|series|tv|events?)\b|香港|遊戲|電影|劇集|活動/gi,' ').trim();
 return {query,options:{category:command==='news'?'news':'releases',...(local?{region:'HK'}:{}),...(kind&&command!=='news'?{kind}:{}),limit:5},topic:command==='news'?(local?'hongkong':'global_events'):kind==='game'?'gaming':kind==='series'?'tv':kind==='movie'?'movies':null};
}
function checked(value){
 if(!value)return 'not checked';
 const date=typeof value==='number'?new Date(value*1000):new Date(value);
 return Number.isFinite(date.getTime())?date.toISOString().slice(0,10):'not checked';
}
export function renderSources(cards,category,local=false){
 const heading=category==='news'?(local?'Hong Kong Star Wars sources':'Star Wars official headlines'):'Star Wars releases & availability';
 if(!cards.length)return heading+'\n\n'+(local?'No fresh, verified Hong Kong listing is available in the monitored sources. This does not mean there are no local events.':'No matching current source is available. Try /news or /releases movies, shows or games.');
 const parts=[heading];
 for(const c of cards){
  const lines=[c.title||c.headline||'Official source'];
  if(category==='releases'){
   const date=c.releaseDate||'Date not announced';
   const historical=c.freshness!=='fresh';
   const past=c.releaseDate&&c.datePrecision==='day'&&c.releaseDate<new Date().toISOString().slice(0,10);
   const status=historical?'Previously recorded':c.status==='released'?'Released':c.status==='upcoming'&&past?'Announced date has passed; release status unconfirmed':c.status==='upcoming'?'Upcoming':'Announced';
   lines.push(`${status}: ${date} · ${c.region||'region unconfirmed'}`);
   if(c.platforms?.length)lines.push(`Platform/service: ${c.platforms.join(', ')}${c.access&&c.access!=='unknown'?' · '+c.access:''}`);
   if(c.summary)lines.push(c.summary);
   lines.push(c.hkAvailability==='confirmed'&&!historical?'Hong Kong availability confirmed by the linked source.':'Hong Kong availability not verified; check the regional provider before buying or subscribing.');
   if(c.notes)lines.push(c.notes);
  }else{
   if(c.publishedAt||c.published)lines.push('Published: '+checked(c.publishedAt||c.published));
   lines.push('Source headline; read the original for details.');
  }
  lines.push(`${c.freshness==='fresh'?'Checked':'Needs recheck; last checked'} ${checked(c.checkedAt||c.verifiedAt)}`);
  const links=[...new Set([c.sourceUrl||c.url,c.availabilityUrl].filter(Boolean))];lines.push(...links);
  const block=lines.join('\n');if(parts.join('\n\n').length+block.length>3600)break;parts.push(block);
 }
 return parts.join('\n\n');
}
export function renderSourceStatus(status){
 return ['News & release sources',`${status.catalogCount||0} catalogue entries · ${status.newsCount||0} cached headlines`,...(status.socialCount?[`${status.socialCount} official social accounts listed in the portal: connection required. Social posts are not monitored.`]:[]),...status.sources.map(s=>`${s.title}: ${s.status}${s.needsReview?' · review needed':''}\nLast successful check: ${checked(s.lastSuccess)}\n${s.url}`)].join('\n\n').slice(0,3700);
}
