// Telegram text views of source data; no network access and no inferred availability.
function displayDate(value){
 const raw=typeof value==='number'?new Date(value*1000).toISOString().slice(0,10):String(value||'');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(raw))return raw||'To be confirmed';
 const date=new Date(raw+'T12:00:00Z');
 if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==raw)return raw;
 return new Intl.DateTimeFormat('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(date);
}
// Telegram entities keep source text literal and use UTF-16 offsets, including
// emoji/CJK titles. Never parse third-party titles or summaries as HTML/Markdown.
export function formatSourcePost(card,{news=false,sourceName='Official source'}={}){
 let text='';const entities=[];
 const add=(value,type,url)=>{const content=String(value||''),offset=text.length;text+=content;if(type&&content)entities.push({type,offset,length:content.length,...url?{url}:{}});};
 const field=(label,value)=>{add(label+': ','bold');add(value+'\n');};
 const link=(label,url)=>{try{const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password)return false;add(label,'text_link',parsed.href);return true;}catch{return false;}};
 add(card.title||card.headline||'Star Wars update','bold');add('\n\n');
 if(news){
  add(sourceName);add('\n');
  if(card.publishedAt)field('Published',displayDate(card.publishedAt));
  add('\nRead the official announcement for the full details.\n\n');
  link('Read announcement',card.url||card.sourceUrl);
 }else{
  const event=card.kind==='event',region={HK:'Hong Kong',US:'United States',global:'Worldwide'}[card.region]||card.region||'Region unconfirmed';
  const range=displayDate(card.releaseDate)+(card.endDate&&card.endDate!==card.releaseDate?' – '+displayDate(card.endDate):'');
  if(event){
   field(card.region==='HK'?'Date (Hong Kong)':'Date (local)',range);
   if(card.platforms?.length)field('Venue',card.platforms.join(', '));
   if(card.region!=='HK')field('Region',region);
  }else{
   const past=card.status==='upcoming'&&card.datePrecision==='day'&&card.releaseDate<new Date().toISOString().slice(0,10);
   field('Status',card.status==='released'?'Released':past?'Announced date has passed; release unconfirmed':card.status==='upcoming'?'Upcoming':'Announced');
   field('Release date',range);field('Region',region);
   if(card.platforms?.length)field(card.kind==='game'?'Platforms':'Where to watch',card.platforms.join(', '));
  }
  if(card.summary){add('\n');add(card.summary);add('\n');}
  add('\n');
  if(event){
   field('Time','Check the event website');
   field('Admission',card.access==='unknown'||!card.access?'Not verified — check before travelling':card.access==='ticket'?'Ticket required — check current availability':card.access);
  }else{
   if(card.access&&card.access!=='unknown')field('Access',card.access);
   field('Hong Kong',card.hkAvailability==='confirmed'?'Availability confirmed by the linked source':'Availability not verified — check the regional provider');
  }
  add('\n');link('Official source',card.sourceUrl||card.url);
  if(card.availabilityUrl&&card.availabilityUrl!==(card.sourceUrl||card.url)){
   try{if(new URL(card.availabilityUrl).protocol==='https:'){add('  ·  ');link(event?'Event website':'Availability details',card.availabilityUrl);}}catch{/* Invalid source links are never rendered. */}
  }
 }
 const verified=card.checkedAt||card.verifiedAt;
 if(verified){add('\n');add('Checked '+displayDate(typeof verified==='string'?verified.slice(0,10):verified),'italic');}
 // Bound third-party content without slicing through a text entity.
 if(text.length>3900)return null;
 return {text,entities};
}
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
 return ['News & release sources',`${status.catalogCount||0} catalogue entries · ${status.newsCount||0} cached headlines`,...(status.youtube?[`YouTube trailers: ${status.youtube.channels.map(c=>c.title+': '+c.status).join('; ')}. Checks every 15 minutes; delivery status in the portal.`]:[]),...(status.socialCount?[`${status.socialCount} official X/Instagram accounts listed in the portal: connection required. X/Instagram posts are not monitored.`]:[]),...status.sources.map(s=>`${s.title}: ${s.status}${s.needsReview?' · review needed':''}\nLast successful check: ${checked(s.lastSuccess)}\n${s.url}`)].join('\n\n').slice(0,3700);
}
