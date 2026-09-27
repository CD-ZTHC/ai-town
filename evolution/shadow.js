// 影子试运行（自主演化设计 §6.4）：在当前世界的副本上，装与不装候选插件各跑一遍，比较指标。
// 两个子进程都不带任何密钥（不调用模型），并用 Node 权限模型限制为只能写自己的工作目录。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from './common.js';
import { activeDir } from '../server/timelines.js';
import { get as setting } from '../server/settings/index.js';

const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

function runOne(P, job, timeoutMs) {
  return new Promise((resolve) => {
    fs.mkdirSync(job.workDir, { recursive: true });
    // 存档副本由这里复制进去：试运行进程只能读写自己的工作目录
    if (job.saveFile && fs.existsSync(job.saveFile)) fs.copyFileSync(job.saveFile, path.join(job.workDir, 'save.json'));
    // 交给试运行进程的都用真实路径：它自己受权限限制，未必能解析符号链接
    job = { ...job, saveFile: null, workDir: real(job.workDir), candidate: job.candidate && { ...job.candidate, dir: real(job.candidate.dir) } };
    // 路径里有符号链接时（例如 macOS 的 /var → /private/var），权限模型有的地方按原路径、有的按真实路径比对，两种都放行
    const both = (flag, p) => [...new Set([p, real(p)])].map((x) => `${flag}=${x}`);
    const args = ['--no-warnings', '--permission', ...both('--allow-fs-read', ROOT), ...both('--allow-fs-read', P.evo), ...both('--allow-fs-read', job.workDir), ...both('--allow-fs-write', job.workDir), '--allow-child-process', path.join(ROOT, 'evolution', 'shadow-runner.js'), JSON.stringify(job)];
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { PATH: process.env.PATH || '', NODE_ENV: 'shadow' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      const line = out.split('\n').find((l) => l.startsWith('@@SHADOW '));
      if (line) resolve(JSON.parse(line.slice(9)));
      else resolve({ failed: true, error: `试运行进程退出（${code}）：${err.trim().split('\n').filter((l) => /Error|denied|resource/.test(l)).slice(-2).join(' ') || err.trim().slice(-200)}` });
    });
  });
}

/**
 * candidate：{ key, dir }。返回 { passed, reason, metrics: { base, trial } }
 */
export async function runShadow(P, candidate, { hours = setting('EVOLVE_SHADOW_HOURS'), timeoutMs = 180_000 } = {}) {
  const root = path.join(P.shadow, candidate.key);
  fs.rmSync(root, { recursive: true, force: true });
  let saveFile = null;
  try { saveFile = path.join(activeDir(P.data), 'save.json'); } catch { /* 没有存档就从第一天开始 */ }
  const [base, trial] = await Promise.all([
    runOne(P, { workDir: path.join(root, 'base'), saveFile, candidate: null, hours }, timeoutMs),
    runOne(P, { workDir: path.join(root, 'trial'), saveFile, candidate, hours }, timeoutMs),
  ]);
  fs.rmSync(root, { recursive: true, force: true });
  const metrics = { base, trial };
  if (base.failed) return { passed: false, reason: `对照组没能运行：${base.error}`, metrics };
  if (trial.failed) return { passed: false, reason: trial.error, metrics };
  const reasons = [];
  if (trial.errors > 0) reasons.push(`插件出错 ${trial.errors} 次${trial.lastError ? `（${trial.lastError}）` : ''}`);
  if (trial.tickMs > base.tickMs * 1.2 + 0.5) reasons.push(`模拟变慢：${base.tickMs}ms → ${trial.tickMs}ms`);
  if (trial.pluginLogs > hours * 4) reasons.push(`动态栏刷屏：${trial.pluginLogs} 条`);
  if (trial.warnings > base.warnings + 5) reasons.push(`警告增加：${base.warnings} → ${trial.warnings}`);
  return { passed: !reasons.length, reason: reasons.join('；'), metrics };
}
