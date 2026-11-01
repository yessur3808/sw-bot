// Verified account directory only. These profiles are NOT active feeds.
// Identity evidence is not evidence of API access or successful timeline reads.
const account=(id,title,platform,handle,url,evidenceUrl,topic='global_events',region='global')=>({id,title,platform,handle,url,evidenceUrl,topic,region,identityVerifiedAt:'2026-10-29'});
export const SOCIAL_SOURCES=[
 account('social-x-starwars','Star Wars · X','X','starwars','https://x.com/starwars','https://www.starwars.com/news'),
 account('social-instagram-starwars','Star Wars · Instagram','Instagram','starwars','https://www.instagram.com/starwars/','https://www.starwars.com/news'),
 account('social-instagram-lucasfilm','Lucasfilm · Instagram','Instagram','lucasfilm','https://www.instagram.com/lucasfilm/','https://www.lucasfilm.com/'),
 account('social-x-eastarwars','EA Star Wars · X','X','EAStarWars','https://x.com/EAStarWars','https://www.ea.com/games/starwars/zero-company','gaming'),
 account('social-instagram-eastarwars','EA Star Wars · Instagram','Instagram','EAStarWars','https://www.instagram.com/EAStarWars/','https://www.ea.com/games/starwars/zero-company','gaming'),
 account('social-x-celebration','Star Wars Celebration · X','X','SW_Celebration','https://x.com/SW_Celebration','https://www.starwarscelebration.com/'),
 account('social-instagram-celebration','Star Wars Celebration · Instagram','Instagram','StarWarsCelebration','https://www.instagram.com/StarWarsCelebration/','https://www.starwarscelebration.com/'),
 account('social-instagram-broadway','Broadway Circuit · Instagram','Instagram','broadway_circuit','https://www.instagram.com/broadway_circuit/','https://www.cinema.com.hk/en','movies','HK'),
 account('social-instagram-hktb','Hong Kong Tourism Board · Instagram','Instagram','discoverhongkong','https://www.instagram.com/discoverhongkong/','https://www.discoverhongkong.com/eng/events/hong-kong-winterfest.html','hongkong','HK'),
 account('social-instagram-hkdl','Hong Kong Disneyland · Instagram','Instagram','hkdisneyland','https://www.instagram.com/hkdisneyland/','https://news.hongkongdisneyland.com/en/hong-kong-disneyland-resort-to-launch-its-15th-anniversary-celebration-on-november-21/','hongkong','HK'),
];
