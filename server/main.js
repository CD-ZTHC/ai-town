#!/usr/bin/env node
// 守护进程（多世界设计 §14.5）：不做业务，只负责拉起 server/index.js。
//   退出码 75（请求重启）→ 立即重新启动
//   其他非零退出码       → 退避后重启（1s、2s、4s…，上限 30s）
//   正常退出（0）        → 守护进程也退出
// 服务进程启动成功（端口监听、默认世界加载完成）后通过 IPC 发来 ready，并把当前设置版本标记为「正常」。
// 如果新保存的设置导致连续 2 次启动失败，自动回退到上一个「正常」的版本再启动，面板上会显示回退原因。
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollbackToGood, settingsFile } from './settings/index.js';

export const RESTART_CODE = 75;
const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
const MAX_FAILS = 2;

let child = null;
let fails = 0; // 连续「没到 ready 就退出」的次数
let backoff = 0;
let stopping = false;
let lastErr = '';

function start() {
  let ready = false;
  lastErr = '';
  child = fork(ENTRY, process.argv.slice(2), { stdio: ['inherit', 'inherit', 'pipe', 'ipc'] });
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
