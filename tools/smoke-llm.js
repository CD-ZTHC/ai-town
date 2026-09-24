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
  llm.setMock((messages, opts) => JSON.stringify({
    规划一天: { mood: '期待', moodEmoji: '😊', goal: '办好音乐会', schedule: [{ start: '09:30', end: '12:00', location: 'cafe', activity: '开店', emoji: '☕' }, { start: '12:00', end: '14:00', location: 'square', activity: '找乐手', emoji: '🎸' }, { start: '14:00', end: '18:00', location: 'cafe', activity: '看店', emoji: '☕' }] },
    内心独白: { thought: '天黑了，点盏灯吧', action: '点灯', emoji: '🏮', mood: '安心', moodEmoji: '😊', use: { ability: 'firefly_ward', target: null } },
    对话: { lines: [{ speaker: '林晓雨', text: '早呀' }, { speaker: '苏墨', text: '早。' }], summary: '打招呼', memoryA: '和苏墨打了招呼', memoryB: '和晓雨打了招呼', affinityA: 1, affinityB: 2, noteA: '安静', noteB: '温柔', importance: 3, commitments: [], idea: null },
    叙事导演: { decision: 'foreshadow', reason: '测试', beats: [{ kind: 'omen', who: ['王小乐'], text: '湖面闪了一下' }] },
    多人场景: { lines: [{ speaker: '何月', text: '人齐了' }, { speaker: '赵铁柱', text: '说吧' }], summary: '商量', memories: {}, affinity: [], assignments: [] },
    世界架构师: { title: '观星塔', motive: '看星星', ops: [{ op: 'addBuilding', args: { id: 'star_tower', name: '观星塔', kind: 'tower', w: 3, h: 3, place: { near: 'pier' }, sign: '🔭', desc: '看星星' } }], construction: { by: ['赵铁柱'], hours: 2 } },
    设定考据: { severity: 'none', issues: [] },
    撰写日报: { headline: '测试', subhead: '测试', lead: '测试', articles: [], gossip: '', quote: { who: '林晓雨', text: '你好' }, forecast: '晴' },
    撰写需求文档: { title: '测试', slug: 'test', summary: 's', motivation: 'm', design: 'd', schema: '{}', example: 'e', tests: [], risks: [], alternatives: [], effort: 'S' },
  }[opts.label] || {}));
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
    return { ok: c && c.lines.length >= 2 && !c.summary.includes('寒暄'), out: `${c?.lines.length} 句：${c?.summary}` };
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
    return { ok, out: l ? `${l.lines.length} 句：${l.text}` : '超时' };
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
  const row = { name, ok: r.ok, ms: Date.now() - t0, tokens: tokens() - k0, errors: llm.stats.errors - e0, out: String(r.out).slice(0, 120) };
  rows.push(row);
  console.log(`${row.ok ? '✅' : '❌'} ${name.padEnd(10)} ${String(row.ms).padStart(6)}ms ${String(row.tokens).padStart(7)} tokens${row.errors ? ` · 失败调用 ${row.errors}` : ''}\n   ${row.out}`);
}
console.log(`\n合计：${rows.filter((r) => r.ok).length}/${rows.length} 通过 · ${tokens()} tokens · 调用 ${llm.stats.calls} 次（失败 ${llm.stats.errors}）${llm.stats.lastError ? ` · 最后错误：${llm.stats.lastError}` : ''}`);
town.stop();
process.exit(rows.every((r) => r.ok) ? 0 : 1);
