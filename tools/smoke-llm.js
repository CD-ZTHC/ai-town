#!/usr/bin/env node
// mise run smoke：用真实模型对每个 AI 模块各做一次调用，检查输出能否被系统接受，并统计耗时与 token 用量。
// 用于接入新的模型 / 网关时的快速验收；默认 token 上限 200000（LLM_DAILY_TOKENS 可覆盖），不会跑完整一季。
//
// 用法：BASE_URL=… API_KEY=… [MODEL=… MODEL_FAST=… MODEL_SMART=…] node tools/smoke-llm.js [--only 模块名,…] [--mock]
//   --mock：不联网，用假回复走一遍流程（检查脚本本身）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const MOCK = args.includes('--mock');
const only = (args[args.indexOf('--only') + 1] || '').split(',').filter((x) => args.includes('--only') && x);
process.env.LLM_DAILY_TOKENS ||= '200000';
if (!MOCK && !(process.env.BASE_URL && process.env.API_KEY)) {
  console.error('需要 BASE_URL 与 API_KEY（或使用 --mock）');
  process.exit(1);
}
process.env.STORYTELLER = 'gentle';
process.env.STORY_RATING ||= 'adventure';

const { Town } = await import('../server/sim.js');
const llm = await import('../server/llm.js');
const { useAbility } = await import('../server/kernel/abilities.js');

if (MOCK) {
  // 与无头回放测试共用同一份录制回复
  const { fixtureMock, loadFixtures } = await import('../test/fixtures/llm/index.js');
  // 模拟模式的结果不能取决于本机 .env：不加载 Mod（Mod 会改地图，影响世界架构师的选址）；
  // 录制里有几条世界架构师的回复选址在 Mod 加的地点（lakeside_story）旁边，只用不依赖 Mod 的回复
  //（第一条选址写错、改正后的第二条通过，顺带走一遍修正流程）
  delete process.env.MODS;
  const fx = loadFixtures();
  fx['世界架构师'] = fx['世界架构师'].filter((r) => !JSON.stringify(r).includes('lakeside_story'));
  llm.setMock(fixtureMock(fx));
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'town-smoke-'));
const town = new Town({ dataDir: dir, instantTalk: true });
town.t = 9 * 60;
const tokens = () => llm.stats.promptTokens + llm.stats.completionTokens;
const place = (ids, x = 22, y = 20) => ids.forEach((id, i) => Object.assign(town.byId[id], { x: x + i, y, inside: null, locId: 'square', status: 'acting', path: [], convoId: null }));
const flush = async (ms = 50) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond, ms = 180_000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await flush(200); return cond(); };

