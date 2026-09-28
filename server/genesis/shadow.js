#!/usr/bin/env node
// 创世 G5 的无头试跑（多世界设计 §4.1）：在子进程里用新世界包跑 1 个游戏日，不带任何密钥（不调用模型，居民走规则兜底）。
// 用法：node server/genesis/shadow.js <世界包目录> <工作目录>；输出一行 JSON 指标到标准输出。
import path from 'node:path';

const [packDir, workDir] = process.argv.slice(2);
const out = (x) => { process.stdout.write(`${JSON.stringify(x)}\n`); process.exit(0); };
try {
  const { loadPack } = await import('../worlds/pack.js');
  const { Town } = await import('../sim.ts');
  const pack = loadPack(packDir);
  const town = new Town({ dataDir: workDir, worldId: 'shadow', pack, instantTalk: true, pacing: false, evolution: { dir: path.join(workDir, 'evolution'), pluginsDir: path.join(workDir, 'plugins') } });
  const residents = town.agents.filter((a) => a.kind !== 'creature');
  const walking = {};
  const stuck = new Set();
  const visited = new Set();
  town.speed = 30;
  const end = town.t + 1440;
  let errors = 0;
  town.on('log', (l) => { if (l.type === 'error') errors++; });
  while (town.t < end) {
    town.advance(0.5);
    await new Promise((r) => setImmediate(r));
    for (const a of residents) {
      if (a.locId) visited.add(a.locId);
      // 连续走路超过 3 个游戏小时视为卡住
      if (a.status === 'walking') { walking[a.id] ??= town.t; if (town.t - walking[a.id] > 180) stuck.add(a.id); } else delete walking[a.id];
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) stuck.add(a.id);
    }
  }
  town.stop();
  out({ ok: true, residents: residents.length, stuck: [...stuck], stuckRate: residents.length ? stuck.size / residents.length : 0, visited: visited.size, places: Object.keys(town.spec.locations).length, errors });
} catch (e) {
  out({ ok: false, error: String(e.message || e).slice(0, 300) });
}
