// 行动（P1）：使用能力、送东西、传授、研究
// 以 Town 的方法形式挂载（见 sim.js 末尾的 mixin），方法里的 this 就是 Town。
import { addMemory } from '../memory.js';
import { useAbility, describeAbility, findAbility, matchResearch } from '../kernel/abilities.js';
import { agentsNear, posOf } from '../kernel/effects.js';
import { clamp, clampStr } from './util.js';

export class Actions {
  /** 校验并规范化 LLM 给出的行动；不合法返回 undefined（该条日程照常执行，只是没有行动） */
  normalizeAct(act) {
    if (!act || typeof act !== 'object') return undefined;
    const type = String(act.type || '');
    const to = clampStr(act.to, 12);
    if (type === 'use' && findAbility(this.spec, act.ability)) {
      const target = clampStr(act.target, 12);
      return { type, ability: act.ability, ...(target && target !== 'null' ? { target } : {}) };
    }
    if (type === 'give' && Object.hasOwn(this.spec.items, act.item) && to) {
      return { type, item: act.item, to, count: clamp(Math.floor(Number(act.count) || 1), 1, 5) };
    }
    if (type === 'teach' && findAbility(this.spec, act.ability) && to) return { type, ability: act.ability, to };
    if (type === 'research' && clampStr(act.topic, 20)) return { type, topic: clampStr(act.topic, 20) };
    return undefined;
  }

  /** 到达日程地点时执行行动；对象不在身边时稍后重试 */
  runAct(a, e, retry = false) {
    const act = e?.act;
    if (!act || e.sleep || (!retry && a.actKey === e.key)) return;
    a.actKey = e.key;
    let r;
    if (act.type === 'research') {
      a.researching = { topic: act.topic, since: this.t, key: e.key, loc: a.locId };
      a.action = { text: `研究：${act.topic}`, emoji: '📚' };
      r = { ok: true };
    } else if (act.type === 'use') r = useAbility(this, a, act.ability, act.target, '（按计划）');
    else if (act.type === 'give') r = this.giveItem(a, act);
    else if (act.type === 'teach') r = this.teach(a, act);
    if (r?.ok || !r) { a.pendingAct = null; return; }
    if (r.retry) {
      const tries = (a.pendingAct?.key === e.key ? a.pendingAct.tries : 0) + 1;
      a.pendingAct = tries <= 6 ? { key: e.key, next: this.t + 10, tries } : null;
    } else a.pendingAct = null;
    if (!a.pendingAct) addMemory(a, { t: this.t, type: 'obs', text: `本想${e.activity}，可惜没成：${r.reason}`, importance: 2 });
  }

  findNear(a, ref, r = 3) {
    const s = String(ref || '').trim();
    return agentsNear(this, posOf(this, a), r, a).find((o) => o.id === s || o.name === s || (s && s.includes(o.name))) || null;
  }

  giveItem(a, { item, to, count = 1 }) {
    const it = this.spec.items[item];
    if ((a.inventory[item] || 0) < 1) return { ok: false, reason: `身上没有${it.name}` };
    const b = this.findNear(a, to);
    if (!b) return { ok: false, reason: `${to}不在身边`, retry: true };
    const n = Math.min(count, a.inventory[item]);
    a.inventory[item] -= n;
    if (!a.inventory[item]) delete a.inventory[item];
    b.inventory[item] = Math.min(99, (b.inventory[item] || 0) + n);
    addMemory(a, { t: this.t, type: 'obs', text: `我送给${b.name}${it.name}×${n}`, importance: 3 });
    addMemory(b, { t: this.t, type: 'obs', text: `${a.name}送给我${it.name}×${n}`, importance: 4 });
    const rel = (b.relations[a.id] ||= { affinity: 0, note: '' });
    rel.affinity = clamp(rel.affinity + 3, -100, 100);
    if (!a.convoId) this.say(a, `${it.emoji} 这个给你！`, 3500);
    this.log('gift', `🎁 ${a.name}送给${b.name} ${it.emoji}${it.name}×${n}`, { agents: [a.id, b.id] });
    this.emit('agent', a.id); this.emit('agent', b.id);
    return { ok: true };
  }

