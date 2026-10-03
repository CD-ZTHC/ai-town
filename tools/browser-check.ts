#!/usr/bin/env node
// mise run browser-check：用本机的无头 Chrome 打开小镇页面，逐个打开主要面板与三种模式，
// 收集控制台错误与未捕获的异常，并截图（前端改动后的冒烟检查，零依赖：直接走 Chrome DevTools 协议）。
//
// 用法：node tools/browser-check.ts [--out 截图目录] [--chrome Chrome 路径]
// 会在临时目录里启动一个不连模型的小镇服务器；有错误时退出码为 1。
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SETTINGS } from '../server/settings/schema.ts';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';

/** DevTools 协议的消息与返回值（结构由 Chrome 决定，只取用到的字段） */
type Cdp = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const args = process.argv.slice(2);
const opt = (k: string, d: string | undefined) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const OUT = opt('--out', fs.mkdtempSync(path.join(os.tmpdir(), 'town-shots-')))!;
const CHROME = opt('--chrome', process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => fs.existsSync(p)));
if (!CHROME) { console.error('找不到 Chrome，用 --chrome 或 CHROME 指定路径'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const procs: ChildProcess[] = [];
const cleanup = () => { for (const p of procs) try { p.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);
// 看门狗：某条 DevTools 命令一直没有回应时，整个检查不会无限挂着（正常跑完约 3 分钟）。
// 注意：macOS 空闲睡眠时进程会被冻结、看起来像卡住——长时间运行请用 caffeinate -i node tools/browser-check.ts
let stage = '启动';
setTimeout(() => { console.error(`✖ 检查超时（10 分钟），卡在：${stage}`); process.exit(1); }, 10 * 60_000).unref();

async function waitFor<T>(fn: () => T | Promise<T>, ms: number, what: string): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v as NonNullable<T>; } catch {}
    if (Date.now() > end) throw new Error(`等待超时：${what}`);
    await sleep(150);
  }
}

// 1. 小镇服务器（临时存档、不连模型）
/** 向系统要一个空闲端口（随机挑的端口可能正被本机别的程序占着） */
const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port: p } = srv.address() as AddressInfo; srv.close(() => resolve(p)); });
});
const port = await freePort();
const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'town-bc-')) };
// 不受开发机 .env 的影响：只保留上面的几项
for (const k of Object.keys(SETTINGS)) if (!['PORT', 'HOST', 'DATA_DIR'].includes(k)) delete env[k];
const server = spawn(process.execPath, ['server/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
procs.push(server);
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const base = `http://127.0.0.1:${port}`;
await waitFor(() => fetch(`${base}/w/yunxi/`).then((r) => r.ok), 15000, '小镇服务器启动');

// 2. 无头 Chrome。连上以后先探一下：10 秒内对 DevTools 命令没有回应就换一个 Chrome 重来（最多 3 次）
async function openChrome(): Promise<WebSocket> {
  const chrome = spawn(CHROME!, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'town-chrome-'))}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1400,900', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  procs.push(chrome);
  let chromeErr = '';
  chrome.stderr!.on('data', (d) => (chromeErr += d));
  try {
    const wsUrl = await waitFor(() => /DevTools listening on (ws:\/\/\S+)/.exec(chromeErr)?.[1], 15000, 'Chrome 启动');
    const devtools = new URL(wsUrl);
    const pageWs = await waitFor(async () => {
      const list = await (await fetch(`http://${devtools.host}/json/list`)).json();
      return list.find((t: Cdp) => t.type === 'page')?.webSocketDebuggerUrl as string | undefined;
    }, 10000, '页面');
    const sock = new WebSocket(pageWs);
    await new Promise((r, j) => { sock.onopen = r; sock.onerror = j; setTimeout(() => j(new Error('DevTools 连接超时')), 15000); });
    await new Promise<void>((r, j) => {
      sock.onmessage = (ev) => { if (JSON.parse(ev.data).id === -1) r(); };
      setTimeout(() => j(new Error('Chrome 对 DevTools 命令没有回应')), 10000);
      sock.send(JSON.stringify({ id: -1, method: 'Runtime.evaluate', params: { expression: '1' } }));
    });
    return sock;
  } catch (e) {
    try { chrome.kill('SIGKILL'); } catch {}
    throw e;
  }
}

