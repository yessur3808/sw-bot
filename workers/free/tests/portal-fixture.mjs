import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
export function portalFixture(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../schema.sql',import.meta.url),'utf8'));
 for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
 sqlite.exec("INSERT INTO deployment_identity VALUES (1,'-100123','test'); INSERT INTO topic_map VALUES ('lore',6),('movies',4);");
 const DB={prepare(sql){let args=[];const statement={bind(...a){args=a;return statement;},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){const results=sqlite.prepare(sql).all(...args);return {results,meta:{changes:sqlite.prepare('SELECT changes() n').get().n}};}};return statement;},async batch(items){sqlite.exec('BEGIN');try{const out=[];for(const s of items)out.push(await s.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 return {sqlite,env:{DB,GROUP_ID:'-100123',DEPLOYMENT_ENV:'test',BOT_TOKEN:'123:fake',BOT_USERNAME:'SIU_M8_bot',WEBHOOK_SECRET:'test-secret',ADMIN_USER_IDS:'42',EXPECTED_WEBHOOK_URL:'https://bot.example/telegram',AI_MODEL:'fixture',AI:{async run(){return {response:'Which droid would run the best cantina?'};}}}};
}
