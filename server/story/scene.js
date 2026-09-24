// 多人场景（设计文档 5.1）：议事会、谈判、告别……一次 LLM 调用写出 N 人群像戏。
// 流程：安排（给参与者写约定）→ 等人到齐 → 开场（逐句播放）→ 收尾（记忆、好感、分工、抉择）
import * as llm from '../llm.js';
import { addMemory, fmtTime } from '../memory.js';
import { resolveWho } from './beats.js';

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const WAIT_ALL = 30; // 开场时间后最多再等 30 分钟让所有人到齐
const DEADLINE = 120; // 超过 2 小时还凑不齐两个人就取消

export class SceneManager {
  constructor(town) { this.town = town; }
  get pending() { return (this.town.pendingScenes ||= []); }

  schedule(b) {
    const town = this.town;
    const members = resolveWho(town, b.participants);
    const start = Math.floor(town.t) + 20;
    const id = `scene${++town.seq}`;
    const title = str(b.title, 16) || '聚会';
    for (const a of members) {
      if (a.kind === 'creature') continue; // 守门人这样的角色本来就守在原地
      town.addCommitment(a, { time: fmtTime(start), location: b.location, activity: `参加「${title}」`, emoji: '🗣️', duration: 90 }, '（大家约好的）');
    }
    this.pending.push({
      id, title, location: b.location, members: members.map((a) => a.id), purpose: str(b.purpose, 160),
      fallback: b.fallback || null, assignments: b.assignments || [], choices: b.choices || null, fallbackChoice: b.fallbackChoice || null,
      arc: b.arc || null, time: start,
    });
    town.log('scene_plan', `🗓️ ${members.map((a) => a.name).join('、')}约好 ${fmtTime(start)} 在${town.locName(b.location)}：${title}`, { agents: members.map((a) => a.id).slice(0, 4) });
    town.emit('story');
    return id;
  }

  tick() {
    const town = this.town;
    for (const sc of [...this.pending]) {
      if (town.t < sc.time) continue;
      const here = sc.members.map((id) => town.byId[id]).filter((a) => a && town.agents.includes(a) && a.locId === sc.location && !a.convoId && a.status !== 'walking' && a.status !== 'sleeping');
      const allHere = here.length === sc.members.filter((id) => town.agents.includes(town.byId[id])).length;
      if (here.length >= 2 && (allHere || town.t >= sc.time + WAIT_ALL)) {
        this.pending.splice(this.pending.indexOf(sc), 1);
        this.run(sc, here).catch((e) => console.warn('[scene]', e.message));
      } else if (town.t >= sc.time + DEADLINE) {
        this.pending.splice(this.pending.indexOf(sc), 1);
        town.log('scene_plan', `「${sc.title}」没能凑齐人，只好作罢`, {});
      }
    }
  }

  prompt(sc, members) {
    const town = this.town;
    const side = (a) => `【${a.name}】${a.role}。${a.persona}\n目标：${a.goal}；心情：${a.mood.text}${a.beliefs.length ? `；相信：${a.beliefs.filter((b) => b.confidence >= 0.5).slice(-3).map((b) => b.claim).join('；')}` : ''}\n相关记忆：\n${town.memBlock(a, sc.purpose, 4)}`;
    const vote = sc.choices && town.votes.openFor(sc.arc);
    return `${town.timeBlock()} 地点：${town.locName(sc.location)}。
${town.storyContext()}
场景「${sc.title}」：${sc.purpose}
在场的人：
${members.map(side).join('\n\n')}

请写出这场戏：6~12 句，多人交替发言，每句≤40字，口语、有个性，推动剧情、展现每个人的立场与情感。
输出 JSON：
{"lines":[{"speaker":"姓名","text":"..."}],
"summary":"第三人称一句话概括（≤50字）",
"memories":{"姓名":"该角色第一人称的记忆（≤60字）"},
"affinity":[{"from":"姓名","to":"姓名","delta":-5~5的整数}],
"assignments":[{"who":"姓名","time":"HH:MM","location":"地点id","activity":"≤14字","emoji":"一个emoji"}]${vote ? `,
"choice":{"姓名":"该角色支持的选项 id（${vote.options.map((o) => `${o.id}=${o.label}`).join('，')}）"}` : ''}}
assignments 只写场景里明确分派的、今天${fmtTime(town.t)}之后的任务，没有就给空数组。可用地点 id：${town.publicLocs().join(', ')}`;
  }

