// 剧情弧引擎（设计文档 5.2）：按模板推进 伏笔 → 爆发 → 发展 → 高潮 → 余波。
// 节拍时间相对开弧日计算；错过的节拍（例如服务器休眠）会按顺序补上。
import { parseHM } from '../memory.ts';
import { runBeats } from './beats.js';

export class ArcEngine {
  constructor(town) { this.town = town; }
  get runs() { return (this.town.arcRuns ||= []); }
  active() { return this.runs.find((r) => r.status === 'active') || null; }
  template(id) { return this.town.spec.arcs.find((a) => a.id === id) || null; }

  canStart(id) {
    if (!this.template(id)) return `未知剧情弧：${id}`;
    if (this.active()) return '已经有剧情弧在进行中';
    if (this.runs.some((r) => r.template === id)) return '这个剧情弧已经上演过了';
    return null;
  }

  /** 远航 / 掷骰叙事者会在第一个合适的晚上自动开启剧情弧 */
  autoStart() {
    const town = this.town;
    if (!['voyage', 'chaos'].includes(town.spec.meta.storyteller) || this.runs.length || town.worldFlags.noAutoArc) return;
    const tpl = town.spec.arcs[0];
    if (!tpl) return;
    const at = parseHM(tpl.start?.at || '21:00');
    if (town.minute >= at && town.minute < at + 60) this.start(tpl.id, 'storyteller');
  }

  start(id, by = 'admin') {
    const err = this.canStart(id);
    if (err) return err;
    const tpl = this.template(id);
    const town = this.town;
    const run = { id: `arc${++town.seq}`, template: id, startDay: town.day, phase: tpl.phases[0].id, phaseStartT: Math.floor(town.t), fired: [], status: 'active', outcome: null, by };
    this.runs.push(run);
    town.log('arc', `${tpl.emoji || '🌀'} 故事开始了：《${tpl.title}》`, {});
    this.enterPhase(run, tpl.phases[0]);
    town.emit('story');
    return null;
  }

  at(run, when) { return (run.startDay - 1 + (when.d || 0)) * 1440 + (parseHM(when.at) ?? 0); }
  phaseDef(run) { return this.template(run.template)?.phases.find((p) => p.id === run.phase); }

  ctx(run, beatId) { return { arc: { id: run.id, template: this.template(run.template) }, source: `arc:${run.template}`, beatId }; }

  fire(run, beat) {
    if (run.fired.includes(beat.id)) return;
    run.fired.push(beat.id);
    const r = runBeats(this.town, beat.do, { privileged: true, ctx: this.ctx(run, beat.id) });
    for (const s of r.skipped) console.warn(`[arc] ${run.template}/${beat.id} 跳过 ${s.kind}：${s.error}`);
    this.town.director.onBeat();
  }

  enterPhase(run, phase) {
    run.phase = phase.id;
    run.phaseStartT = Math.floor(this.town.t);
    const tpl = this.template(run.template);
    if (phase.id !== tpl.phases[0].id) this.town.log('arc', `${tpl.emoji || '🌀'}《${tpl.title}》进入「${phase.name}」`, {});
    for (const b of phase.beats) if (b.when?.enter) this.fire(run, b);
    this.town.emit('story');
  }

  tick() {
    this.autoStart();
    const run = this.active();
    if (!run) return;
    const town = this.town;
    const tpl = this.template(run.template);
    if (!tpl) { run.status = 'done'; return; }
    const phase = this.phaseDef(run);
    // 按时间先后触发到点的节拍
    const due = phase.beats.filter((b) => !b.when?.enter && !run.fired.includes(b.id) && town.t >= this.at(run, b.when)).sort((x, y) => this.at(run, x.when) - this.at(run, y.when));
    for (const b of due) this.fire(run, b);
    if (phase.until && town.t >= this.at(run, phase.until)) {
      const i = tpl.phases.indexOf(phase);
      const next = tpl.phases[i + 1];
      if (next) this.enterPhase(run, next);
      else this.finish(run);
    }
  }

  onVoteResult(runId, choice) {
    const run = this.runs.find((r) => r.id === runId);
    if (run && run.status === 'active' && !run.outcome) this.ending(run, choice);
  }

  /** 智取成功率：基础值 + 士气 + 准备情况 */
  outwitChance(base = 0.35) {
    const town = this.town;
    let p = base + town.crisis.morale / 200;
    if (town.entities.some((e) => e.type === 'lamp_wheel')) p += 0.1;
    if ((town.byId.zhao?.inventory.lantern || 0) >= 2) p += 0.1;
    return Math.min(0.85, p);
  }

  ending(run, choice, { roll = Math.random() } = {}) {
    const tpl = this.template(run.template);
    const town = this.town;
    let key = choice;
    let e = tpl.endings[key];
    if (!e) return;
    if (e.check) {
      const p = this.outwitChance(e.check.base);
      if (roll >= p) {
        town.log('arc', `🎲 ${e.failText || '计划失败了……'}（成功率 ${Math.round(p * 100)}%）`, {});
        key = e.fail;
        e = tpl.endings[key];
      } else town.log('arc', `🎲 计划成功了！（成功率 ${Math.round(p * 100)}%）`, {});
    }
    run.outcome = { choice, ending: key, title: e.title, t: Math.floor(town.t) };
    town.log('arc', `🎬 结局：「${e.title}」`, {});
    const ctx = this.ctx(run, `ending:${key}`);
    runBeats(town, e.do, { privileged: true, ctx });
    runBeats(town, tpl.finale || [], { privileged: true, ctx });
    const after = tpl.phases.find((p) => p.id === 'aftermath');
    if (after) this.enterPhase(run, after); else this.finish(run);
  }

  finish(run) {
    run.status = 'done';
    const tpl = this.template(run.template);
    this.town.log('arc', `${tpl.emoji || '🌀'}《${tpl.title}》落幕${run.outcome ? `：「${run.outcome.title}」` : ''}`, {});
    this.town.emit('story');
  }

  /** 写进提示词的剧情背景 */
  contextText() {
    const run = this.active();
    if (!run) return '';
    const tpl = this.template(run.template);
    const phase = this.phaseDef(run);
    return `小镇正在经历《${tpl.title}》（当前阶段：${phase?.name || ''}）：${tpl.summary}`;
  }

  view() {
    return this.runs.map((r) => {
      const tpl = this.template(r.template);
      return {
        id: r.id, template: r.template, title: tpl?.title, emoji: tpl?.emoji, status: r.status, startDay: r.startDay, outcome: r.outcome,
        phase: r.phase, phases: (tpl?.phases || []).map((p) => ({ id: p.id, name: p.name })),
      };
    });
  }
}
