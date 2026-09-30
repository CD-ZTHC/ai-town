// 存档：保存、每小时快照、读档与旧存档迁移
// 以 Town 的方法形式挂载（见 sim.js 末尾的 mixin），方法里的 this 就是 Town。
// 存档在 <数据目录>/world.db（重构方案 P5）：每 20 秒只写变化的部分；升级前的 save.json 在第一次启动时导入，之后改名备份。
import fs from 'node:fs';
import path from 'node:path';
import * as llm from '../llm.ts';
import { fmtStamp } from '../memory.ts';
import { findAbility } from '../kernel/abilities.ts';
import { OpJournal } from '../kernel/ops.ts';
import { freshDark } from '../story/threats.ts';
import type { Town } from '../sim.ts';
import type { CurEntry, LiveAgent, ScheduleEntry } from '../types/agent.ts';
import type { Act, ActArgs, Convo, Fight, SaveData, ThreatInstance } from '../types/town.ts';
import type { Persona } from '../types/spec.ts';
import type { Cell } from '../types/map.ts';
import type { Pos } from '../kernel/effects.ts';
import type { ModelJSON } from '../llm.ts';
import type { RetrieveOptions } from '../memory.ts';
import { DB_FILE, WorldStore } from '../storage/world-store.ts';
import { LEGACY_FILE, backupSave, readSnapshotFile, restoreSnapshotFile } from '../storage/save-io.ts';

const SAVE_VERSION = 2;
const SNAPSHOT_KEEP = 24; // 保留最近 24 个游戏小时的快照

