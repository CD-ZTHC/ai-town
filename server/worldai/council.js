// 拆除的议事（地图演变设计 §3.4）：拆除（或把建筑变成废墟）不是架构师一个人说了算。
//   1 议事会：当事人（住在这里、在这里工作的人）+ 与他们最亲近的几位居民，在附近的公共地点开一场多人场景
//   2 表态：一次「居民议事」调用，给出每位居民的赞成 / 反对与理由，以及当事人是否同意搬走
//   3 判定：当事人都同意 → 投票人过半数即通过；有当事人不同意 → 需要投票人全票；过半数反对一律否决
//   4 通过之后照常交给终审人（终审人可以否决，但不能推翻居民的否决）；否决之后 10 天内不能再提
// 拆除落地时，当事人得到一条重要记忆；被全票通过的当事人心情失落，并留下一条「旧居」的剧情线程。
import * as llm from '../llm.js';
import { addMemory } from '../memory.js';
import { impactOf } from '../kernel/impact.js';

const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
export const VETO_DAYS = 10;
const RETRY_MIN = 60; // 模型暂时不可用时，每游戏小时再试一次
const GIVE_UP_MIN = 24 * 60; // 一天之内开不成议事会，提案作废
const MEETING_EXTRA = 4; // 议事会上除当事人以外最多几位居民

/** 判定（纯函数，便于测试）：stakeholders / voters 为 id 列表，consent / votes 为 { id: { yes } } */
export function judge({ stakeholders, voters, consent, votes }) {
  const cast = voters.filter((id) => votes[id]);
  const yes = cast.filter((id) => votes[id].yes).length;
  const no = cast.length - yes;
  const agreed = stakeholders.every((id) => consent[id]?.yes);
  const tally = { yes, no, voters: voters.length, cast: cast.length, agreed };
  if (no * 2 > cast.length && cast.length) return { pass: false, forced: false, why: `${no} 人反对，超过半数`, tally };
  if (!stakeholders.length || agreed) {
    if (!cast.length) return { pass: agreed && stakeholders.length > 0, forced: false, why: stakeholders.length ? '当事人同意，没有其他居民表态' : '没有居民表态', tally };
    return yes * 2 > cast.length ? { pass: true, forced: false, why: `${yes}/${cast.length} 赞成${stakeholders.length ? '，当事人同意' : ''}`, tally } : { pass: false, forced: false, why: `赞成的只有 ${yes}/${cast.length}，没有过半`, tally };
  }
  // 有当事人不同意：其他居民必须全票赞成（而且每个人都表了态）
  if (cast.length && yes === voters.length) return { pass: true, forced: true, why: `当事人不同意，但其余 ${yes} 人全票赞成`, tally };
  return { pass: false, forced: false, why: `当事人不同意，其余居民不是全票赞成（${yes}/${voters.length}）`, tally };
}

export class Council {
  constructor(town) { this.town = town; }

  /** 世界状态里的否决记录：{ 建筑id: 第几天之前不能再提 } */
  get vetoes() { return ((this.town.mapState ||= {}).vetoes ||= {}); }

  target(p) {
    const o = p.ops.find((x) => x.op === 'removeBuilding' || (x.op === 'setBuildingState' && x.args?.state === 'ruin'));
    return o ? { op: o, id: o.args.id, b: this.town.spec.buildings.find((b) => b.id === o.args.id) } : null;
  }

  /** 当事人：在场或出门在外、住在这里或在这里工作的人（生物除外）；投票人：其余在场的居民 */
  people(id) {
    const town = this.town;
    const im = impactOf(town.spec, id);
    const stake = [...new Set([...im.residents, ...im.workers])].filter((x) => town.byId[x] && town.spec.personas.find((p) => p.id === x)?.status !== 'departed');
    const voters = town.agents.filter((a) => a.kind !== 'creature' && !stake.includes(a.id)).map((a) => a.id);
    return { stakeholders: stake, voters };
  }