  teach(a, { ability, to }) {
    const ab = findAbility(this.spec, ability);
    if (!a.abilities.includes(ability)) return { ok: false, reason: `自己还不会「${ab.name}」` };
    if (!ab.learn?.teach) return { ok: false, reason: `「${ab.name}」没法教给别人` };
    const b = this.findNear(a, to);
    if (!b) return { ok: false, reason: `${to}不在身边`, retry: true };
    if (b.abilities.includes(ability)) return { ok: false, reason: `${b.name}已经会了` };
    if (a.body.stamina < 10) return { ok: false, reason: '太累了，教不动' };
    a.body.stamina -= 10;
    this.learnAbility(b, ability, `跟${a.name}`);
    for (const [x, y] of [[a, b], [b, a]]) {
      const rel = (x.relations[y.id] ||= { affinity: 0, note: '' });
      rel.affinity = clamp(rel.affinity + 3, -100, 100);
    }
    addMemory(a, { t: this.t, type: 'obs', text: `我把「${ab.name}」教给了${b.name}`, importance: 5 });
    return { ok: true };
  }

  /** 研究结束：在合适的地点钻研足够久，且课题对得上，就能学会新能力 */
  finishResearch(a) {
    const r = a.researching;
    a.researching = null;
    if (!r || this.t - r.since < 45) return;
    const ab = r.loc && matchResearch(this.spec, a, r.loc, r.topic);
    if (ab) this.learnAbility(a, ab.id, '通过研究');
    else addMemory(a, { t: this.t, type: 'obs', text: `在${this.locName(r.loc)}研究了「${r.topic}」，有了些头绪`, importance: 3 });
  }

  learnAbility(a, id, how = '') {
    const ab = findAbility(this.spec, id);
    if (!ab || a.abilities.includes(id)) return false;
    a.abilities.push(id);
    addMemory(a, { t: this.t, type: 'obs', text: `我${how}学会了「${ab.name}」：${ab.desc}`, importance: 6 });
    this.log('learn', `✨ ${a.name}${how}学会了${ab.emoji || ''}「${ab.name}」`, { agents: [a.id], ability: id });
    this.emit('agent', a.id);
    return true;
  }

  abilityList(a) {
    const abs = a.abilities.map((id) => findAbility(this.spec, id)).filter(Boolean);
    return abs.length ? `${a.name}会的能力：\n${abs.map((ab) => `- ${describeAbility(this, a, ab)}`).join('\n')}\n` : '';
  }

  /** 规划 / 重新规划时告诉 LLM：会什么、有什么、可以做哪些行动 */
  actionBlock(a) {
    const inv = Object.entries(a.inventory).map(([k, n]) => `${this.spec.items[k]?.emoji || ''}${this.spec.items[k]?.name || k}×${n}（${k}）`).join('、');
    const labs = [...new Set(this.spec.abilities.filter((ab) => ab.learn?.research && !a.abilities.includes(ab.id)).map((ab) => ab.learn.research.location))];
    const teachable = a.abilities.map((id) => findAbility(this.spec, id)).filter((ab) => ab?.learn?.teach).map((ab) => ab.id);
    return `${this.abilityList(a)}${inv ? `身上的物品：${inv}\n` : ''}${labs.length ? `在${labs.map((l) => `${this.locName(l)}（${l}）`).join('、')}钻研合适的课题，也许能学会新本事。\n` : ''}日程条目可以附带一个可选的 act 字段（没有就不写）：
{"type":"use","ability":"能力id","target":"对象姓名"} 使用能力（要在合适的地点；对别人使用时要和对方在同一地点）
{"type":"give","item":"物品id","to":"姓名","count":1} 把身上的东西送人（要和对方在同一地点）
${teachable.length ? `{"type":"teach","ability":"能力id","to":"姓名"} 把会的本事教给别人（可教：${teachable.join('、')}）\n` : ''}{"type":"research","topic":"课题"} 在当前地点研究一个课题（至少一小时）
`;
  }
}
