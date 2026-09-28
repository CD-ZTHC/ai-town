#!/usr/bin/env node
// 守护进程（多世界设计 §14.5）：不做业务，只负责拉起 server/index.ts。
//   退出码 75（请求重启）→ 立即重新启动
//   其他非零退出码       → 退避后重启（1s、2s、4s…，上限 30s）
//   正常退出（0）        → 守护进程也退出
// 服务进程启动成功（端口监听、默认世界加载完成）后通过 IPC 发来 ready，并把当前设置版本标记为「正常」。
// 如果新保存的设置导致连续 2 次启动失败，自动回退到上一个「正常」的版本再启动，面板上会显示回退原因。
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollbackToGood, settingsFile, load, get as setting } from './settings/index.ts';

export const RESTART_CODE = 75;
const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts');
const MAX_FAILS = 2;

let child = null;
let fails = 0; // 连续「没到 ready 就退出」的次数
let backoff = 0;
let stopping = false;
let lastErr = '';

/**
 * 服务进程的额外启动参数：接近堆上限时在 <数据目录>/diag/ 留一份堆快照（重构方案 §6.2），旧快照只保留最近 2 份。
 * 堆上限本身来自 NODE_OPTIONS（--max-old-space-size），由部署环境设置
 */
function childExecArgv() {
  try { load(); } catch { /* 设置文件损坏：按默认值 */ }
  if (!setting('HEAP_SNAPSHOT')) return [];
  const diag = path.join(path.resolve(setting('DATA_DIR')), 'diag');
  try {
    fs.mkdirSync(diag, { recursive: true });
    const old = fs.readdirSync(diag).filter((f) => f.endsWith('.heapsnapshot')).map((f) => ({ f, t: fs.statSync(path.join(diag, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of old.slice(2)) fs.rmSync(path.join(diag, f), { force: true });
  } catch (e) { console.warn('[main] 无法准备诊断目录：', e.message); return []; }
  return ['--heapsnapshot-near-heap-limit=1', `--diagnostic-dir=${diag}`];
}

function start() {
  let ready = false;
  lastErr = '';
  // 守护进程自己的堆上限（命令行的 --max-old-space-size）不传给服务进程：服务进程用 NODE_OPTIONS 里的上限
  const inherited = process.execArgv.filter((f) => !/^--max-old-space-size(=|$)/.test(f));
  child = fork(ENTRY, process.argv.slice(2), { stdio: ['inherit', 'inherit', 'pipe', 'ipc'], execArgv: [...inherited, ...childExecArgv()] });
  // 转发错误输出，同时留下最后一段，作为回退原因
  child.stderr.on('data', (d) => { process.stderr.write(d); lastErr = (lastErr + d.toString()).slice(-600); });
  child.on('message', (m) => {
    if (m?.type === 'ready') { ready = true; fails = 0; backoff = 0; }
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return process.exit(0);
    if (code === 0) return process.exit(0);
    if (code === RESTART_CODE) { console.log('[main] 服务请求重启'); return start(); }
    if (!ready) {
      fails++;
      if (fails >= MAX_FAILS) {
        const r = rollbackToGood(settingsFile(), `连续 ${fails} 次启动失败：${lastErr.trim().split('\n').slice(-3).join(' ') || `退出码 ${code ?? signal}`}`);
        if (r) {
          console.warn(`[main] 设置版本 ${r.from} 连续启动失败，已回退到版本 ${r.to}`);
          fails = 0;
          return start();
        }
      }
    }
    const wait = Math.min(30_000, 1000 * 2 ** backoff++);
    console.warn(`[main] 服务退出（${code ?? signal}），${wait / 1000} 秒后重启`);
    setTimeout(start, wait);
  });
}

const stop = (sig) => { stopping = true; if (child) child.kill(sig); else process.exit(0); };
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
start();