  /** 提案通过设定考据之后：召开议事会（模型不可用时等它回来） */
  start(p) {
    const town = this.town;
    const t = this.target(p);
    if (!t?.b) return town.proposalSystem.finish(p, 'failed', '要拆的建筑已经不在了');
    const { stakeholders, voters } = this.people(t.id);
    p.status = 'council';
    p.council = { status: 'meeting', buildingId: t.id, buildingName: t.b.name, stakeholders, voters, startT: Math.floor(town.t), votes: {}, consent: {} };
    const verb = t.op.op === 'removeBuilding' ? '拆掉' : '任由它荒废成废墟';
    town.log('proposal', `🏛️ 要不要${verb}「${t.b.name}」？镇上要开议事会商量${stakeholders.length ? `，${stakeholders.map((id) => town.byId[id].name).join('、')}是当事人` : ''}`, { agents: stakeholders.slice(0, 4) });
    // 议事会：当事人 + 与他们最亲近的几位居民
    const close = (id) => stakeholders.reduce((s, x) => s + Math.max(0, town.byId[x]?.relations[id]?.affinity ?? 0) + Math.max(0, town.byId[id]?.relations[x]?.affinity ?? 0), 0);
    const extra = voters.filter((id) => town.agents.includes(town.byId[id])).sort((a, b) => close(b) - close(a)).slice(0, MEETING_EXTRA);
    const members = [...stakeholders.filter((id) => town.agents.includes(town.byId[id])), ...extra].slice(0, 6);
    const where = this.meetingPlace(t.b);
    if (llm.stats.enabled && members.length >= 2 && where) {
      p.council.sceneId = town.scenes.schedule({
        location: where, participants: members, title: `议事：${t.b.name}`.slice(0, 16),
        purpose: `大家商量要不要${verb}「${t.b.name}」。提议的理由：${p.motive || p.title}。${stakeholders.length ? `${stakeholders.map((id) => town.byId[id].name).join('、')}住在或在这里做事，会被影响。` : ''}每个人说出自己的看法。`.slice(0, 160),
        council: p.id,
      });
    } else {
      p.council.status = 'deliberating';
      p.council.nextT = Math.floor(town.t);
    }
    town.emit('proposals');
  }

  meetingPlace(b) {
    const town = this.town;
    const cx = b.x + b.w / 2, cy = b.y + b.h;
    let best = null;
    for (const id of town.publicLocs()) {
      if (id === b.id || town.locRegion(id) !== (b.region || 'town')) continue;
      const c = town.locCenter(id);
      const d = c ? Math.hypot(c.x - cx, c.y - cy) : Infinity;
      if (!best || d < best.d) best = { id, d };
    }
    return best?.id || null;
  }

  /** 议事会结束（或没凑齐人）：开始表态 */
  onScene(sc, res) {
    const p = this.town.proposalSystem.get(sc.council);
    if (!p?.council || p.status !== 'council') return;
    p.council.summary = res?.summary ? str(res.summary, 80) : null;
    p.council.status = 'deliberating';
    p.council.nextT = Math.floor(this.town.t);
  }

  tick() {
    const town = this.town;
    for (const p of town.proposalSystem.list) {
      const c = p.council;
      if (p.status !== 'council' || !c || c.status !== 'deliberating' || c.busy || town.t < (c.nextT ?? 0)) continue;
      if (town.t - c.startT > GIVE_UP_MIN) { town.proposalSystem.finish(p, 'rejected', '一直没能开成议事会'); continue; }
      if (!llm.stats.enabled || llm.budgetLeft() <= 0) { c.nextT = Math.floor(town.t) + RETRY_MIN; continue; }
      c.busy = true;
      this.deliberate(p).catch((e) => { console.warn('[council]', e.message); c.nextT = Math.floor(town.t) + RETRY_MIN; }).finally(() => { c.busy = false; });
    }
  }

