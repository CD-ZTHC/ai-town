// 存档：保存、每小时快照、读档与旧存档迁移
// 以 Town 的方法形式挂载（见 sim.js 末尾的 mixin），方法里的 this 就是 Town。
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import * as llm from '../llm.js';
import { fmtStamp } from '../memory.js';
import { findAbility } from '../kernel/abilities.js';
import { OpJournal } from '../kernel/ops.js';

const SAVE_VERSION = 2;
const SNAPSHOT_KEEP = 24; // 保留最近 24 个游戏小时的快照

export class Persistence {
  readSave() {
    if (!fs.existsSync(this.saveFile)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.saveFile, 'utf8'));
    } catch (e) {
      console.warn('[save] 存档损坏，重新开始：', e.message);
      return null;
    }
  }

  save() {
    if (this.stopped) return;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const agents = [...this.agents, ...this.away].map((a) => {
        const { path: _p, dest: _d, curKey: _k, curEntry: _e, bubble: _b, thinking: _t, thinkingLabel: _l, reflecting: _r, convoId: _c, chatBusy: _cb, visitorChat: _vc, pendingAct: _pa, actKey: _ak, hop: _h, ...rest } = a;
        return rest;
      });
      const data = { v: SAVE_VERSION, worldId: this.worldId, packHash: this.packHash, t: this.t, weather: this.weather, weatherLock: this.weatherLock, specOps: this.specOps, agents, entities: this.entities, worldFlags: this.worldFlags, paramMods: this.paramMods, ruleState: this.ruleState,
        threadState: this.threadState, crisis: this.crisis, discovered: this.discovered, story: this.story, arcRuns: this.arcRuns, voteState: this.voteState,
        pendingScenes: this.pendingScenes, creatureList: this.creatureList, portalState: this.portalState, swarmGoal: this.swarmGoal || null,
        proposals: this.proposals, decisionState: this.decisionState, architectQueue: this.architectQueue, gaps: this.gaps, architectUsage: this.architectUsage,
        usage: this.usage ? { days: this.usage.days } : undefined, metricsState: this.metricsState, logs: this.logs, convoLog: this.convoLog, newspapers: this.newspapers, board: this.board, pairCd: this.pairCd, flags: this.flags, seq: this.seq, llmDay: { key: llm.stats.dayKey, tokens: llm.stats.dayTokens } };
      const text = JSON.stringify(data);
      fs.writeFileSync(this.saveFile + '.tmp', text);
      fs.renameSync(this.saveFile + '.tmp', this.saveFile);
      this.snapshotHourly(text);
    } catch (e) {
      console.warn('[save] 失败：', e.message);
    }
  }

  /** 每个游戏小时保留一份快照（data/snapshots/），供之后的「时光回溯」使用 */
  snapshotHourly(text) {
    // 超出磁盘上限（多世界设计 §6.4）：暂停新快照，存档照常写入
    if (this.diskFull) return;
    const hour = Math.floor(this.t / 60);
    if (this.lastSnapHour === hour) return;
    this.lastSnapHour = hour;
    const dir = path.join(this.dataDir, 'snapshots');
    fs.mkdirSync(dir, { recursive: true });
    // 快照压缩存储（约为原来的 1/8）；每游戏小时一次，1MB 的存档压缩约 5ms，同步写即可
    const name = `d${String(this.day).padStart(3, '0')}-${String(Math.floor(this.minute / 60)).padStart(2, '0')}.json.gz`;
    const file = path.join(dir, name);
    fs.writeFileSync(file + '.tmp', zlib.gzipSync(text));
    fs.renameSync(file + '.tmp', file);
    // 同一个整点的旧格式快照（升级前写的）被新的取代
    fs.rmSync(file.slice(0, -3), { force: true });
    const files = fs.readdirSync(dir).filter((f) => SNAP_RE.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - SNAPSHOT_KEEP))) fs.rmSync(path.join(dir, f), { force: true });
  }

  load(d) {
    if (!d) return;
    try {
      if ((d.v || 1) < SAVE_VERSION) {
        // v1 → v2：结构兼容，只需补齐新组件（createAgent 已给出默认值）；首次迁移前备份旧存档
        const bak = path.join(this.dataDir, `save-v${d.v || 1}-${new Date().toISOString().replace(/[:.]/g, '-')}.bak.json`);
        fs.copyFileSync(this.saveFile, bak);
        console.log(`[save] 旧版存档已备份为 ${path.basename(bak)}，将升级到 v${SAVE_VERSION}`);
      }
      Object.assign(this, { t: d.t, weather: Object.hasOwn(this.spec.weather, d.weather) ? d.weather : 'sunny', weatherLock: d.weatherLock, logs: d.logs || [], convoLog: d.convoLog || [], newspapers: d.newspapers || [], board: d.board || [], pairCd: d.pairCd || {}, flags: d.flags || {}, seq: d.seq || 0 });
      this.nextWeatherT = this.t + 60;
      Object.assign(this, { entities: d.entities || [], worldFlags: d.worldFlags || {}, paramMods: d.paramMods || [], ruleState: d.ruleState || { every: {}, at: {} } });
      Object.assign(this, {
        threadState: d.threadState || {}, crisis: d.crisis || { morale: 70, supplies: 80 }, discovered: d.discovered || [], story: d.story || undefined,
        arcRuns: d.arcRuns || [], voteState: d.voteState || [], pendingScenes: d.pendingScenes || [], creatureList: d.creatureList || [], portalState: d.portalState || null, swarmGoal: d.swarmGoal || null,
        proposals: d.proposals || [], decisionState: (d.decisionState || []).map((x) => (x.status === 'arbitrating' ? { ...x, status: 'waiting' } : x)), architectQueue: d.architectQueue || [], gaps: d.gaps || [], architectUsage: d.architectUsage || undefined,
        usage: { days: d.usage?.days || {}, mark: null }, // 进程内计数重启后归零，重新开始标记
        metricsState: d.metricsState || { days: {} },
      });
      if (this.story) this.story.lastHour = -1;
      // 恢复当日令牌用量，避免重启后预算被重置
      if (d.llmDay?.key === llm.localDayKey()) { llm.stats.dayKey = d.llmDay.key; llm.stats.dayTokens = Math.max(llm.stats.dayTokens, d.llmDay.tokens || 0); }
      const personas = Object.fromEntries(this.spec.personas.map((p) => [p.id, p]));
      for (const saved of d.agents || []) {
        const a = this.byId[saved.id];
        if (!a) continue;
        const p = personas[saved.id];
        const kit = { inventory: { ...a.inventory }, abilities: [...a.abilities] };
        // 基础人设以世界规格为准；经历带来的变化记录在 growth 里，不会被覆盖
        Object.assign(a, saved, { look: p.look, persona: p.persona, role: p.role, home: p.home, work: p.work });
        if (!saved.kit) {
          // 早于 P1 的存档：补发初始物品与能力
          for (const [k, n] of Object.entries(kit.inventory)) a.inventory[k] = (a.inventory[k] || 0) + n;
          a.abilities = [...new Set([...(a.abilities || []), ...kit.abilities])];
          a.kit = 1;
        }
        a.cooldowns ||= {};
        a.abilities = a.abilities.filter((id) => findAbility(this.spec, id));
        a.visitorChats ||= {};
        delete a.visitorChat;
        Object.assign(a, { chatBusy: false, path: [], dest: null, curKey: null, thinking: 0, thinkingLabel: '', convoId: null, bubble: null, reflecting: false });
        if (a.status === 'walking' || a.status === 'chatting') { a.status = 'idle'; a.locId = null; a.x = Math.round(a.x); a.y = Math.round(a.y); }
      }
      console.log(`[save] 已读取存档：${fmtStamp(this.t)}`);
    } catch (e) {
      console.warn('[save] 存档损坏，重新开始：', e.message);
    }
  }
}

