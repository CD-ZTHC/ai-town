// 抉择投票：访客投票（每个 IP 一票）+ 居民在场景中表达的立场 → 管理员终审。
// 截止时若管理员还没裁决：需要管理员终审时（公网 + 设置了令牌）再等 ADMIN_WAIT 游戏分钟。
// 之后（或不需要管理员时）：有效票 ≥ 3 且不平票按多数决定，否则交给 AI 裁决官（自主演化 E1），
// 保证无人值守时剧情也能继续。
const ADMIN_WAIT = 30;
const MIN_VOTES = 3;

export class VoteSystem {
  constructor(town) {
    this.town = town;
    this.requireAdmin = false;
    town.decisions?.register('vote', {
      options: (d) => this.get(d.ref)?.options || [],
      majority: (d) => this.majority(this.get(d.ref)),
      preempt: (d) => {
        const v = this.get(d.ref);
        return v && this.clear(v) ? { decision: 'adopt', option: this.majority(v), by: 'majority', reasons: [], confidence: null } : null;
      },
      dossier: (d) => {
        const v = this.get(d.ref);
        const t = this.tally(v);
        const stance = Object.entries(v.residents).map(([id, o]) => `${this.town.byId[id]?.name || id}支持${o}`).join('、') || '（无）';
        return `剧情抉择：${v.question}\n票数：${v.options.map((o) => `${o.label} ${t[o.id].total}`).join('，')}（票数太少或平票，需要你来选）\n居民的立场：${stance}`;
      },
      resolve: (d, { option, by }) => { const v = this.get(d.ref); if (v && v.status !== 'closed') this.resolve(v, option, by); },
    });
  }

  /** 票数是否足够且没有平票 */
  clear(v) {
    const t = this.tally(v);
    const totals = v.options.map((o) => t[o.id].total).sort((a, b) => b - a);
    return totals.reduce((s, x) => s + x, 0) >= MIN_VOTES && totals[0] > (totals[1] ?? -1);
  }

  /** 截止后没有管理员裁决：票数清楚就按多数，否则交给 AI 裁决官（立即裁决） */
  settle(v) {
    if (this.clear(v) || !this.town.decisions) return this.resolve(v, this.majority(v), 'majority');
    v.status = 'awaiting';
    this.town.decisions.open({ kind: 'vote', ref: v.id, title: v.question, risk: 'low', window: { game: 0 } });
  }
  get list() { return (this.town.voteState ||= []); }

  open({ question, options, minutes = 90, arc = null }) {
    const town = this.town;
    const v = {
      id: `v${++town.seq}`, question: String(question).slice(0, 40),
      options: options.slice(0, 4).map((o) => ({ id: String(o.id).slice(0, 16), label: String(o.label).slice(0, 20), desc: String(o.desc || '').slice(0, 60) })),
      openedT: Math.floor(town.t), closesT: Math.floor(town.t) + minutes, arc, visitors: {}, residents: {}, status: 'open', result: null,
    };
    this.list.push(v);
    if (this.list.length > 20) this.list.shift();
    town.log('vote', `🗳️ 小镇面临抉择：${v.question}（${v.options.map((o) => o.label).join(' / ')}）`, {});
    town.emit('story');
    return v;
  }

  get(id) { return this.list.find((v) => v.id === id); }
  openFor(arc) { return this.list.find((v) => v.arc === arc && (v.status === 'open' || v.status === 'awaiting')); }

  /** 访客投票：key 为访客的 IP（或其哈希），每人每次抉择一票 */
  cast(id, key, option) {
    const v = this.get(id);
    if (!v || (v.status !== 'open' && v.status !== 'awaiting')) return '这次抉择已经结束了';
    if (!v.options.some((o) => o.id === option)) return '没有这个选项';
    if (v.visitors[key]) return '你已经投过票了';
    v.visitors[key] = option;
    this.town.emit('story');
    return null;
  }

  castResident(id, agentId, option) {
    const v = this.get(id);
    if (!v || !v.options.some((o) => o.id === option)) return false;
    v.residents[agentId] = option;
    const a = this.town.byId[agentId];
    const o = v.options.find((x) => x.id === option);
    if (a) this.town.log('vote_cast', `${a.name}支持：${o.label}`, { agents: [agentId] });
    return true;
  }

  tally(v) {
    const out = Object.fromEntries(v.options.map((o) => [o.id, { residents: 0, visitors: 0, total: 0 }]));
    for (const opt of Object.values(v.residents)) if (out[opt]) { out[opt].residents++; out[opt].total++; }
    for (const opt of Object.values(v.visitors)) if (out[opt]) { out[opt].visitors++; out[opt].total++; }
    return out;
  }

  majority(v) {
    const t = this.tally(v);
    // 同票时按选项顺序
    return v.options.reduce((best, o) => (t[o.id].total > t[best.id].total ? o : best), v.options[0]).id;
  }

  /** 管理员终审 */
  decide(id, option, by = 'admin') {
    const v = this.get(id);
    if (!v || v.status === 'closed') return '这次抉择已经结束了';
    if (!v.options.some((o) => o.id === option)) return '没有这个选项';
    this.town.decisions?.cancel('vote', v.id);
    this.resolve(v, option, by);
    return null;
  }

  tick() {
    const t = this.town.t;
    for (const v of this.list) {
      if (v.status === 'open' && t >= v.closesT) {
        if (this.requireAdmin) {
          v.status = 'awaiting';
          v.awaitUntil = v.closesT + ADMIN_WAIT;
          this.town.log('vote', `🗳️ 「${v.question}」投票截止，等待管理员终审`, {});
          this.town.emit('story');
        } else this.settle(v);
      } else if (v.status === 'awaiting' && v.awaitUntil != null && t >= v.awaitUntil) {
        v.awaitUntil = null;
        this.settle(v);
      }
    }
  }

  resolve(v, option, by) {
    v.status = 'closed';
    v.result = { option, by, t: Math.floor(this.town.t) };
    const o = v.options.find((x) => x.id === option);
    this.town.log('vote', `🗳️ 抉择揭晓：${o.label}（${{ admin: '管理员终审', owner: '创建者终审', majority: '多数决定', ai: 'AI 裁决官', fallback: '多数决定' }[by] || by}）`, {});
    if (v.arc) this.town.arcs.onVoteResult(v.arc, option);
    this.town.emit('story');
  }

  view(v, key = null) {
    return {
      id: v.id, question: v.question, options: v.options, status: v.status, closesT: v.closesT, awaitUntil: v.awaitUntil || null,
      tally: this.tally(v), result: v.result, mine: key ? v.visitors[key] || null : null,
    };
  }
}