  prompt(p) {
    const town = this.town;
    const c = p.council;
    const t = this.target(p);
    const nm = (id) => town.byId[id]?.name || id;
    const remap = t.op.args.remap || {};
    const about = (a) => a.memories.filter((m) => m.text.includes(c.buildingName)).slice(-2).map((m) => m.text).join('；');
    const rel = (a) => c.stakeholders.map((x) => { const r = a.relations[x]; return r ? `对${nm(x)}好感${r.affinity}` : null; }).filter(Boolean).join('，');
    const line = (id) => { const a = town.byId[id]; return `- ${a.name}（${a.role}）：${str(a.persona, 60)}${rel(a) ? `；${rel(a)}` : ''}${about(a) ? `；记得：${str(about(a), 80)}` : ''}`; };
    return `${town.timeBlock()}
${town.spec.meta.name}要决定：要不要${t.op.op === 'removeBuilding' ? '拆掉' : '任由它荒废成废墟'}「${c.buildingName}」。
提议的理由：${p.motive || p.title}
${c.stakeholders.length ? `当事人（住在这里或在这里做事）：${c.stakeholders.map(nm).join('、')}。拆了之后${remap.residents ? `住户搬到「${town.locName(remap.residents)}」` : ''}${remap.workers ? `，在这里做事的人改去「${town.locName(remap.workers)}」` : ''}。` : '这里现在没有人住，也没有人在这里做事。'}
${c.summary ? `议事会上：${c.summary}` : '（没有开成议事会，大家各自表态。）'}
${c.stakeholders.length ? `当事人：\n${c.stakeholders.map(line).join('\n')}\n` : ''}其他居民：
${c.voters.map(line).join('\n')}

请按每个人的性格、与当事人的关系和对这个地方的感情，写出他们真实的态度（不要一边倒，除非理由确实压倒性）。
输出 JSON：{"consent":{"当事人姓名":{"yes":true或false,"reason":"≤30字"}},"votes":{"其他居民姓名":{"yes":true或false,"reason":"≤30字"}},
"memories":{"当事人姓名":{"agree":"如果他同意、真的拆了，他第一人称记住的话（≤80字）","forced":"如果他不同意、但大家全票通过拆了，他第一人称记住的话（≤80字）"}},
"thread":{"title":"如果当事人不情愿地搬走，之后可能的故事（≤12字）","hook":"一句话（≤60字）"}}`;
  }

  async deliberate(p) {
    const town = this.town;
    const c = p.council;
    const res = await llm.chatJSON([
      town.sys('你现在要代表镇上的每一位居民表态，而不是扮演某一个人。'),
      { role: 'user', content: this.prompt(p) },
    ], { label: '居民议事', agent: '议事会', maxTokens: 2500, temperature: 0.8, tier: 'smart', timeoutMs: 120_000, attempts: 2 });
    if (p.status !== 'council') return; // 等待期间被撤销了
    const byName = (name) => town.agents.find((a) => a.name === str(name, 16) || a.id === str(name, 32));
    const pick = (obj, ids) => {
      const out = {};
      for (const [k, v] of Object.entries(obj && typeof obj === 'object' ? obj : {})) {
        const a = byName(k);
        if (!a || !ids.includes(a.id)) continue;
        const yes = typeof v === 'boolean' ? v : v?.yes === true || v?.yes === 'true';
        out[a.id] = { yes, reason: str(v?.reason, 30) };
      }
      return out;
    };
    c.consent = pick(res.consent, c.stakeholders);
    c.votes = pick(res.votes, c.voters);
    // 当事人没表态的算不同意；投票人漏得太多就再问一次
    for (const id of c.stakeholders) c.consent[id] ||= { yes: false, reason: '' };
    if (c.voters.length && Object.keys(c.votes).length < Math.ceil(c.voters.length * 0.6)) throw new Error('表态的人太少');
    c.memories = {};
    for (const [k, v] of Object.entries(res.memories && typeof res.memories === 'object' ? res.memories : {})) {
      const a = byName(k);
      if (a && c.stakeholders.includes(a.id)) c.memories[a.id] = { agree: str(v?.agree, 80), forced: str(v?.forced, 80) };
    }
    if (res.thread?.title) c.thread = { title: str(res.thread.title, 12), hook: str(res.thread.hook, 60) };
    const r = judge(c);
    Object.assign(c, { status: 'done', pass: r.pass, forced: r.forced, why: r.why, tally: r.tally, doneT: Math.floor(town.t) });
    for (const [id, v] of Object.entries({ ...c.consent, ...c.votes })) {
      const a = town.byId[id];
      if (a) addMemory(a, { t: town.t, type: 'event', text: `议事会上，我${v.yes ? '赞成' : '反对'}拆掉「${c.buildingName}」${v.reason ? `：${v.reason}` : ''}`, importance: c.stakeholders.includes(id) ? 7 : 5 });
    }
    const ps = town.proposalSystem;
    if (!r.pass) {
      this.vetoes[c.buildingId] = town.day + VETO_DAYS;
      town.log('proposal', `🏛️ 议事结果：不拆「${c.buildingName}」（${r.why}）`, { agents: c.stakeholders.slice(0, 4) });
      ps.finish(p, 'rejected', `居民否决：${r.why}`);
      return;
    }
    town.log('proposal', `🏛️ 议事结果：同意拆「${c.buildingName}」（${r.why}）${r.forced ? '。当事人舍不得，但镇上的人都认为该拆' : ''}`, { agents: c.stakeholders.slice(0, 4) });
    ps.route(p);
  }

