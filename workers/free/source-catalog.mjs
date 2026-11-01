// Editorial seed verified against the linked official pages on 2026-10-29.
// Dates describe the named release/market, never an inferred Hong Kong launch.
// A past announcement date alone is not evidence that a title was released.
// `evidence` contains short required markers for conservative source rechecks.
const verifiedAt = '2026-10-29';
const sw = path => `https://www.starwars.com/${path}`;
const hkDisney = id => `https://www.disneyplus.com/en-hk/browse/entity-${id}`;
const evidence = (url, ...all) => ({url, all});
const source = (id, title, url, kind, region, topic, extra = {}) => ({
  id, title, label:title, url, format:'html', kind, region, topic,
  discoveryOnly:true, intervalSeconds:21600, allowedHosts:[new URL(url).hostname], ...extra,
});

export const NEWS_SOURCES = [
  source('starwars-news','StarWars.com news',sw('news'),'news','global','global_events'),
  source('starwars-events','StarWars.com events',sw('news/category/events'),'events','global','global_events'),
  source('lucasfilm-news','Lucasfilm news','https://www.lucasfilm.com/who-we-are/blog/','news','global','global_events',{
    allowedHosts:['www.lucasfilm.com','www.starwars.com'],
  }),
  source('zero-company-news','EA Star Wars Zero Company news','https://www.ea.com/games/starwars/zero-company/news','news','global','gaming'),
  source('celebration','Star Wars Celebration','https://www.starwarscelebration.com/','events','global','global_events',{
    notes:'The ticket-information page is authoritative for ticket availability; homepage marketing can remain after sell-out.',
  }),
  source('hktb-events','Hong Kong Tourism Board events','https://www.discoverhongkong.com/eng/events.html','events','HK','hongkong',{
    notes:'Discovery only; require a specific Star Wars listing and organiser confirmation. Direct HTTP returned 403 during verification; report fetch failure rather than claiming no events exist.',
  }),
  source('hkdl-events','Hong Kong Disneyland events','https://www.hongkongdisneyland.com/events/','events','HK','hongkong',{
    notes:'Discovery only; ordinary park events are not Star Wars events. Direct HTTP returned an empty JavaScript shell during verification.',
  }),
  source('hk-cinema-coming','Hong Kong cinema upcoming listings','https://www.cinema.com.hk/en/movie/coming','releases','HK','movies',{
    notes:'Discovery only; a dated title-specific cinema listing is required to establish Hong Kong screenings. The generic page is not a confirmed Star Wars release.',
  }),
];

const release = row => ({
  verifiedAt, datePrecision:'day', region:'global', hkAvailability:'unverified',
  availabilityUrl:null, notes:'Hong Kong availability has not been verified.', ...row,
});