// 3. DevTools 协议
stage = 'DevTools 连接';
let ws!: WebSocket;
for (let attempt = 1; ; attempt++) {
  try { ws = await openChrome(); break; } catch (e) {
    if (attempt >= 3) throw e;
    console.error(`  Chrome 没有响应（${(e as Error).message}），重新启动（第 ${attempt + 1} 次）`);
  }
}
let seq = 0;
const pending = new Map<number, { resolve: (r: Cdp) => void; reject: (e: Error) => void }>();
const problems: string[] = [];
const net: Array<{ id: string; url: string; status: number; cached: boolean }> = []; // 资源版本检查用：页面加载时的每个响应 { url, status, cached }
const cachedIds = new Set();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)!;
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method === 'Network.responseReceived') {
    const r = msg.params.response;
    net.push({ id: msg.params.requestId, url: r.url, status: r.status, cached: Boolean(r.fromDiskCache || r.fromMemoryCache) });
  } else if (msg.method === 'Network.requestServedFromCache') {
    cachedIds.add(msg.params.requestId);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    problems.push(`异常：${d.exception?.description || d.text}（${d.url || ''}:${d.lineNumber}）`);
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    problems.push(`console.error：${msg.params.args.map((a: Cdp) => a.value ?? a.description).join(' ')}`);
  } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    const e = msg.params.entry;
    // favicon 之类的 404 与本次检查无关
    // 游客调用互动接口的 401 是设计好的流程（弹出登录框），不算错误
    if (!/favicon/.test(e.url || '') && !/status of 401/.test(e.text)) problems.push(`日志：${e.text}${e.url ? `（${e.url}）` : ''}`);
  }
};
const send = (method: string, params: object = {}) => new Promise<Cdp>((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools 命令没有回应：${method}`)); }, 30_000);
  const t0 = Date.now();
  const slow = () => { if (process.env.BC_DEBUG && Date.now() - t0 > 2000) process.stderr.write(`    慢：${method} ${Date.now() - t0}ms\n`); };
  pending.set(id, { resolve: (r) => { clearTimeout(timer); slow(); resolve(r); }, reject: (e) => { clearTimeout(timer); slow(); reject(e); } });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr: string) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const shot = async (name: string) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
};
const key = async (k: string) => {
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: `Key${k.toUpperCase()}`, text: type === 'keyDown' ? k : undefined, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
};
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

const steps: Array<{ name: string; errors: string[] }> = [];
async function step(name: string, fn: () => Promise<unknown>, { wait = 700, screenshot = true }: { wait?: number; screenshot?: boolean } = {}) {
  const before = problems.length;
  stage = name;
  const t0 = Date.now();
  try {
    await fn();
    await sleep(wait);
    if (screenshot) await shot(name);
  } catch (e) {
    problems.push(`步骤「${name}」出错：${(e as Error).message}`);
  }
  steps.push({ name, errors: problems.slice(before) });
  // 边走边报（最后还有汇总）：卡住或超时时能看出前面走到了哪、每步多久
  process.stderr.write(`  · ${name} ${Date.now() - t0}ms${problems.length > before ? ' ✖' : ''}\n`);
}
const click = (sel: string) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('找不到 ${sel}'); el.click(); return true; })()`);
const modalHas = (min = 20) => evaluate(`(() => { const m = document.querySelector('#modal'); return !m.hidden && document.querySelector('#modal-card').textContent.trim().length >= ${min}; })()`);
const closeModal = () => evaluate(`document.querySelector('#modal').hidden = true`);

// 4. 逐个打开主要界面
await step('01-observe', async () => {
  // 先跳过首次访问的说明弹窗（它会挡住后面的截图；说明面板本身在 08-help 里单独检查）
  await send('Page.navigate', { url: `${base}/w/yunxi/?mode=observe` });
  await waitFor(() => evaluate(`document.readyState === 'complete'`), 15000, '页面加载');
  await evaluate(`localStorage.setItem('town-help-seen', '1')`);
  await send('Page.navigate', { url: `${base}/w/yunxi/?mode=observe` });
  await waitFor(() => evaluate(`document.querySelectorAll('#roster .rcard').length >= 8`), 15000, '名册渲染');
  await waitFor(() => evaluate(`document.querySelector('#festival-chip').textContent.includes('萤火节')`), 8000, '活动标签');
}, { wait: 1500 });
await step('02-inspector', async () => {
  await click('#roster .rcard[data-id="lin"]');
  await waitFor(() => evaluate(`!document.querySelector('#inspector').hidden && document.querySelector('#insp-body').textContent.includes('林晓雨')`), 8000, '检查器');
  for (const tab of ['sched', 'mem', 'rel', 'diary', 'chat', 'attr']) await evaluate(`document.querySelector('#insp-body [data-t="${tab}"]')?.click()`);
});
await step('03-story', async () => { await click('#story-chip'); await waitFor(() => modalHas(), 8000, '故事面板'); });
await step('04-build', async () => { await closeModal(); await click('#btn-build'); await waitFor(() => modalHas(), 8000, '建设面板'); });
await step('04b-evolve', async () => { await closeModal(); await click('#btn-evolve'); await waitFor(() => evaluate(`!document.querySelector('#modal').hidden && !document.querySelector('#evo-body')?.textContent.includes('正在读取')`), 8000, '进化面板'); });
await step('05-news', async () => { await closeModal(); await click('#btn-news'); await waitFor(() => modalHas(4), 8000, '日报'); });
await step('06-graph', async () => { await closeModal(); await click('#btn-graph'); await waitFor(() => modalHas(4), 8000, '关系网'); });
await step('07-event', async () => { await closeModal(); await click('#btn-event'); await waitFor(() => modalHas(), 8000, '发布事件'); });
await step('08-help', async () => { await closeModal(); await click('#more-menu [data-cmd="help"]'); await waitFor(() => modalHas(), 8000, '说明'); });
await step('09-weather', async () => {
  await closeModal();
  await click('#btn-weather');
  await waitFor(() => evaluate(`!document.querySelector('#weather-menu').hidden && document.querySelectorAll('#weather-menu button').length > 3`), 5000, '天气菜单');
  // 菜单要完整地出现在屏幕里（按钮在底部 Dock 时应向上展开）
  const box = await evaluate(`(() => { const r = document.querySelector('#weather-menu').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vh: innerHeight, vw: innerWidth }; })()`);
  if (box.top < 0 || box.bottom > box.vh || box.left < 0 || box.right > box.vw) throw new Error(`天气菜单超出屏幕：${JSON.stringify(box)}`);
});
await step('10-brain', async () => { await evaluate(`document.querySelector('#weather-menu').hidden = true`); await click('#brain-btn'); await waitFor(() => evaluate(`document.querySelector('#brain-stats').textContent.length > 0`), 5000, 'AI 大脑'); });
await step('11-immerse', async () => {
  await send('Page.navigate', { url: `${base}/w/yunxi/?mode=immerse` });
  await waitFor(() => evaluate(`document.body.dataset.mode === 'immerse'`), 15000, '沉浸模式');
}, { wait: 2500 });
await step('12-charcard', async () => {
  await send('Page.navigate', { url: `${base}/w/yunxi/?mode=play` });
  // 第一次进游戏模式要先填角色卡（本地模式用内置账号的昵称，只挑衣服）
  await waitFor(() => evaluate(`Boolean(document.querySelector('#cc-go'))`), 15000, '角色卡');
  await evaluate(`document.querySelector('#cc-name') && (document.querySelector('#cc-name').value = '测试旅人'), true`);
});
await step('13-play', async () => {
  await click('#cc-go');
  await waitFor(() => evaluate(`document.body.dataset.mode === 'play'`), 10000, '游戏模式');
  await key('w');
}, { wait: 1500 });
await step('18-little-red', async () => {
  await send('Page.navigate', { url: `${base}/w/little-red/?mode=observe` });
  await waitFor(() => evaluate(`document.querySelectorAll('#roster .rcard').length >= 5 && document.title.includes('小红帽')`), 15000, '小红帽世界');
  // 顶栏活动标签与点击提示用的是这个世界自己的日历活动，而不是云溪镇的萤火节
  await waitFor(() => evaluate(`document.querySelector('#festival-chip').textContent.includes('外婆生日')`), 8000, '活动标签');
  await click('#festival-chip');
  const tip = await evaluate(`document.querySelector('#toasts').lastElementChild?.textContent || ''`);
  if (!tip.includes('外婆生日') || tip.includes('萤火')) throw new Error(`活动提示不对：${tip}`);
}, { wait: 1500 });
await step('18b-people', async () => {
  // 故事面板的「人来人往」：请一个人离开，再召回（本地模式即管理员；confirm 直接放行）
  await evaluate(`window.confirm = () => true`);
  await click('#story-chip');
  await waitFor(() => evaluate(`Boolean(document.querySelector('.stabs [data-t="people"]'))`), 8000, '故事面板');
  await click('.stabs [data-t="people"]');
  await waitFor(() => evaluate(`document.querySelectorAll('[data-pdep]').length >= 5`), 8000, '在场的人');
  if (await evaluate(`Boolean(document.querySelector('#story-body').textContent.includes('镜湖裂隙'))`)) throw new Error('小红帽的故事面板里出现了云溪镇的剧情弧');
  await click('[data-pdep="hunter"]');
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-prec="hunter"]'))`), 8000, '出门在外');
  await click('[data-prec="hunter"]');
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-pdep="hunter"]'))`), 8000, '召回');
}, { wait: 800 });
await step('18c-buildings', async () => {
  // 地图演变：停业、受损、废墟的画面（本地模式即管理员，直接应用世界操作）
  await closeModal();
  await evaluate(`Promise.all([
    app.api('/api/world/op', { op: 'setBuildingState', args: { id: 'bakery', state: 'closed' } }),
    app.api('/api/world/op', { op: 'setBuildingState', args: { id: 'red_house', state: 'damaged' } }),
    app.api('/api/world/op', { op: 'setBuildingState', args: { id: 'wolf_den', state: 'ruin', remap: { residents: 'hunter_cabin' } } }),
  ]).then(() => true)`);
  await waitFor(() => evaluate(`app.world.buildings.find((b) => b.id === 'wolf_den')?.state === 'ruin' && app.world.buildings.find((b) => b.id === 'bakery')?.state === 'closed'`), 8000, '地图重建');
  // 地形：新的户外地点与一条穿过树林的路（管理员直接提交提案，由系统求解位置）
  await evaluate(`app.api('/api/proposals/direct', { title: '花园与小路', ops: [
    { op: 'addOutdoorPlace', args: { id: 'honey_garden', kind: 'garden', name: '蜂蜜花园', emoji: '🌼', desc: '村口新辟的小花园', near: 'village_square' } },
    { op: 'addPath', args: { from: 'village_square', to: 'hunter_cabin', surface: 'dirt' } } ] }).then(() => true)`);
  await waitFor(() => evaluate(`Boolean(app.world.locations.honey_garden)`), 8000, '新地点');
  await evaluate(`(() => { const r = app.world.locations.honey_garden.rect; app.follow = null; app.cam.x = (r.x + r.w / 2) * 32; app.cam.y = (r.y + r.h / 2) * 32; return true; })()`);
}, { wait: 1200 });
await step('18d-expand', async () => {
  // 地图扩展：向西长出一片新地方（原来的一切整体平移），镜头移到新地块
  await evaluate(`app.api('/api/world/op', { op: 'expandMap', args: { side: 'west', by: 16, biome: 'autumn', name: '西坡', seed: 7, places: [
    { id: 'west_inn', kind: 'inn', name: '西坡客栈' }, { id: 'west_orchard', kind: 'orchard', name: '苹果园' }, { id: 'west_cottage', kind: 'cottage', name: '新来的小屋' } ] } }).then(() => true)`);
  await waitFor(() => evaluate(`app.world.W === 80 && Boolean(app.world.locations.west_inn)`), 8000, '地图扩展');
  await evaluate(`(() => { const b = app.world.buildings.find((x) => x.id === 'west_inn'); app.follow = null; app.cam.x = (b.x + 6) * 32; app.cam.y = (b.y + 4) * 32; return true; })()`);
}, { wait: 1200 });
await step('18e-adjacent', async () => {
  // 相邻的地图：东边连上一张「城东」，打开区域菜单切过去
  const id = await evaluate(`app.api('/api/proposals/direct', { title: '东边的新街区', ops: [{ op: 'addAdjacentRegion', args: { id: 'chengdong', name: '城东', side: 'east', length: 40, fromName: '城中', biome: 'village',
    areas: [{ id: 'cd_a', size: 'large', places: [{ id: 'cd_market', kind: 'market', name: '东市' }, { id: 'cd_inn', kind: 'inn', name: '东门客栈' }, { id: 'cd_house', kind: 'house', name: '新街小屋' }] }] } }] }).then((r) => r.id, (e) => { console.log('direct', e.message); return null; })`);
  if (!id) throw new Error('提交相邻地图的提案失败');
  await waitFor(() => evaluate(`app.api('/api/proposals').then((d) => d.proposals.find((p) => p.id === '${id}')?.status === 'awaiting')`), 8000, '等待终审').catch(async (e) => {
    throw new Error(`${e.message}：${await evaluate(`app.api('/api/proposals').then((d) => JSON.stringify(d.proposals.find((p) => p.id === '${id}')?.status + ' ' + JSON.stringify(d.proposals.find((p) => p.id === '${id}')?.result)))`)}`);
  });
  await evaluate(`app.api('/api/proposals/decide', { id: '${id}', approve: true }).then(() => true)`);
  await waitFor(() => evaluate(`Boolean(app.regionWorlds.chengdong) && !document.querySelector('#region-chip').hidden`), 10000, '区域菜单');
  await click('#region-chip');
  await waitFor(() => evaluate(`document.querySelectorAll('#region-menu [data-region]').length >= 2`), 5000, '菜单');
  await click('#region-menu [data-region="chengdong"]');
  await waitFor(() => evaluate(`app.view === 'chengdong'`), 5000, '切到城东');
  await evaluate(`(() => { const p = app.world.passages[0]; app.cam.x = (p.x + 8) * 32; app.cam.y = p.y * 32; return true; })()`);
}, { wait: 1200 });
await step('19-genesis', async () => {
  await send('Page.navigate', { url: `${base}/genesis.html` });
  await waitFor(() => evaluate(`Boolean(document.querySelector('#go'))`), 10000, '创世向导');
  await evaluate(`(() => { const i = document.querySelector('#wid'); i.value = 'little-red'; i.dispatchEvent(new Event('input')); return true; })()`);
  await waitFor(() => evaluate(`document.querySelector('#wid-msg').textContent.length > 0`), 5000, '短名检查');
});
await step('20-mine', async () => {
  await send('Page.navigate', { url: `${base}/mine.html` });
  await waitFor(() => evaluate(`document.querySelector('#app').textContent.includes('还没有创建世界')`), 10000, '我的世界');
});
await step('15-lobby', async () => {
  await send('Page.navigate', { url: `${base}/` });
  await waitFor(() => evaluate(`document.querySelectorAll('.world-card').length >= 1`), 10000, '世界大厅');
});
await step('14-admin-settings', async () => {
  await send('Page.navigate', { url: `${base}/admin/#settings` });
  await waitFor(() => evaluate(`document.querySelectorAll('.setting').length > 20`), 10000, '管理面板 · 设置');
  // 改一项，保存按钮可用
  await evaluate(`(() => { const i = document.querySelector('[data-k="MAX_CLIENTS"]'); i.value = '150'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await waitFor(() => evaluate(`!document.querySelector('#s-save').disabled`), 3000, '保存按钮');
});
await step('16-admin-llm', async () => {
  await send('Page.navigate', { url: `${base}/admin/#llm` });
  await waitFor(() => evaluate(`document.querySelector('#page')?.textContent.includes('队列')`), 10000, '管理面板 · 调度');
});
await step('17-admin-worlds', async () => {
  await send('Page.navigate', { url: `${base}/admin/#worlds` });
  await waitFor(() => evaluate(`document.querySelector('#page')?.textContent.includes('yunxi')`), 10000, '管理面板 · 世界');
});
await step('21-admin-overview', async () => {
  await send('Page.navigate', { url: `${base}/admin/#overview` });
  await waitFor(() => evaluate(`document.querySelector('#page')?.textContent.includes('运行中的世界')`), 10000, '管理面板 · 概览');
});
await step('22-admin-reports', async () => {
  await send('Page.navigate', { url: `${base}/admin/#reports` });
  await waitFor(() => evaluate(`document.querySelector('#page')?.textContent.includes('举报')`), 10000, '管理面板 · 举报');
});
await step('23-admin-evolution', async () => {
  await send('Page.navigate', { url: `${base}/admin/#evolution` });
  await waitFor(() => evaluate(`document.querySelector('#page')?.textContent.includes('进化引擎')`), 10000, '管理面板 · 进化');
});
// 按世界配置模型服务：站点凭据、官方世界改用它、调度页的通道表、世界的 AI 设置与世界设置对话框
await step('25-admin-site-credentials', async () => {
  const post = (url: string, body: unknown, method = 'POST') => fetch(`${base}/${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const c = await post('api/admin/llm-credentials', { name: '巡检用网关', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-browser-check-0000' });
  const r = await post('api/worlds/yunxi/ai', { source: 'own', credential: c.credential.id, models: { default: 'check-model' } }, 'PUT');
  if (!r.ok) throw new Error(`绑定失败：${JSON.stringify(r)}`);
  await send('Page.navigate', { url: `${base}/admin/#llm` });
  await waitFor(() => evaluate(`document.querySelector('#site-creds')?.textContent.includes('巡检用网关')`), 10000, '站点凭据');
  if (await evaluate(`document.body.innerHTML.includes('sk-browser-check-0000')`)) throw new Error('页面上出现了密钥原文');
  await evaluate(`document.querySelector('#site-creds').scrollIntoView(), true`);
});
await step('26-admin-ai-dialog', async () => {
  await send('Page.navigate', { url: `${base}/admin/#worlds` });
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-ai="yunxi"]'))`), 10000, '世界列表');
  await evaluate(`document.querySelector('[data-ai="yunxi"]').click(), true`);
  await waitFor(() => evaluate(`document.querySelector('.dialog [name="m-default"]')?.value === 'check-model'`), 10000, 'AI 设置对话框');
});
await step('27-admin-world-settings', async () => {
  await send('Page.navigate', { url: `${base}/admin/#worlds` });
  await evaluate(`location.reload(), true`); // 同一个地址只改 hash 不会刷新：先关掉上一步的对话框
  await sleep(500);
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-settings="night-watch"]'))`), 10000, '世界列表');
  await evaluate(`document.querySelector('[data-settings="night-watch"]').click(), true`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.dialog [name="rating"]'))`), 10000, '世界设置对话框');
});
await step('28-genesis-ai', async () => {
  await send('Page.navigate', { url: `${base}/genesis.html` });
  await waitFor(() => evaluate(`Boolean(document.querySelector('#ai-pick [name="source"]'))`), 10000, '创世向导 · 选择模型');
  await evaluate(`document.querySelector('#ai-pick').scrollIntoView({ block: 'center' }), true`);
});
// 前端资源版本（重构方案 §7.6）：二次打开页面时脚本与样式全部命中浏览器缓存；发现新版本时出现提示条
await step('29-asset-cache', async () => {
  await send('Network.enable');
  for (const page of ['lobby.html', 'admin/', 'w/yunxi/?mode=observe']) {
    await send('Page.navigate', { url: `${base}/${page}` });
    await waitFor(() => evaluate(`document.readyState === 'complete'`), 15000, '页面加载');
    await sleep(800);
    // 先离开再回来（同一个 URL 直接导航会被当成「刷新」）
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(300);
    net.length = 0;
    await send('Page.navigate', { url: `${base}/${page}` });
    await waitFor(() => evaluate(`document.readyState === 'complete'`), 15000, '再次加载');
    await sleep(800);
    const fetched = net.filter((r) => /\.(js|css)(\?|$)/.test(r.url) && r.url.startsWith(base) && !r.cached && !cachedIds.has(r.id));
    if (fetched.length) throw new Error(`${page} 二次打开时仍从服务器取了 ${fetched.length} 个脚本 / 样式：${fetched.slice(0, 3).map((r) => r.url.replace(base, '')).join('、')}`);
    const unversioned = net.filter((r) => /\.(js|css)(\?|$)/.test(r.url) && r.url.startsWith(base) && !/[?&]v=[0-9a-f]{10}/.test(r.url));
    if (unversioned.length) throw new Error(`${page} 有没带版本的资源（import map 漏项？）：${unversioned.slice(0, 3).map((r) => r.url.replace(base, '')).join('、')}`);
    // 版本没变：不能误报「已更新」（等页面发出过接口请求、收到过 SSE 的 init）
    await sleep(1500);
    if (await evaluate(`Boolean(document.querySelector('#version-bar'))`)) throw new Error(`${page} 版本没变却出现了更新提示`);
  }
  await send('Network.disable');
}, { screenshot: false });
await step('30-update-notice', async () => {
  // 模拟服务端换了版本（真实场景来自 SSE init / X-Build / api/build）：提示条出现；有输入内容时不自动刷新
  await evaluate(`import('./js/version.js').then((v) => { v.seen('ffffffffff'); return true; })`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('#version-bar'))`), 3000, '更新提示条');
}, { wait: 300 });
// 公网模式：游客点互动入口 → 弹出登录框 → 注册 → 自动继续刚才的操作（现身）
const pubPort = await freePort();
const pub = spawn(process.execPath, ['server/index.ts'], { env: { ...env, PORT: String(pubPort), PUBLIC_MODE: '1', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'town-bc-pub-')) }, stdio: ['ignore', 'pipe', 'pipe'] });
procs.push(pub);
pub.stdout.on('data', (d) => (serverLog += d));
pub.stderr.on('data', (d) => (serverLog += d));
const pubBase = `http://127.0.0.1:${pubPort}`;
await waitFor(() => fetch(`${pubBase}/w/yunxi/`).then((r) => r.ok), 15000, '公网模式服务器启动');
await step('24-public-login', async () => {
  await send('Page.navigate', { url: `${pubBase}/w/yunxi/?mode=observe` });
  await waitFor(() => evaluate(`Boolean(window.app?.perms?.loginToInteract)`), 15000, '游客身份');
  // 游客现身：先弹出登录框
  await evaluate(`(window.__av = app.api('/api/avatar', { color: '#64b5f6' }).then((r) => r.avatar.name, (e) => 'ERR ' + e.message), true)`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('#auth-form'))`), 5000, '登录框');
  await evaluate(`document.querySelector('#auth-switch').click(), true`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('#auth-form input[name="nickname"]'))`), 5000, '注册表单');
  await evaluate(`(() => { const f = document.querySelector('#auth-form'); f.username.value = 'browser_check'; f.nickname.value = '巡检员'; f.password.value = 'correct-horse-9'; f.requestSubmit(); return true; })()`);
  const name = await waitFor(() => evaluate(`window.__av instanceof Promise ? window.__av.then((x) => x) : null`), 10000, '注册后自动继续现身');
  if (name !== '巡检员') throw new Error(`现身结果：${name}`);
});

ws.close();
cleanup();
for (const s of steps) console.log(`${s.errors.length ? '✖' : '✔'} ${s.name}${s.errors.length ? `\n    ${s.errors.join('\n    ')}` : ''}`);
const extra = problems.filter((p) => !steps.some((s) => s.errors.includes(p)));
if (extra.length) console.log(`其他错误：\n    ${extra.join('\n    ')}`);
if (steps.some((x) => x.errors.length)) { const api = serverLog.split('\n').filter((l) => l.includes('[api]')).slice(-5); if (api.length) console.log(`服务端错误：\n    ${api.join('\n    ')}`); }
if (/Error|错误/.test(serverLog) && /at .*\.js:\d+/.test(serverLog)) console.log(`服务器日志里有异常：\n${serverLog.slice(-2000)}`);
console.log(`\n截图：${OUT}\n${problems.length ? `✖ 共 ${problems.length} 个错误` : '✔ 没有错误'}`);
process.exit(problems.length ? 1 : 0);