  /** 拆除落地：当事人的重要记忆；被全票通过的当事人失落、记下谁赞成，并留下一条剧情线程 */
  afterApplied(p) {
    const town = this.town;
    const c = p.council;
    if (!c?.pass) return;
    for (const id of c.stakeholders) {
      const a = town.byId[id];
      if (!a) continue;
      const forced = c.consent[id]?.yes === false;
      const m = c.memories?.[id] || {};
      const text = forced ? (m.forced || `「${c.buildingName}」还是拆了。我不同意，可镇上的人都赞成。我在门口站了很久，什么也没说。`)
        : (m.agree || `我答应了。「${c.buildingName}」拆掉那天，我回头看了好几眼。`);
      addMemory(a, { t: town.t, type: 'event', text, importance: 9 });
      if (!forced) continue;
      a.mood = { text: '失落', emoji: '😢' };
      for (const v of c.voters) {
        if (!c.votes[v]?.yes) continue;
        const r = (a.relations[v] ||= { affinity: 0, note: '' });
        if (!r.note.includes(c.buildingName)) r.note = str(`${r.note ? `${r.note}；` : ''}赞成拆了「${c.buildingName}」`, 60);
      }
    }
    const forcedOnes = c.stakeholders.filter((id) => c.consent[id]?.yes === false && town.byId[id]);
    if (forcedOnes.length) {
      const who = town.byId[forcedOnes[0]].name;
      const id = `oldhome_${c.buildingId}`.slice(0, 24);
      try {
        town.applyWorldOp({ op: 'addThread', args: { id, title: (c.thread?.title || `${who}的旧居`).slice(0, 20), hook: (c.thread?.hook || `${who}不愿搬离「${c.buildingName}」，可它还是被拆了。`).slice(0, 80) } }, { by: 'proposal', proposal: p.id }, { quiet: true });
      } catch {}
    }
  }

  /** 拆除被撤销：经历过的事情还在，只是多了一段「后来不拆了」 */
  afterUndone(p) {
    const c = p.council;
    if (!c?.pass) return;
    for (const id of c.stakeholders) {
      const a = this.town.byId[id];
      if (a) addMemory(a, { t: this.town.t, type: 'event', text: `后来大家决定不拆「${c.buildingName}」了`, importance: 7 });
    }
  }

  view(p) {
    const c = p.council;
    if (!c) return null;
    const nm = (id) => this.town.byId[id]?.name || id;
    return {
      status: c.status, building: c.buildingName, pass: c.pass ?? null, forced: c.forced ?? false, why: c.why || null, summary: c.summary || null,
      stakeholders: c.stakeholders.map((id) => ({ name: nm(id), yes: c.consent[id]?.yes ?? null, reason: c.consent[id]?.reason || '' })),
      votes: c.voters.map((id) => ({ name: nm(id), yes: c.votes[id]?.yes ?? null, reason: c.votes[id]?.reason || '' })),
    };
  }
}
