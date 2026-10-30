import test from 'node:test';
import assert from 'node:assert/strict';
import {renderSources,sourceQuery,renderSourceStatus} from '../source-display.mjs';
test('source diagnostics disclose unconnected social accounts before long website diagnostics',()=>{
 const text=renderSourceStatus({socialCount:10,sources:Array.from({length:40},()=>({title:'Website source',status:'pending',url:'https://example.com'}))});
 assert.match(text,/10 official X\/Instagram accounts/);
 assert.match(text,/X\/Instagram posts are not monitored/);
 assert.ok(text.length<=3700);
});
test('source commands select the matching topic and Hong Kong filter',()=>{
 assert.equal(sourceQuery('news','hong kong').topic,'hongkong');
 assert.equal(sourceQuery('releases','games').options.kind,'game');
 assert.equal(sourceQuery('releases','shows').topic,'tv');
 assert.equal(sourceQuery('news','香港').options.region,'HK');
 assert.equal(sourceQuery('news','hongkong').query,'');
 assert.equal(sourceQuery('releases','hongkong shows').query,'');
 assert.equal(sourceQuery('releases','games Zero Company').query,'Zero Company');
});
test('release replies do not infer released status or Hong Kong availability',()=>{
 const card={title:'Example',status:'upcoming',releaseDate:'2020-01-01',datePrecision:'day',region:'US',platforms:['Example service'],access:'subscription',freshness:'fresh',verifiedAt:'2026-10-29',hkAvailability:'unverified',sourceUrl:'https://example.com/title'};
 const text=renderSources([card],'releases');
 assert.match(text,/release status unconfirmed/);assert.match(text,/Hong Kong availability not verified/);assert.match(text,/https:\/\/example.com\/title/);
 assert.doesNotMatch(renderSources([{...card,freshness:'needs_review',hkAvailability:'confirmed'}],'releases'),/Hong Kong availability confirmed/);
 assert.match(renderSources([],'news',true),/does not mean there are no local events/);
});

import {formatSourcePost} from '../source-display.mjs';
import {RELEASE_CATALOG} from '../source-catalog.mjs';
test('HK event cards separate title, date, venue and linked sources without release terminology',()=>{
 const card=RELEASE_CATALOG.find(c=>c.id==='hongkong-halloween-star-wars-parade-2026');
 const post=formatSourcePost(card);
 assert.match(post.text,/Date \(Hong Kong\): Sat, 31 Oct 2026/);
 assert.match(post.text,/Venue: Chater Road, Central, Hong Kong/);
 assert.match(post.text,/Admission: Not verified/);
 assert.doesNotMatch(post.text,/Announced release|Platforms:|https:\/\//);
 assert.equal(post.text.slice(post.entities[0].offset,post.entities[0].length),card.title);
 assert.ok(post.entities.some(e=>e.type==='text_link'&&e.url===card.sourceUrl));
 assert.ok(post.entities.some(e=>e.type==='text_link'&&e.url===card.availabilityUrl));
});
test('source formatting keeps literal special characters and valid UTF-16 entity ranges',()=>{
 const post=formatSourcePost({title:'🚀 香港 <b>News</b> & updates',url:'https://example.com/news',checkedAt:1793318400},{news:true,sourceName:'Official channel'});
 assert.ok(post.text.startsWith('🚀 香港 <b>News</b> & updates'));
 for(const e of post.entities){assert.ok(e.offset>=0&&e.length>0&&e.offset+e.length<=post.text.length);if(e.type==='text_link')assert.equal(post.text.slice(e.offset,e.offset+e.length),'Read announcement');}
 assert.equal(post.parse_mode,undefined);
 assert.equal(formatSourcePost({title:'x'.repeat(4000)},{news:true}),null);
 assert.ok(!formatSourcePost({title:'Unsafe link',url:'javascript:alert(1)'},{news:true}).entities.some(e=>e.type==='text_link'));
});
test('release cards keep regional uncertainty and partial dates; global events retain local dates and sold-out warning',()=>{
 const release=formatSourcePost({title:'Example',kind:'movie',status:'upcoming',releaseDate:'2020-01-01',datePrecision:'day',region:'US',hkAvailability:'unverified',platforms:['Example service'],access:'subscription'});
 assert.match(release.text,/release unconfirmed/);assert.match(release.text,/Availability not verified/);assert.match(release.text,/Where to watch: Example service/);
 assert.match(formatSourcePost({title:'Partial date',kind:'game',releaseDate:'2027',datePrecision:'year'}).text,/Release date: 2027\n/);
 const event=formatSourcePost(RELEASE_CATALOG.find(c=>c.id==='celebration-los-angeles-2027'));
 assert.match(event.text,/Date \(local\): Thu, 1 Apr 2027 – Sun, 4 Apr 2027/);
 assert.match(event.text,/sold out/);assert.doesNotMatch(event.text,/Hong Kong availability confirmed|Announced release/);
});