export const RELEASE_CATALOG = [
  release({
    id:'the-mandalorian-and-grogu-2026', title:'Star Wars: The Mandalorian and Grogu', kind:'movie',
    status:'released', releaseDate:'2026-05-22', platforms:['Disney+'], access:'subscription',
    summary:'The film has been released and is listed on Disney+ Hong Kong. Watch with a Disney+ subscription.',
    sourceUrl:sw('films/Star-Wars-The-Mandalorian-and-Grogu'),
    availabilityUrl:hkDisney('d830ec57-499e-498c-b6b3-2b85a18a5f51'), hkAvailability:'confirmed',
    notes:'May 22 is the official film release date, not a verified Hong Kong cinema or streaming premiere date. Digital purchases and discs are also announced globally; Hong Kong retailers were not verified.',
    evidence:[evidence(sw('films/Star-Wars-The-Mandalorian-and-Grogu'),'May 22, 2026','available now','Disney+'), evidence(hkDisney('d830ec57-499e-498c-b6b3-2b85a18a5f51'),'The Mandalorian and Grogu','2026','DISNEY+ MONTHLY')],
  }),
  release({
    id:'maul-shadow-lord-season-1', title:'Star Wars: Maul – Shadow Lord (Season 1)', kind:'series',
    status:'released', releaseDate:'2026-04-06', platforms:['Disney+'], access:'subscription',
    summary:'All ten episodes of the first season are available; the title and episodes are listed on Disney+ Hong Kong.',
    sourceUrl:sw('series/Star-Wars-Maul-Shadow-Lord'), availabilityUrl:hkDisney('9ba0f41b-6173-4ff1-8967-71cad0620244'), hkAvailability:'confirmed',
    notes:'April 6 is the announced series premiere date. A Hong Kong subscription is required; account and catalogue restrictions can change.',
    evidence:[evidence(sw('series/Star-Wars-Maul-Shadow-Lord'),'April 6, 2026','now streaming','Disney+'), evidence(hkDisney('9ba0f41b-6173-4ff1-8967-71cad0620244'),'Shadow Lord','EPISODES','DISNEY+ MONTHLY')],
  }),
  release({
    id:'the-ninth-jedi-2026', title:'Star Wars: Visions Presents — The Ninth Jedi', kind:'series',
    status:'released', releaseDate:'2026-08-05', platforms:['Disney+'], access:'subscription',
    summary:'The eight-part animated series is streaming and has a Disney+ Hong Kong title page with episodes.',
    sourceUrl:sw('series/star-wars-visions-presents-the-ninth-jedi'), availabilityUrl:hkDisney('921588f0-9a3b-4cd6-80d6-0a7cc9ed388a'), hkAvailability:'confirmed',
    notes:'The official announcement also names Hulu, but Hulu access is not being claimed for Hong Kong. August 5 is the official series premiere date.',
    evidence:[evidence(sw('series/star-wars-visions-presents-the-ninth-jedi'),'August 5, 2026','now streaming','Disney+'), evidence(hkDisney('921588f0-9a3b-4cd6-80d6-0a7cc9ed388a'),'The Ninth Jedi','EPISODES','DISNEY+ MONTHLY')],
  }),
  release({
    id:'lego-mandalorian-2026', title:'LEGO Star Wars: The Mandalorian', kind:'series',
    status:'released', releaseDate:'2026-09-02', platforms:['Disney+'], access:'subscription',
    summary:'A standalone animated special is streaming and listed on Disney+ Hong Kong.',
    sourceUrl:sw('news/lego-star-wars-the-mandalorian'), availabilityUrl:hkDisney('e1234eda-704c-4729-a47e-e8be088bc61f'), hkAvailability:'confirmed',
    notes:'This is an animated special, not a new live-action season. The announced September 2 premiere is not separately verified as a Hong Kong launch date.',
    evidence:[evidence(sw('news/lego-star-wars-the-mandalorian'),'September 2','Disney+'), evidence('https://www.lucasfilm.com/productions/lego-star-wars-the-mandalorian/','Released: 2026','Stream Now on Disney+'), evidence(hkDisney('e1234eda-704c-4729-a47e-e8be088bc61f'),'LEGO Star Wars: The Mandalorian','2026','DISNEY+ MONTHLY')],
  }),
  release({
    id:'ahsoka-season-2', title:'Star Wars: Ahsoka (Season 2)', kind:'series',
    status:'upcoming', releaseDate:'2027-01-20', platforms:['Disney+'], access:'subscription',
    summary:'Lucasfilm has announced a January 20, 2027 premiere on Disney+.',
    sourceUrl:sw('news/ahsoka-season-2'),
    notes:'This is the announced premiere date; a Hong Kong-specific date, local release hour and title availability have not been verified.',
    evidence:[evidence(sw('news/ahsoka-season-2'),'January 20, 2027','Season 2','Disney+')],
  }),
  release({
    id:'maul-shadow-lord-season-2', title:'Star Wars: Maul – Shadow Lord (Season 2)', kind:'series',
    status:'announced', releaseDate:null, datePrecision:'unknown', platforms:[], access:'unknown',
    summary:'A second season has been announced. The cited announcement does not provide its release date.',
    sourceUrl:sw('news/star-wars-maul-shadow-lord-season-2'),
    notes:'Do not reuse the April 6, 2026 date: that date belongs to Season 1. Season 2 release timing and Hong Kong availability remain unverified.',
    evidence:[evidence(sw('news/star-wars-maul-shadow-lord-season-2'),'confirmation of Season 2','Lucasfilm Animation')],
  }),
  release({
    id:'starfighter-2027', title:'Star Wars: Starfighter', kind:'movie',
    status:'upcoming', releaseDate:'2027-05-28', platforms:['Cinemas'], access:'cinema',
    summary:'The new standalone film is announced for cinemas on May 28, 2027, including selected IMAX film locations.',
    sourceUrl:sw('news/star-wars-50-imax'),
    notes:'The announced theatrical date does not establish a Hong Kong opening date or a local IMAX booking. No streaming release date is verified.',
    evidence:[evidence(sw('news/star-wars-50-imax'),'May 28, 2027','Starfighter','IMAX')],
  }),
  release({
    id:'star-wars-1977-anniversary-2027', title:'Star Wars (1977) — 50th anniversary cinema re-release', kind:'movie',
    status:'upcoming', releaseDate:'2027-02-19', platforms:['Selected cinemas','Selected IMAX cinemas'], access:'cinema',
    summary:'An anniversary restoration of the original film is announced for a limited cinema run beginning February 19, 2027.',
    sourceUrl:sw('news/star-wars-50-imax'),
    notes:'This is a re-release, not a new film. Hong Kong participation, venues, booking links and showtimes are unverified.',
    evidence:[evidence(sw('news/star-wars-50-imax'),'February 19, 2027','anniversary re-release','select theaters')],
  }),
  release({
    id:'zero-company-2026', title:'Star Wars Zero Company', kind:'game',
    status:'released', releaseDate:'2026-08-27', platforms:['PC','PlayStation 5','Xbox Series X|S'], access:'purchase',
    summary:'The turn-based tactics game has launched. The publisher offers purchase links for PC, PlayStation and Xbox.',
    sourceUrl:sw('news/star-wars-zero-company-guide'), availabilityUrl:'https://www.ea.com/games/starwars/zero-company',
    notes:'PC stores listed by EA include the EA app, Steam and Epic Games Store. Hong Kong account availability, editions and prices are not verified.',
    evidence:[evidence(sw('news/star-wars-zero-company-guide'),'August 27, 2026','Available Now'), evidence(sw('news/star-wars-zero-company-gameplay-trailer'),'August 27, 2026','PlayStation 5','Xbox Series'), evidence('https://www.ea.com/games/starwars/zero-company','Buy Now','Steam','Epic Games')],
  }),
  release({
    id:'galactic-racer-2026', title:'Star Wars: Galactic Racer', kind:'game',
    status:'released', releaseDate:'2026-10-06', platforms:['PC','PlayStation 5','Xbox Series X|S'], access:'purchase',
    summary:'The racing game has launched for PC, PlayStation 5 and Xbox Series X|S, according to the official launch announcement.',
    sourceUrl:sw('news/star-wars-galactic-racer'), availabilityUrl:'https://starwarsgalacticracer.com/',
    notes:'The announcement says worldwide; a specific Hong Kong storefront, local price and account entitlement have not been verified. The publisher website timed out during browser verification.',
    evidence:[evidence(sw('news/star-wars-galactic-racer'),'October 6, 2026','available now worldwide','PS5','Xbox X|S','PC')],
  }),
  release({
    id:'fate-of-the-old-republic', title:'Star Wars: Fate of the Old Republic', kind:'game',
    status:'announced', releaseDate:null, datePrecision:'unknown', platforms:[], access:'unknown',
    summary:'Arcanaut Studios and Lucasfilm Games have announced a new single-player role-playing game. A release date is not verified.',
    sourceUrl:sw('news/star-wars-fate-of-the-old-republic-trailer'),
    notes:'Do not describe it as a released game, a direct KOTOR sequel or a Hong Kong store listing. Platforms and purchase availability are unverified.',
    evidence:[evidence(sw('news/star-wars-fate-of-the-old-republic-trailer'),'Arcanaut Studios','forthcoming title')],
  }),
  release({
    id:'celebration-los-angeles-2027', title:'Star Wars Celebration Los Angeles 2027', kind:'event',
    status:'upcoming', releaseDate:'2027-04-01', endDate:'2027-04-04', region:'US',
    platforms:['Los Angeles Convention Center'], access:'ticket',
    summary:'The fan convention is scheduled for April 1–4, 2027 in Los Angeles. The official ticket page currently reports sold out.',
    sourceUrl:'https://www.starwarscelebration.com/en-us/tickets-merch/ticket-information.html',
    availabilityUrl:'https://www.starwarscelebration.com/en-us/tickets-merch/ticket-information.html',
    notes:'These are Los Angeles calendar dates, not HKT event times. Do not imply tickets remain on sale; consult the organiser for any later changes. This is not a Hong Kong event.',
    evidence:[evidence('https://www.starwarscelebration.com/en-us/tickets-merch/ticket-information.html','April 1 - 4, 2027','Los Angeles Convention Center','tickets are now sold out')],
  }),
  release({
    id:'hongkong-halloween-star-wars-parade-2026', title:'Halloween Unleashed — Star Wars parade and meet-and-greet', kind:'event',
    status:'upcoming', releaseDate:'2026-10-31', endDate:'2026-10-31', region:'HK', hkAvailability:'confirmed',
    platforms:['Chater Road, Central, Hong Kong'], access:'unknown',
    summary:'Hong Kong Tourism Board lists a Star Wars parade and meet-and-greet by the 501st Hong Kong Garrison during Halloween Unleashed on October 31.',
    sourceUrl:'https://www.discoverhongkong.com/eng/events/halloween/citywide-halloween-cosplay-celebration.html',
    availabilityUrl:'https://www.halloweenincentral.com/',
    notes:'Local date is HKT. Exact parade start time and whether any specific activity requires payment are unverified; check the organiser before travelling. HKTB was browser-readable but direct HTTP returned 403, so automated revalidation may fail.',
    evidence:[evidence('https://www.discoverhongkong.com/eng/events/halloween/citywide-halloween-cosplay-celebration.html','31 October 2026','Star Wars Parade','501st Hong Kong Garrison','Chater Road'), evidence('https://www.halloweenincentral.com/','31 October 2026','Chater Road')],
  }),
];
