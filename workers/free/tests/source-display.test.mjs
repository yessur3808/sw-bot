import test from 'node:test';
import assert from 'node:assert/strict';
import {renderSources,sourceQuery} from '../source-display.mjs';
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
