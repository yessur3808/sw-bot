// Prints SQL only: inspect it, then execute against the production D1 database.
// Refuses test destinations and refuses to change any existing identity.
import {readFileSync} from 'node:fs';
const config=JSON.parse(readFileSync(new URL('../wrangler.production.jsonc',import.meta.url),'utf8'));
const group=process.argv[2];
if(!/^-100\d+$/.test(group||'')||group==='-1004441702993')throw Error('Supply the real group ID, not the test group');
if(config.d1_databases[0].database_id==='fc9c66e4-71bb-4e78-9d34-ec665fd313b4')throw Error('Production config points at the test database');
console.log(`-- Execute only against ${config.d1_databases[0].database_name} (${config.d1_databases[0].database_id}).
-- Existing identity is deliberately never overwritten. Verify the SELECT result.
INSERT OR IGNORE INTO deployment_identity(id,group_id,environment) VALUES(1,'${group}','production');
INSERT INTO settings(key,value) VALUES('paused','1') ON CONFLICT(key) DO UPDATE SET value='1';
SELECT group_id,environment FROM deployment_identity WHERE id=1;`);