export class Persistence {
  /** 打开存档数据库（第一次用到时）；数据库损坏时改名留存，换一个新的 */
  worldStore(this: Town): WorldStore {
    if (this.store) return this.store;
    try {
      this.store = new WorldStore(this.dataDir);
    } catch (e) {
      const bad = `world-corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
      console.warn(`[save] 存档数据库打不开，改名为 ${bad} 后重新开始：`, (e as Error).message);
      fs.renameSync(path.join(this.dataDir, DB_FILE), path.join(this.dataDir, bad));
      for (const x of ['-wal', '-shm']) fs.rmSync(path.join(this.dataDir, DB_FILE + x), { force: true });
      this.store = new WorldStore(this.dataDir);
    }
    return this.store;
  }

  readSave(this: Town) {
    if (fs.existsSync(path.join(this.dataDir, DB_FILE))) {
      try {
        const d = this.worldStore().readAll();
        if (d) return d;
      } catch (e) {
        console.warn('[save] 存档损坏，重新开始：', (e as Error).message);
        return null;
      }
    }
    // 升级前的存档：读出来，第一次存盘时整体写进数据库，然后把 save.json 改名备份
    if (!fs.existsSync(this.saveFile)) return null;
    try {
      const d = JSON.parse(fs.readFileSync(this.saveFile, 'utf8'));
      this.legacySave = true;
      return d;
    } catch (e) {
      console.warn('[save] 存档损坏，重新开始：', (e as Error).message);
      return null;
    }
  }

  save(this: Town) {
    if (this.stopped) return;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      this.worldStore().write(this.saveData());
      if (this.legacySave) {
        // 已经完整写进数据库：旧存档改名留作备份（不删除）
        this.legacySave = false;
        const bak = `save-imported-${new Date().toISOString().replace(/[:.]/g, '-')}.bak.json`;
        if (fs.existsSync(this.saveFile)) fs.renameSync(this.saveFile, path.join(this.dataDir, bak));
        console.log(`[save] 旧存档 ${LEGACY_FILE} 已导入 ${DB_FILE}，原文件备份为 ${bak}`);
      }
      this.snapshotHourly();
    } catch (e) {
      console.warn('[save] 失败：', (e as Error).message);
    }
  }

  /** 要存盘的全部内容（结构即 SaveV2；工具 export-save 导出的 save.json 也是它） */
  saveData(this: Town) {
    const agents = [...this.agents, ...this.away].map((a) => {
      const { path: _p, dest: _d, curKey: _k, curEntry: _e, bubble: _b, thinking: _t, thinkingLabel: _l, reflecting: _r, convoId: _c, chatBusy: _cb, visitorChat: _vc, pendingAct: _pa, actKey: _ak, hop: _h, ...rest } = a;
      return rest;
    });
    const data = { v: SAVE_VERSION, worldId: this.worldId, packHash: this.packHash, t: this.t, weather: this.weather, weatherLock: this.weatherLock, specOps: this.specOps, agents, entities: this.entities, worldFlags: this.worldFlags, paramMods: this.paramMods, ruleState: this.ruleState,
      threadState: this.threadState, crisis: this.crisis, discovered: this.discovered, story: this.story, migrationState: this.migrationState, mapState: this.mapState, arcRuns: this.arcRuns, voteState: this.voteState,
      pendingScenes: this.pendingScenes, creatureList: this.creatureList, dark: this.dark, fights: this.fights, portalState: this.portalState, swarmGoal: this.swarmGoal || null,
      proposals: this.proposals, decisionState: this.decisionState, architectQueue: this.architectQueue, gaps: this.gaps, architectUsage: this.architectUsage,
      usage: this.usage ? { days: this.usage.days } : undefined, metricsState: this.metricsState, logs: this.logs, convoLog: this.convoLog, newspapers: this.newspapers, board: this.board, pairCd: this.pairCd, flags: this.flags, seq: this.seq, llmDay: { key: llm.stats.dayKey, tokens: llm.stats.dayTokens } };
    return data;
  }

  /**
   * 每个游戏小时保留一份快照（<数据目录>/snapshots/dNNN-HH.db.gz），供「时光回溯」与分叉使用。
   * 数据库先 VACUUM INTO 复制一份（同步、很快），再流式压缩（不阻塞主循环）；上一份还没写完时跳过这一次。
   */
  snapshotHourly(this: Town) {
    // 超出磁盘上限（多世界设计 §6.4）：暂停新快照，存档照常写入
    if (this.diskFull || this.snapWriting) return;
    const hour = Math.floor(this.t / 60);
    if (this.lastSnapHour === hour) return;
    this.lastSnapHour = hour;
    const dir = path.join(this.dataDir, 'snapshots');
    fs.mkdirSync(dir, { recursive: true });
    const base = `d${String(this.day).padStart(3, '0')}-${String(Math.floor(this.minute / 60)).padStart(2, '0')}`;
    const file = path.join(dir, `${base}.db.gz`);
    this.snapWriting = this.worldStore().snapshotTo(file).then(() => {
      // 同一个整点的旧格式快照（升级前写的）被新的取代
      for (const ext of ['.json', '.json.gz']) fs.rmSync(path.join(dir, base + ext), { force: true });
      const files = fs.readdirSync(dir).filter((f) => SNAP_RE.test(f)).sort();
      for (const f of files.slice(0, Math.max(0, files.length - SNAPSHOT_KEEP))) fs.rmSync(path.join(dir, f), { force: true });
    }).catch((e) => console.warn('[save] 快照失败：', (e as Error).message)).finally(() => { this.snapWriting = null; });
  }

  load(this: Town, d: SaveData) {
    if (!d) return;
    try {
      if ((d.v || 1) < SAVE_VERSION) {
        // v1 → v2：结构兼容，只需补齐新组件（createAgent 已给出默认值）；首次迁移前备份旧存档
        const bak = backupSave(this.dataDir, `v${d.v || 1}`);
        console.log(`[save] 旧版存档已备份为 ${bak}，将升级到 v${SAVE_VERSION}`);
      }
      Object.assign(this, { t: d.t, weather: Object.hasOwn(this.spec.weather, d.weather) ? d.weather : this.weather, weatherLock: d.weatherLock, logs: d.logs || [], convoLog: d.convoLog || [], newspapers: d.newspapers || [], board: d.board || [], pairCd: d.pairCd || {}, flags: d.flags || {}, seq: d.seq || 0 });
      this.nextWeatherT = this.t + 60;
      Object.assign(this, { entities: d.entities || [], worldFlags: d.worldFlags || {}, paramMods: d.paramMods || [], ruleState: d.ruleState || { every: {}, at: {} } });
      Object.assign(this, {
        threadState: d.threadState || {}, crisis: d.crisis || { morale: 70, supplies: 80 }, discovered: d.discovered || [], story: d.story || undefined, migrationState: d.migrationState || undefined, mapState: d.mapState || undefined,
        arcRuns: d.arcRuns || [], voteState: d.voteState || [], pendingScenes: d.pendingScenes || [], creatureList: d.creatureList || [], dark: d.dark ? { ...freshDark(), ...d.dark } : freshDark(), fights: d.fights || [], portalState: d.portalState || null, swarmGoal: d.swarmGoal || null,
        proposals: d.proposals || [], decisionState: (d.decisionState || []).map((x: { status: string }) => (x.status === 'arbitrating' ? { ...x, status: 'waiting' } : x)), architectQueue: d.architectQueue || [], gaps: d.gaps || [], architectUsage: d.architectUsage || undefined,
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
      console.warn('[save] 存档损坏，重新开始：', (e as Error).message);
    }
  }
}

// ---------- 时光回溯（设计文档 4.3）----------
// 快照文件名：dNNN-HH.db.gz（数据库快照）；升级前的 dNNN-HH.json.gz、dNNN-HH.json 仍然可以回溯和分叉
export const SNAP_RE = /^d(\d{3})-(\d{2})\.(?:db\.gz|json(?:\.gz)?)$/;

/** 读取一份快照（自动解压）；损坏时抛错 */
export function readSnapshot(file: string): SaveData {
  return readSnapshotFile(file);
}

/** 列出可回溯的整点快照（新的在前） */
export function listSnapshots(dataDir: string): Array<{ name: string; day: number; hour: number; size: number }> {
  const dir = path.join(path.resolve(dataDir), 'snapshots');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => SNAP_RE.test(f)).sort().reverse().map((f) => {
    const [, d, h] = SNAP_RE.exec(f)!;
    return { name: f, day: Number(d), hour: Number(h), size: fs.statSync(path.join(dir, f)).size };
  });
}

/** 用快照替换当前存档（当前存档先备份）。调用方负责之后重建 Town。返回备份文件名。 */
export function restoreSnapshot(dataDir: string, name: string): string {
  if (!SNAP_RE.test(String(name))) throw Object.assign(new Error('快照名称不合法'), { status: 400 });
  const dir = path.resolve(dataDir);
  const src = path.join(dir, 'snapshots', name);
  if (!fs.existsSync(src)) throw Object.assign(new Error('快照不存在'), { status: 404 });
  readSnapshot(src); // 损坏的快照不允许回溯
  const bak = backupSave(dir, 'before-rollback') || '（原来没有存档）';
  restoreSnapshotFile(src, dir);
  new OpJournal(path.join(dir, 'ops.jsonl')).append({ op: 'rollback', to: name, at: new Date().toISOString() });
  return bak;
}
