// 设置中心：三层来源、校验、版本与回退、面板视图（密钥只给末 4 位）、守护进程的启动失败回退
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const { SETTINGS } = await import('../server/settings/schema.js');
// 不受开发机 .env 的影响
for (const k of Object.keys(SETTINGS)) delete process.env[k];
const settings = await import('../server/settings/index.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'town-settings-'));

test('来源：保存的值 > 环境变量（只作初始值）> 默认值；没有被环境变量锁定的项', (t) => {
  const dir = tmp();
  settings.load({ dataDir: dir });
  t.after(() => { delete process.env.LLM_CONCURRENCY; settings._setForTest({}); });
  assert.equal(settings.get('LLM_CONCURRENCY'), 4);
  assert.equal(settings.source('LLM_CONCURRENCY'), 'default');
  process.env.LLM_CONCURRENCY = '2';
  assert.equal(settings.get('LLM_CONCURRENCY'), 2, '还没保存过：环境变量作为初始值');
  assert.equal(settings.source('LLM_CONCURRENCY'), 'env');
  settings.save({ LLM_CONCURRENCY: 8 }, { by: 'test' });
  assert.equal(settings.get('LLM_CONCURRENCY'), 8, '保存之后以保存的值为准');
  assert.equal(settings.source('LLM_CONCURRENCY'), 'panel');
  assert.equal(settings.view().find((x) => x.key === 'LLM_CONCURRENCY').envIgnored, true);
  process.env.LLM_CONCURRENCY = 'abc';
  assert.equal(settings.get('LLM_CONCURRENCY'), 8);
  assert.deepEqual(settings.envProblems(), [], '已经保存过的项，环境变量写错也不影响启动');
  // 按其他设置推导的默认值；启动必需的项仍然只看环境变量
  assert.equal(settings.get('LLM_DAILY_TOKENS'), 0);
  process.env.PUBLIC_MODE = '1';
  assert.equal(settings.get('LLM_DAILY_TOKENS'), 3_000_000);
  assert.equal(settings.source('PUBLIC_MODE'), 'env');
  process.env.PORT = 'x';
  assert.deepEqual(settings.envProblems(), ['PORT：应为整数']);
  delete process.env.PORT;
  delete process.env.PUBLIC_MODE;
});

test('启动时导入：还没保存过的环境变量写进设置文件；之后改环境变量不生效；恢复默认后也不再导入', (t) => {
  const dir = tmp();
  const env = { MODEL: 'glm-seed', LLM_CONCURRENCY: '6', API_KEY: 'sk-seed-12345678', PORT: '4321', STORY_RATING: 'dark' };
  Object.assign(process.env, env);
  t.after(() => { for (const k of Object.keys(env)) delete process.env[k]; settings._setForTest({}); });
  settings.load({ dataDir: dir });
  const r = settings.seedFromEnv();
  assert.deepEqual(r.imported.sort(), ['API_KEY', 'LLM_CONCURRENCY', 'MODEL'], '启动必需的项与世界级设置不导入');
  assert.equal(settings.history()[0].note, '从环境变量导入初始值');
  assert.equal(settings.source('MODEL'), 'panel');
  // 重新启动：环境变量改了，不影响已保存的值
  process.env.MODEL = 'glm-changed';
  settings.load({ dataDir: dir });
  const again = settings.seedFromEnv();
  assert.deepEqual(again.imported, []);
  assert.deepEqual(again.ignored, ['MODEL']);
  assert.equal(settings.get('MODEL'), 'glm-seed');
  assert.equal(settings.get('PORT'), 4321, '启动必需的项仍然来自环境变量');
  // 面板里改：没有锁定
  settings.save({ LLM_CONCURRENCY: 3 });
  assert.equal(settings.get('LLM_CONCURRENCY'), 3);
  // 恢复默认：不会在下次启动时又被环境变量导入
  settings.save({ MODEL: null });
  settings.load({ dataDir: dir });
  assert.deepEqual(settings.seedFromEnv().imported, []);
  assert.equal(settings.get('MODEL'), '');
  assert.equal(settings.source('MODEL'), 'default');
  // 子进程看到的是保存的值；已恢复默认的项去掉原来的环境变量
  const child = settings.env({ ...process.env });
  assert.equal(child.LLM_CONCURRENCY, '3');
  assert.equal(child.MODEL, undefined);
  assert.equal(child.API_KEY, 'sk-seed-12345678');
  // 新出现的环境变量（之前没有设置过的项）在下次启动时导入
  process.env.MODEL_FAST = 'glm-fast';
  settings.load({ dataDir: dir });
  assert.deepEqual(settings.seedFromEnv().imported, ['MODEL_FAST']);
  // 回退版本不影响「已导入」的记录
  const f = path.join(dir, 'settings.json');
  assert.ok(JSON.parse(fs.readFileSync(f, 'utf8')).seeded.includes('MODEL'));
});

test('保存：按声明校验，写错的值被拒绝；启动必需的项只能用环境变量；文件以 0600 写入', (t) => {
  const dir = tmp();
  settings.load({ dataDir: dir });
  t.after(() => settings._setForTest({}));
  assert.throws(() => settings.save({ MAX_ACTIVE_WORLDS: 0 }), (e) => e.errors?.MAX_ACTIVE_WORLDS === '不能小于 1');
  assert.throws(() => settings.save({ MAX_ACTIVE_WORLDS: 'abc' }), (e) => /应为/.test(e.errors?.MAX_ACTIVE_WORLDS));
  assert.throws(() => settings.save({ MODERATE_CHAT: 'maybe' }), (e) => /只能是 llm \/ keyword/.test(e.errors?.MODERATE_CHAT));
  assert.throws(() => settings.save({ PORT: 4000 }), /启动必需/);
  assert.throws(() => settings.save({ NOPE: 1 }), /未知/);
  // 面板提交的字符串按类型解析
  const r = settings.save({ MAX_ACTIVE_WORLDS: '6', PINNED_WORLDS: 'yunxi, little-red', ALLOW_INTERACTION: false });
  assert.deepEqual(r.changed.sort(), ['ALLOW_INTERACTION', 'MAX_ACTIVE_WORLDS', 'PINNED_WORLDS']);
  assert.equal(settings.get('MAX_ACTIVE_WORLDS'), 6);
  assert.deepEqual(settings.get('PINNED_WORLDS'), ['yunxi', 'little-red']);
  assert.equal(settings.get('ALLOW_INTERACTION'), false);
  const f = path.join(dir, 'settings.json');
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  // 没有改动时不产生新版本
  assert.equal(settings.save({ MAX_ACTIVE_WORLDS: 6 }).changed.length, 0);
  assert.equal(settings.history().length, 1);
  // null = 恢复默认
  settings.save({ MAX_ACTIVE_WORLDS: null });
  assert.equal(settings.get('MAX_ACTIVE_WORLDS'), 4);
});

test('面板视图：密钥只给末 4 位，导出不含密钥；历史版本可以恢复', (t) => {
  const dir = tmp();
  settings.load({ dataDir: dir });
  t.after(() => settings._setForTest({}));
  settings.save({ API_KEY: 'sk-abcdefgh1234', MODEL: 'glm' });
  const v1 = settings.history()[0].v;
  const key = settings.view().find((x) => x.key === 'API_KEY');
  assert.equal(key.value, '●●●● 1234');
  assert.equal(key.isSet, true);
  assert.ok(!JSON.stringify(settings.view()).includes('sk-abcdefgh'));
  assert.deepEqual(settings.exportValues(), { MODEL: 'glm' });
  assert.ok(!settings.view().some((x) => SETTINGS[x.key].dev), '开发用的设置不在面板上');
  settings.save({ MODEL: 'other' });
  assert.equal(settings.get('MODEL'), 'other');
  settings.restore(v1);
  assert.equal(settings.get('MODEL'), 'glm');
  assert.equal(settings.history().length, 3);
  // 重新读取文件，得到相同的值
  settings.load({ dataDir: dir });
  assert.equal(settings.get('MODEL'), 'glm');
  assert.equal(settings.get('API_KEY'), 'sk-abcdefgh1234');
});

test('restart 类设置：保存后提示需要重启', (t) => {
  settings.load({ dataDir: tmp() });
  t.after(() => settings._setForTest({}));
  assert.deepEqual(settings.pendingRestart(), []);
  const r = settings.save({ EMBED_MODEL: 'embedding-3', MAX_CLIENTS: 50 });
  assert.deepEqual(r.restart, ['EMBED_MODEL']);
});

test('启动失败自动回退：只回退没有被标记为正常的版本', () => {
  const dir = tmp();
  settings.load({ dataDir: dir });
  settings.save({ MODEL: 'good' });
  settings.markGood();
  settings.save({ MODEL: 'bad' });
  const f = path.join(dir, 'settings.json');
  const r = settings.rollbackToGood(f, 'boom');
  assert.equal(r.reason, 'boom');
  settings.load({ dataDir: dir });
  assert.equal(settings.get('MODEL'), 'good');
  assert.equal(settings.lastRollback().to, r.to);
  // 当前版本已经是正常的：不是设置的问题，不回退
  assert.equal(settings.rollbackToGood(f, 'again'), null);
  settings._setForTest({});
});

test('守护进程：设置导致连续启动失败时回退到上一个正常版本；请求重启（75）时立即重启', { timeout: 60_000 }, async () => {
  const dir = tmp();
  // 正常版本 + 一个让服务起不来的版本（端口号只能用环境变量，这里用一个会让入口脚本立刻失败的标记模拟）
  settings.load({ dataDir: dir });
  settings.save({ MODEL: 'ok' });
  settings.markGood();
  settings.save({ MODEL: 'crash' });
  settings._setForTest({});
  // 用一个假入口替换 index.js：读设置，MODEL=crash 时退出码 1；否则第一次以 75 请求重启，第二次正常退出
  const fake = path.join(dir, 'entry.mjs');
  const counter = path.join(dir, 'n');
  fs.writeFileSync(fake, `
import fs from 'node:fs';
import * as s from ${JSON.stringify(path.resolve('server/settings/index.js'))};
s.load();
if (s.get('MODEL') === 'crash') { console.error('模拟启动失败'); process.exit(1); }
process.send({ type: 'ready' });
const n = Number(fs.existsSync(${JSON.stringify(counter)}) ? fs.readFileSync(${JSON.stringify(counter)}, 'utf8') : 0) + 1;
fs.writeFileSync(${JSON.stringify(counter)}, String(n));
process.exit(n === 1 ? 75 : 0);
`);
  const main = fs.readFileSync('server/main.js', 'utf8')
    .replace("path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js')", JSON.stringify(fake))
    .replace("from './settings/index.js'", `from ${JSON.stringify(path.resolve('server/settings/index.js'))}`);
  const mainFile = path.join(dir, 'main.mjs');
  fs.writeFileSync(mainFile, main);
  const out = await new Promise((resolve) => {
    let log = '';
    const p = spawn(process.execPath, [mainFile], { env: { PATH: process.env.PATH, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => { log += d; });
    p.stderr.on('data', (d) => { log += d; });
    p.on('exit', (code) => resolve({ code, log }));
  });
  assert.equal(out.code, 0, out.log);
  assert.match(out.log, /已回退到版本/);
  assert.match(out.log, /服务请求重启/);
  assert.equal(fs.readFileSync(counter, 'utf8'), '2');
  settings.load({ dataDir: dir });
  assert.equal(settings.get('MODEL'), 'ok');
  assert.match(settings.lastRollback().reason, /模拟启动失败/);
  settings._setForTest({});
});