const STEPS = {
  async plan() {
    await town.planDay(town.byId.lin);
    const s = town.byId.lin.schedule;
    return { ok: s.length >= 3 && s[0].src === 'plan', out: `${s.length} 项日程；今日心愿：${town.byId.lin.todayGoal || '—'}；带行动的条目 ${s.filter((e) => e.act).length} 个` };
  },
  async thought() {
    town.t = 20 * 60;
    place(['sun', 'wang']);
    town.byId.sun.lastThoughtT = -999;
    await town.innerThought(town.byId.sun);
    town.t = 9 * 60;
    const used = town.logs.some((l) => l.type === 'ability' && l.agents?.includes('sun'));
    return { ok: Boolean(town.byId.sun.thought), out: `「${town.byId.sun.thought}」${used ? '（自主使用了能力）' : '（没有使用能力）'}` };
  },
  async convo() {
    place(['lin', 'su']);
    await town.startConvo(town.byId.lin, town.byId.su);
    const c = town.convoLog.at(-1);
    const log = town.logs.findLast((l) => l.type === 'convo');
    return { ok: Boolean(c && c.lines.length >= 2 && !log?.fallback), out: `${c?.lines.length} 句：${c?.summary}${log?.fallback ? '（兜底台词）' : ''}` };
  },
  async director() {
    town.t = 10 * 60;
    const r = await town.director.decide();
    const d = town.director.st.decisions.at(-1);
    return { ok: Boolean(d), out: `${d?.decision}（${d?.reason}）执行 ${r.done} 个节拍，丢弃 ${r.skipped.length} 个` };
  },
  async scene() {
    place(['he', 'zhao', 'zhou']);
    town.scenes.pending.push({ id: 'smoke-scene', title: '酒馆夜谈', location: 'square', members: ['he', 'zhao', 'zhou'], purpose: '三人商量萤火节怎么办得热闹又安全', assignments: [], arc: null, time: town.t });
    town.scenes.tick();
    const ok = await waitFor(() => town.logs.some((l) => l.type === 'scene' && l.title === '酒馆夜谈'));
    const l = town.logs.find((x) => x.type === 'scene' && x.title === '酒馆夜谈');
    return { ok: ok && !l?.fallback, out: l ? `${l.lines.length} 句：${l.text}${l.fallback ? '（模型输出无法解析，用了预设台词）' : ''}` : '超时' };
  },
  async architect() {
    const r = await town.architect.process({ intent: '在码头边修一座可以看星星的小塔', origin: 'admin' });
    if (r.gap) return { ok: true, out: '记为能力缺口' };
    if (r.error) return { ok: false, out: r.error };
    await waitFor(() => r.proposal.status !== 'review', 60_000);
    return { ok: !['failed', 'rejected'].includes(r.proposal.status), out: `「${r.proposal.title}」${r.proposal.ops.length} 个操作 → ${r.proposal.status}；考据：${r.proposal.canon?.severity}${r.proposal.canon?.issues?.length ? `（${r.proposal.canon.issues.join('；')}）` : ''}` };
  },
  async newspaper() {
    const p = await town.makeNewspaper();
    return { ok: Boolean(p?.headline), out: `头条：${p?.headline}` };
  },
  async evolve() {
    town.gaps = [{ id: 'gapS', need: '拆除新增的建筑', why: '想给新集市腾地方', by: 'visitor', intent: '把观星塔拆了建集市', count: 2, status: 'adopted' }];
    town.save();
    const { evolve } = await import('./evolve.js');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'town-smoke-rfc-'));
    const r = await evolve({ data: dir, out, limit: 1 });
    const w = r.written[0];
    return { ok: Boolean(w?.byLlm), out: w ? `${w.file}（${w.byLlm ? '模型撰写' : '骨架'}）` : r.skipped.join('；') };
  },
};

console.log(`模型：默认 ${llm.stats.model || '—'} · 快 ${llm.stats.models.fast || '—'} · 强 ${llm.stats.models.smart || '—'}${MOCK ? '（模拟）' : ''}\n`);
const rows = [];
for (const [name, fn] of Object.entries(STEPS)) {
  if (only.length && !only.includes(name)) continue;
  const t0 = Date.now(), k0 = tokens(), e0 = llm.stats.errors;
  let r;
  try { r = await fn(); } catch (e) { r = { ok: false, out: `出错：${e.message}` }; }
  // 有失败的模型调用时，即使走了兜底逻辑也不算通过
  const row = { name, ok: r.ok && llm.stats.errors === e0, ms: Date.now() - t0, tokens: tokens() - k0, errors: llm.stats.errors - e0, out: String(r.out).slice(0, 120) };
  rows.push(row);
  console.log(`${row.ok ? '✅' : '❌'} ${name.padEnd(10)} ${String(row.ms).padStart(6)}ms ${String(row.tokens).padStart(7)} tokens${row.errors ? ` · 失败调用 ${row.errors}` : ''}\n   ${row.out}`);
}
console.log(`\n合计：${rows.filter((r) => r.ok).length}/${rows.length} 通过 · ${tokens()} tokens · 调用 ${llm.stats.calls} 次（失败 ${llm.stats.errors}）${llm.stats.lastError ? ` · 最后错误：${llm.stats.lastError}` : ''}`);
town.stop();
process.exit(rows.every((r) => r.ok) ? 0 : 1);
