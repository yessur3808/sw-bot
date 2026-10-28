import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const readConfig = name => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
const production = readConfig('wrangler.production.jsonc');
const testing = readConfig('wrangler.jsonc');
const testGroupId = '-1004441702993';

test('production deploys to a separate Worker with its own webhook destination', () => {
  assert.equal(testing.name, 'sw-bot-test');
  assert.equal(production.name, 'sw-bot-production');
  assert.notEqual(production.name, testing.name);
  assert.equal(production.workers_dev, true);
  const webhook = new URL(production.vars.EXPECTED_WEBHOOK_URL);
  assert.equal(webhook.href, 'https://sw-bot-production.yaser3808.workers.dev/telegram');
  assert.equal(webhook.hostname, `${production.name}.yaser3808.workers.dev`);
  assert.notEqual(webhook.hostname, `${testing.name}.yaser3808.workers.dev`);
});

test('production retains its dedicated D1 identity and never binds the test database', () => {
  assert.equal(production.d1_databases.length, 1);
  const database = production.d1_databases[0];
  assert.equal(database.binding, 'DB');
  assert.equal(database.database_name, 'sw-bot-production');
  assert.equal(database.database_id, 'dea947f5-8a8f-4e52-971f-31a07620af84');
  assert.equal(database.migrations_dir, 'migrations');
  for (const testDatabase of testing.d1_databases) {
    assert.notEqual(database.database_name, testDatabase.database_name);
    assert.notEqual(database.database_id, testDatabase.database_id);
  }
});

test('prepared production is disabled and has no inherited group, topics or secrets', () => {
  assert.equal(production.vars.DEPLOYMENT_ENV, 'production');
  assert.equal(production.vars.DEPLOYMENT_ENABLED, 'false');
  assert.equal(production.vars.GROUP_ID, '');
  assert.notEqual(production.vars.GROUP_ID, testGroupId);
  assert.ok(!JSON.stringify(production).includes(testGroupId));
  assert.equal(production.vars.ADMIN_USER_IDS, '1678078373');
  assert.equal(production.vars.BOT_USERNAME, 'SIU_M8_bot');
  assert.equal(production.vars.ALLOWED_THREAD_IDS, '');
  assert.equal(production.vars.PRIVATE_THREAD_ID, '0');
  assert.equal(production.vars.PROACTIVE_THREAD_ID, '0');
  for (const secret of ['BOT_TOKEN', 'WEBHOOK_SECRET']) {
    assert.equal(Object.hasOwn(production.vars, secret), false);
    assert.equal(Object.hasOwn(production, secret), false);
  }
});

test('production readiness requires all seven live topic categories', () => {
  const topics = production.vars.REQUIRED_TOPICS.split(',').map(topic => topic.trim());
  assert.deepEqual(topics.sort(), [
    'gaming', 'movies', 'lore', 'hongkong', 'global_events', 'memes', 'wallpapers',
  ].sort());
});

test('production identity preparation targets production, pauses it and rejects the test group', () => {
  const script = fileURLToPath(new URL('../scripts/production-identity.mjs', import.meta.url));
  const generate = group => spawnSync(process.execPath, [script, group], {encoding: 'utf8'});
  // This script only prints SQL. No database or network is accessed.
  const result = generate('-1001234567890');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('sw-bot-production (dea947f5-8a8f-4e52-971f-31a07620af84)'));
  assert.match(result.stdout, /INSERT OR IGNORE INTO deployment_identity\(id,group_id,environment\) VALUES\(1,'-1001234567890','production'\)/);
  assert.match(result.stdout, /VALUES\('paused','1'\) ON CONFLICT\(key\) DO UPDATE SET value='1'/);
  const rejected = generate(testGroupId);
  assert.notEqual(rejected.status, 0);
  assert.equal(rejected.stdout, '');
  assert.match(rejected.stderr, /Supply the real group ID, not the test group/);
});
