// 自动闸门（不用模型）：清单、静态检查、权限比对、语法、插件自带测试、宿主契约测试、内容试应用与考据规则。
// 候选必须先过闸门，才会交给审查员；闸门报告也会一起交给审查员。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateManifest, CONTENT_OPS, checkArgs, cleanOverlay } from '../plugin-host/schema.js';
import { staticCheck } from '../plugin-host/sandbox/static-check.js';
import { SandboxClient, runPluginTests } from '../plugin-host/sandbox/client.js';
import { checkEffects } from '../server/kernel/effects.js';
import { replay } from '../server/kernel/ops.js';
import { ruleCheck } from '../server/worldai/canon.js';
import { readJSON } from './common.js';

/** 按参数 schema 造一组合法的示例参数 */
export function sampleArgs(schema, spec) {
  const out = {};
  for (const [k, f] of Object.entries(schema || {})) {
    if (f.type === 'int') out[k] = Math.ceil(f.min);
    else if (f.type === 'number') out[k] = f.min;
    else if (f.type === 'string') out[k] = '测试';
    else if (f.type === 'enum') out[k] = f.values[0];
    else if (f.type === 'bool') out[k] = true;
    else if (f.type === 'location') out[k] = Object.keys(spec.locations).find((id) => spec.locations[id].public);
    else if (f.type === 'item') out[k] = Object.keys(spec.items)[0];
    else if (f.type === 'agent') out[k] = spec.personas[0].id;
  }
  return out;
}

export function sampleWorld(spec) {
  const agents = spec.personas.filter((p) => !p.kind || p.kind === 'resident').slice(0, 6).map((p, i) => ({
    id: p.id, name: p.name, role: p.role, kind: 'resident', loc: p.work, status: 'acting', region: 'town', x: 20 + i * 3, y: 20, mood: '平静', stamina: 80, courage: 50, conditions: [], inventory: {},
  }));
  return {
    day: 3, minute: 18 * 60, hour: 18, weekday: '周三', weather: 'sunny', flags: {}, width: 64, height: 44, agents,
    locations: Object.entries(spec.locations).filter(([, l]) => l.public).map(([id, l]) => ({ id, name: l.name, center: { x: 30, y: 20 } })),
    items: Object.keys(spec.items), avatars: [{ name: '旅人', loc: 'square', region: 'town' }],
  };
}

const SAMPLE_EVENTS = (w) => ({
  hour: { day: w.day, hour: 18 }, dayStart: { day: w.day },
  'agent.arrive': { agent: w.agents[0], locId: 'pier' }, 'conversation.end': { a: w.agents[0], b: w.agents[1], summary: '两人聊了聊天气' },
  'proposal.applied': { title: '观星塔', ops: ['新建筑：观星塔'] }, 'avatar.arrive': { name: '旅人', loc: 'square' }, 'story.beat': { kind: 'omen' },
});

/** 宿主契约测试：注册的能力与清单一致、每个处理函数在限时内返回合法的意图 */
async function contract(dir, manifest, spec) {
  const issues = [];
  const client = new SandboxClient(dir, { readyMs: 5000, onLlm: async () => '（契约测试中的模型回复）' });
  const limit = (manifest.permissions || []).includes('llm') ? 30_000 : 500;
  const world = sampleWorld(spec);
  const checkOut = (what, result, side) => {
    const list = Array.isArray(result) ? result : Array.isArray(result?.effects) ? result.effects : result == null ? [] : null;
    if (list === null) return issues.push(`${what} 应返回效果数组`);
    if (list.length > 8) issues.push(`${what} 一次返回了 ${list.length} 个效果（最多 8 个）`);
    for (const ef of list.slice(0, 8)) {
      const { who, ...e } = ef || {};
      const err = checkEffects([e], spec);
      if (err) issues.push(`${what} 返回的效果不合法：${err}`);
      if (who != null && !spec.personas.some((p) => p.id === who)) issues.push(`${what} 的 who 不是居民 id：${who}`);
    }
    if (side?.overlay && cleanOverlay(side.overlay, world).length !== side.overlay.length) issues.push(`${what} 的覆盖层指令格式不对`);
  };
  try {
    const reg = await client.start();
    const effects = manifest.provides?.effects || [];
    const extra = [...reg.effects.filter((n) => !effects.some((e) => e.name === n)), ...reg.hooks.filter((h) => !(manifest.hooks || []).includes(h)), ...reg.routes.filter((r) => !(manifest.routes || []).includes(r))];
    if (extra.length) issues.push(`注册了清单里没有声明的能力：${extra.join('、')}`);
    const missing = [...effects.map((e) => e.name).filter((n) => !reg.effects.includes(n)), ...(manifest.hooks || []).filter((h) => !reg.hooks.includes(h)), ...(manifest.routes || []).filter((r) => !reg.routes.includes(r))];
    if (missing.length) issues.push(`清单声明了但没有实现：${missing.join('、')}`);
    for (const e of effects.filter((x) => reg.effects.includes(x.name))) {
      const args = sampleArgs(e.args, spec);
      const argErr = checkArgs(e.args || {}, args, spec);
      if (argErr) { issues.push(`效果 ${e.name} 的参数声明无法构造合法示例：${argErr}`); continue; }
      const ctx = { self: world.agents[0], target: world.agents[1], source: 'contract' };
      try { const r = await client.call('effect', e.name, { args, ctx, world }, limit); checkOut(`效果 ${e.name}`, r.result, r.side); } catch (err) { issues.push(`效果 ${e.name} 调用失败：${err.message}`); }
    }
    const events = SAMPLE_EVENTS(world);
    for (const h of (manifest.hooks || []).filter((x) => reg.hooks.includes(x))) {
      try { const r = await client.call('hook', h, { event: events[h], world }, limit); checkOut(`钩子 ${h}`, r.result, r.side); } catch (err) { issues.push(`钩子 ${h} 调用失败：${err.message}`); }
    }
    for (const name of (manifest.routes || []).filter((x) => reg.routes.includes(x))) {
      try {
        const r = await client.call('route', name, { body: {}, world }, limit);
        if (JSON.stringify(r.result ?? null).length > 16_000) issues.push(`接口 ${name} 返回的数据超过 16KB`);
      } catch (err) { issues.push(`接口 ${name} 调用失败：${err.message}`); }
    }
    // 异常输入：空世界、缺字段的事件不应让插件崩溃
    for (const h of (manifest.hooks || []).filter((x) => reg.hooks.includes(x)).slice(0, 2)) {
      try { await client.call('hook', h, { event: {}, world: { ...world, agents: [] } }, limit); } catch (err) { issues.push(`钩子 ${h} 遇到缺字段的事件时出错：${err.message}`); }
    }
  } catch (e) {
    issues.push(`沙箱启动失败：${e.message}${client.stderr ? `（${client.stderr.trim().split('\n').slice(-1)[0]}）` : ''}`);
  } finally { client.close(); }
  return issues;
}