// ---------- 时光回溯（设计文档 4.3）----------
// 快照文件名：dNNN-HH.json.gz（新）或 dNNN-HH.json（升级前的旧快照，仍然可以回溯和分叉）
export const SNAP_RE = /^d(\d{3})-(\d{2})\.json(?:\.gz)?$/;

/** 读取一份快照（自动解压）；损坏时抛错 */
export function readSnapshot(file) {
  const buf = fs.readFileSync(file);
  return JSON.parse((file.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8'));
}

/** 列出可回溯的整点快照（新的在前） */
export function listSnapshots(dataDir) {
  const dir = path.join(path.resolve(dataDir), 'snapshots');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => SNAP_RE.test(f)).sort().reverse().map((f) => {
    const [, d, h] = SNAP_RE.exec(f);
    return { name: f, day: Number(d), hour: Number(h), size: fs.statSync(path.join(dir, f)).size };
  });
}

/** 用快照替换当前存档（当前存档先备份）。调用方负责之后重建 Town。返回备份文件名。 */
export function restoreSnapshot(dataDir, name) {
  if (!SNAP_RE.test(String(name))) throw Object.assign(new Error('快照名称不合法'), { status: 400 });
  const dir = path.resolve(dataDir);
  const src = path.join(dir, 'snapshots', name);
  if (!fs.existsSync(src)) throw Object.assign(new Error('快照不存在'), { status: 404 });
  const data = readSnapshot(src); // 损坏的快照不允许回溯
  const save = path.join(dir, 'save.json');
  const bak = `save-before-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}.bak.json`;
  if (fs.existsSync(save)) fs.copyFileSync(save, path.join(dir, bak));
  fs.writeFileSync(save + '.tmp', JSON.stringify(data));
  fs.renameSync(save + '.tmp', save);
  new OpJournal(path.join(dir, 'ops.jsonl')).append({ op: 'rollback', to: name, at: new Date().toISOString() });
  return bak;
}
