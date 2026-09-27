#!/usr/bin/env node
// mise run browser-check：用本机的无头 Chrome 打开小镇页面，逐个打开主要面板与三种模式，
// 收集控制台错误与未捕获的异常，并截图（前端改动后的冒烟检查，零依赖：直接走 Chrome DevTools 协议）。
//
// 用法：node tools/browser-check.js [--out 截图目录] [--chrome Chrome 路径]
// 会在临时目录里启动一个不连模型的小镇服务器；有错误时退出码为 1。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SETTINGS } from '../server/settings/schema.js';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const OUT = opt('--out', fs.mkdtempSync(path.join(os.tmpdir(), 'town-shots-')));
const CHROME = opt('--chrome', process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((p) => fs.existsSync(p)));
if (!CHROME) { console.error('找不到 Chrome，用 --chrome 或 CHROME 指定路径'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const cleanup = () => { for (const p of procs) try { p.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() > end) throw new Error(`等待超时：${what}`);
    await sleep(150);
  }
}

// 1. 小镇服务器（临时存档、不连模型）
const port = 3900 + Math.floor(Math.random() * 90);
const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'town-bc-')) };
// 不受开发机 .env 的影响：只保留上面的几项
for (const k of Object.keys(SETTINGS)) if (!['PORT', 'HOST', 'DATA_DIR'].includes(k)) delete env[k];
const server = spawn(process.execPath, ['server/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
procs.push(server);
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const base = `http://127.0.0.1:${port}`;
await waitFor(() => fetch(`${base}/`).then((r) => r.ok), 15000, '小镇服务器启动');

// 2. 无头 Chrome
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'town-chrome-'))}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1400,900', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
procs.push(chrome);
let chromeErr = '';
chrome.stderr.on('data', (d) => (chromeErr += d));
const wsUrl = await waitFor(() => /DevTools listening on (ws:\/\/\S+)/.exec(chromeErr)?.[1], 15000, 'Chrome 启动');
const devtools = new URL(wsUrl);
const pageWs = await waitFor(async () => {
  const list = await (await fetch(`http://${devtools.host}/json/list`)).json();
  return list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
}, 10000, '页面');

// 3. DevTools 协议
const ws = new WebSocket(pageWs);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map();
const problems = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    problems.push(`异常：${d.exception?.description || d.text}（${d.url || ''}:${d.lineNumber}）`);
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    problems.push(`console.error：${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    const e = msg.params.entry;
    // favicon 之类的 404 与本次检查无关
    if (!/favicon/.test(e.url || '')) problems.push(`日志：${e.text}${e.url ? `（${e.url}）` : ''}`);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
};
const key = async (k) => {
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: `Key${k.toUpperCase()}`, text: type === 'keyDown' ? k : undefined, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
};
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

const steps = [];
async function step(name, fn, { wait = 700, screenshot = true } = {}) {
  const before = problems.length;
  try {
    await fn();
    await sleep(wait);
    if (screenshot) await shot(name);
  } catch (e) {
    problems.push(`步骤「${name}」出错：${e.message}`);
  }
  steps.push({ name, errors: problems.slice(before) });
}
const click = (sel) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('找不到 ${sel}'); el.click(); return true; })()`);
const modalHas = (min = 20) => evaluate(`(() => { const m = document.querySelector('#modal'); return !m.hidden && document.querySelector('#modal-card').textContent.trim().length >= ${min}; })()`);
const closeModal = () => evaluate(`document.querySelector('#modal').hidden = true`);

// 4. 逐个打开主要界面
await step('01-observe', async () => {
  // 先跳过首次访问的说明弹窗（它会挡住后面的截图；说明面板本身在 08-help 里单独检查）
  await send('Page.navigate', { url: `${base}/?mode=observe` });
  await waitFor(() => evaluate(`document.readyState === 'complete'`), 15000, '页面加载');
  await evaluate(`localStorage.setItem('town-help-seen', '1')`);
  await send('Page.navigate', { url: `${base}/?mode=observe` });
  await waitFor(() => evaluate(`document.querySelectorAll('#roster .rcard').length >= 8`), 15000, '名册渲染');
}, { wait: 1500 });
await step('02-inspector', async () => {
  await click('#roster .rcard[data-id="lin"]');
  await waitFor(() => evaluate(`!document.querySelector('#inspector').hidden && document.querySelector('#insp-body').textContent.includes('林晓雨')`), 8000, '检查器');
  for (const tab of ['sched', 'mem', 'rel', 'diary', 'chat']) await evaluate(`document.querySelector('#insp-body [data-tab="${tab}"]')?.click()`);
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
  await send('Page.navigate', { url: `${base}/?mode=immerse` });
  await waitFor(() => evaluate(`document.body.dataset.mode === 'immerse'`), 15000, '沉浸模式');
}, { wait: 2500 });
await step('12-charcard', async () => {
  await send('Page.navigate', { url: `${base}/?mode=play` });
  // 第一次进游戏模式要先填角色卡（本地模式用内置账号的昵称，只挑衣服）
  await waitFor(() => evaluate(`Boolean(document.querySelector('#cc-go'))`), 15000, '角色卡');
  await evaluate(`document.querySelector('#cc-name') && (document.querySelector('#cc-name').value = '测试旅人'), true`);
});
await step('13-play', async () => {
  await click('#cc-go');
  await waitFor(() => evaluate(`document.body.dataset.mode === 'play'`), 10000, '游戏模式');
  await key('w');
}, { wait: 1500 });
await step('14-admin-settings', async () => {
  await send('Page.navigate', { url: `${base}/admin/#settings` });
  await waitFor(() => evaluate(`document.querySelectorAll('.setting').length > 20`), 10000, '管理面板 · 设置');
  // 改一项，保存按钮可用
  await evaluate(`(() => { const i = document.querySelector('[data-k="MAX_CLIENTS"]'); i.value = '150'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await waitFor(() => evaluate(`!document.querySelector('#s-save').disabled`), 3000, '保存按钮');
});

ws.close();
cleanup();
for (const s of steps) console.log(`${s.errors.length ? '✖' : '✔'} ${s.name}${s.errors.length ? `\n    ${s.errors.join('\n    ')}` : ''}`);
const extra = problems.filter((p) => !steps.some((s) => s.errors.includes(p)));
if (extra.length) console.log(`其他错误：\n    ${extra.join('\n    ')}`);
if (/Error|错误/.test(serverLog) && /at .*\.js:\d+/.test(serverLog)) console.log(`服务器日志里有异常：\n${serverLog.slice(-2000)}`);
console.log(`\n截图：${OUT}\n${problems.length ? `✖ 共 ${problems.length} 个错误` : '✔ 没有错误'}`);
process.exit(problems.length ? 1 : 0);