/**
 * 运行自动闸门。返回 { ok, issues, report, stripped }：report 是给审查员看的摘要，stripped 是去掉注释的代码。
 */
export async function runGate(dir, spec) {
  const manifest = readJSON(path.join(dir, 'plugin.json'), null);
  const issues = [];
  const report = [];
  const mErr = validateManifest(manifest, path.basename(dir));
  if (mErr.length) return { ok: false, issues: mErr.map((e) => `plugin.json：${e}`), report: ['清单校验未通过'], stripped: {} };
  const sc = staticCheck(dir, manifest.tier);
  issues.push(...sc.issues);
  report.push(`静态检查：${sc.ok ? '通过' : `${sc.issues.length} 个问题`}（${sc.files.join('、')}）`);
  if (manifest.tier !== 'T2') {
    const ops = readJSON(path.join(dir, 'content.json'), {})?.ops;
    if (!Array.isArray(ops) || !ops.length || ops.length > 12) issues.push('content.json 需要 1~12 个操作');
    else {
      const bad = ops.filter((o) => !CONTENT_OPS[manifest.tier].includes(o?.op));
      if (bad.length) issues.push(`${manifest.tier} 插件不能使用 ${bad.map((o) => o?.op).join('、')}`);
      const r = replay(spec, ops.map((o, i) => ({ seq: i + 1, op: o.op, args: o.args || {} })));
      for (const k of r.skipped) issues.push(`内容 ${k.op} 无法应用：${k.error}`);
      for (const c of ruleCheck(spec, ops.map((o) => ({ op: o.op, args: o.args || {} })))) issues.push(`设定考据：${c}`);
      report.push(`内容试应用：${r.skipped.length ? `${r.skipped.length} 项失败` : `${ops.length} 项全部可以应用`}`);
    }
    return { ok: !issues.length, issues, report, stripped: sc.stripped, manifest };
  }
  if (!sc.ok) return { ok: false, issues, report, stripped: sc.stripped, manifest };
  for (const f of sc.files.filter((x) => x.endsWith('.js') && x !== 'ui.js')) {
    const r = spawnSync(process.execPath, ['--check', path.join(dir, f)], { encoding: 'utf8', timeout: 10_000 });
    if (r.status !== 0) issues.push(`${f} 语法错误：${String(r.stderr).trim().split('\n').filter((l) => /Error/.test(l))[0] || '无法解析'}`);
  }
  if (issues.length) return { ok: false, issues, report, stripped: sc.stripped, manifest };
  if (fs.existsSync(path.join(dir, 'server.js'))) {
    const t = await runPluginTests(dir);
    report.push(`插件自带测试：${t.results.filter((x) => x.ok).length}/${t.results.length} 通过${t.error ? `（${t.error}）` : ''}`);
    if (!t.ok) issues.push(...(t.results.filter((x) => !x.ok).map((x) => `测试「${x.name}」失败：${x.error}`)), ...(t.error ? [`测试：${t.error}`] : []));
    const c = await contract(dir, manifest, spec);
    report.push(`宿主契约测试：${c.length ? `${c.length} 个问题` : '通过'}`);
    issues.push(...c);
  }
  return { ok: !issues.length, issues, report, stripped: sc.stripped, manifest };
}
