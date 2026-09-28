// 影子试运行的子进程：用当前存档的副本建一个小镇（不调用模型，居民按规则生活），装上（或不装）候选插件，
// 高倍速跑若干游戏小时，输出指标。由 evolution/shadow.js 启动，只能写自己的工作目录。
import fs from 'node:fs';
import path from 'node:path';

const job = JSON.parse(process.argv[2]);
let warnings = 0;
console.warn = () => { warnings++; };
console.log = () => {};
const { Town } = await import('../server/sim.ts');
const { loadPack } = await import('../server/worlds/pack.ts');

fs.mkdirSync(job.workDir, { recursive: true });
const town = new Town({
  dataDir: job.workDir, instantTalk: true, pacing: false,
  // 用户世界：用它自己的世界包（官方世界不传，默认就是云溪镇）
  ...(job.packDir ? { pack: loadPack(job.packDir) } : {}),
  evolution: { dir: path.join(job.workDir, 'evolution'), pluginsDir: path.join(job.workDir, 'no-plugins'), force: job.candidate ? [job.candidate] : [], config: { mode: 'off' } },
});
town.save = () => {}; // 试运行不写存档
const start = town.t;
const end = start + job.hours * 60;
town.speed = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(300); // 等沙箱启动
let steps = 0;
let ms = 0;
while (town.t < end) {
  const t0 = performance.now();
  town.advance(0.25);
  ms += performance.now() - t0;
  steps++;
  if (steps % 8 === 0) await sleep(5); // 让沙箱的回复有机会处理
}
await sleep(300);
const id = job.candidate?.key.split('@')[0];
const usage = id ? town.evolved.usage[id] || {} : {};
const metrics = {
  hours: job.hours, steps, tickMs: +(ms / steps).toFixed(3),
  errors: (usage.errors || 0) + Object.values(town.hooks.errors).reduce((s, x) => s + x, 0),
  lastError: usage.lastError || null,
  pluginCalls: usage.total || 0,
  pluginLogs: town.logs.filter((l) => l.type === 'plugin').length,
  logs: town.logs.filter((l) => l.t >= start).length,
  warnings,
  sleeping: town.agents.filter((a) => a.status === 'sleeping').length,
};
town.stop();
process.stdout.write(`\n@@SHADOW ${JSON.stringify(metrics)}\n`);
process.exit(0);