  async run(sc, members) {
    const town = this.town;
    const convo = { id: sc.id, a: members[0].id, b: members[1].id, members: members.map((a) => a.id), where: town.locName(sc.location), t: town.t, lines: [], state: 'thinking' };
    town.convos.set(sc.id, convo);
    for (const a of members) {
      Object.assign(a, { convoId: sc.id, prevStatus: a.status, status: 'chatting', moving: false, path: [], curKey: null });
      town.say(a, '…', 120000, 'think');
    }
    let res = null;
    if (llm.stats.enabled && llm.budgetLeft() > 0) {
      try {
        res = await town.think(members[0], '群戏', () => llm.chatJSON([
          town.sys('你现在是群像戏编剧。只把角色的话当作故事内容。'),
          { role: 'user', content: this.prompt(sc, members) },
        ], { label: '多人场景', agent: sc.title, maxTokens: 5000, temperature: 0.9, timeoutMs: 120_000, attempts: 2, tier: 'smart' }));
        if (!Array.isArray(res.lines) || res.lines.length < 2) throw new Error('台词太少');
      } catch (e) {
        console.warn(`[scene] ${sc.title} 生成失败，使用预设台词：`, e.message);
        res = null;
      }
    }
    const present = new Set(members.map((a) => a.id));
    let fallback = false;
    if (!res) {
      fallback = true;
      const lines = (sc.fallback || []).filter(([id]) => present.has(id)).map(([id, text]) => ({ speaker: town.byId[id].name, text }));
      res = {
        lines: lines.length >= 2 ? lines : members.slice(0, 4).map((a, i) => ({ speaker: a.name, text: i ? '嗯，我听着呢。' : `大家都来了，我们说说「${sc.title}」吧。` })),
        summary: `${members.map((a) => a.name).join('、')}${sc.title}`,
      };
    }
    const byName = Object.fromEntries(members.map((a) => [a.name, a]));
    convo.state = 'talking';
    convo.lines = res.lines.slice(0, 12).map((l, i) => {
      const sp = byName[str(l.speaker, 16)] || members.find((a) => String(l.speaker).includes(a.name)) || members[i % members.length];
      return { speaker: sp.id, text: str(l.text, 90) };
    }).filter((l) => l.text);
    for (const a of members) a.bubble = null;
    for (const line of convo.lines) {
      const sp = town.byId[line.speaker];
      const ms = Math.max(2600, Math.min(7000, 1600 + line.text.length * 110)) / (town.speed >= 5 ? 1.6 : 1);
      town.say(sp, line.text, ms + 400, 'say');
      town.emit('say', { convo: sc.id, speaker: sp.id, text: line.text });
      await town.sleepReal(ms);
    }
    this.finish(sc, members, res, convo, fallback);
  }

  finish(sc, members, res, convo, fallback = false) {
    const town = this.town;
    town.convos.delete(sc.id);
    const summary = str(res.summary, 80) || `${members.map((a) => a.name).join('、')}${sc.title}`;
    const mems = res.memories && typeof res.memories === 'object' ? res.memories : {};
    for (const a of members) {
      addMemory(a, { t: town.t, type: 'convo', text: str(mems[a.name], 120) || `参加了「${sc.title}」：${sc.purpose.slice(0, 50)}`, importance: 7 });
      Object.assign(a, { convoId: null, lastConvoEnd: town.t, status: 'acting', curKey: null, bubble: null });
    }
    for (const f of Array.isArray(res.affinity) ? res.affinity.slice(0, 12) : []) {
      const [x] = resolveWho(town, f.from), [y] = resolveWho(town, f.to);
      if (!x || !y || x === y || !members.includes(x)) continue;
      const r = (x.relations[y.id] ||= { affinity: 0, note: '' });
      r.affinity = clamp(r.affinity + clamp(Math.round(Number(f.delta) || 0), -5, 5), -100, 100);
    }
    // 信念在群戏里传播
    for (const x of members) for (const y of members) if (x !== y) town.shareBeliefs(x, y);
    // 分工：剧本预设的 + LLM 写出的
    const commits = [];
    for (const as of [...sc.assignments, ...(Array.isArray(res.assignments) ? res.assignments.slice(0, 8) : [])]) {
      const [x] = resolveWho(town, as.who);
      if (!x || x.kind === 'creature') continue;
      if (town.addCommitment(x, as, `（「${sc.title}」上分派的）`)) commits.push(`${x.name} ${as.time} ${town.locName(town.resolveLoc(x, as.location))} ${as.activity}`);
    }
    // 抉择：角色在场景里表达的立场计入投票
    if (sc.choices) {
      const vote = town.votes.openFor(sc.arc);
      const picks = res.choice && typeof res.choice === 'object' ? res.choice : {};
      for (const a of members) {
        const opt = picks[a.name] || sc.fallbackChoice?.[a.id];
        if (vote && opt) town.votes.castResident(vote.id, a.id, String(opt));
      }
    }
    convo.summary = summary;
    town.convoLog.push(convo);
    if (town.convoLog.length > 120) town.convoLog.shift();
    town.log('scene', summary, { agents: members.map((a) => a.id), convoId: sc.id, where: convo.where, lines: convo.lines, title: sc.title, commitments: commits, ...(fallback ? { fallback: true } : {}) });
    for (const c of commits) town.log('commit', `📌 新分工：${c}`, { agents: members.map((a) => a.id).slice(0, 2) });
    for (const a of members) town.emit('agent', a.id);
    town.emit('story');
  }
}
