// 社交：居民对话、信念传播、旅人聊天与心声、小镇事件
// 以 Town 的方法形式挂载（见 sim.js 末尾的 mixin），方法里的 this 就是 Town。
import * as llm from '../llm.js';
import { addMemory, fmtTime } from '../memory.js';
import { rand, clampStr, pairKey, GUARD } from './util.js';
import { encodeRefs } from '../accounts/refs.js';

export class Social {
  checkConversations() {
    const m = this.minute;
    if (m < 6 * 60 + 40 || m > this.dayEnd || this.convos.size >= this.params.maxConvos) return;
    const free = this.agents.filter((a) => !a.convoId && (a.status === 'acting' || a.status === 'walking') && this.t - a.lastConvoEnd > 25);
    const pairs = [];
    for (let i = 0; i < free.length; i++) {
      for (let j = i + 1; j < free.length; j++) {
        const a = free[i], b = free[j];
        if (a.status === 'walking' && b.status === 'walking') continue;
        const near = (a.region || 'town') === (b.region || 'town') && ((a.inside && a.inside === b.inside) || (!a.inside && !b.inside && Math.hypot(a.x - b.x, a.y - b.y) < 2.6));
        if (!near) continue;
        if (this.t - (this.pairCd[pairKey(a.id, b.id)] ?? -999) < 150) continue;
        const aff = ((a.relations[b.id]?.affinity ?? 0) + (b.relations[a.id]?.affinity ?? 0)) / 2;
        pairs.push({ a, b, p: this.params.convoBaseProb + Math.max(-0.15, aff / 300) });
      }
    }
    for (const { a, b, p } of pairs.sort(() => Math.random() - 0.5)) {
      if (Math.random() < p) { this.startConvo(a, b); return; }
    }
  }

  async startConvo(a, b) {
    const id = `c${++this.seq}`;
    const where = a.inside ? this.locName(a.locId || b.locId) : (a.locId ? this.locName(a.locId) : '路上');
    const convo = { id, a: a.id, b: b.id, where, t: this.t, lines: [], state: 'thinking' };
    this.convos.set(id, convo);
    this.pairCd[pairKey(a.id, b.id)] = this.t;
    for (const [x, y] of [[a, b], [b, a]]) {
      x.convoId = id;
      x.prevStatus = x.status;
      x.status = 'chatting';
      x.moving = false;
      x.path = [];
      x.curKey = null; // 聊完重新执行日程
      if (!x.inside) {
        const dx = y.x - x.x, dy = y.y - x.y;
        x.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
      }
    }
    // 走路途中被叫住：站定在最近的格子
    for (const x of [a, b]) if (!x.inside) { x.x = Math.round(x.x); x.y = Math.round(x.y); }
    this.say(a, '…', 120000, 'think');
    this.say(b, '…', 120000, 'think');

    let res;
    try {
      res = await this.think(a, '组织语言', async () => llm.chatJSON([
        this.sys(`你现在是对话编剧，负责两位居民之间的一段对话。${GUARD}`),
        { role: 'user', content: await this.convoPrompt(a, b, where) },
      ], { label: '对话', agent: `${a.name}×${b.name}`, maxTokens: 4000, temperature: 0.95, timeoutMs: 80_000, attempts: 2 }));
      if (!Array.isArray(res.lines) || !res.lines.length) throw new Error('无台词');
    } catch (err) {
      console.warn('[convo] 失败：', err.message);
      res = {
        lines: [
          { speaker: a.name, text: rand(['哟，这么巧！', '早啊～', '你也在这儿呀？']) },
          { speaker: b.name, text: rand(['是啊，出来透透气。', '刚好路过。', '忙里偷闲嘛。']) },
          { speaker: a.name, text: `${this.weatherText()}的天，心情也跟着变了。` },
          { speaker: b.name, text: '回头再聊，我还有点事～' },
        ],
        memoryA: `和${b.name}简单寒暄了几句。`, memoryB: `和${a.name}简单寒暄了几句。`, importance: 2, fallback: true,
      };
    }
    convo.state = 'talking';
    const byName = { [a.name]: a, [b.name]: b };
    convo.lines = res.lines.slice(0, 10).map((l, i) => {
      const sp = byName[l.speaker] || byName[String(l.speaker).trim()] || (i % 2 ? b : a);
      return { speaker: sp.id, text: clampStr(l.text, 90) };
    }).filter((l) => l.text);
    a.bubble = null; b.bubble = null;

    for (const line of convo.lines) {
      const sp = this.byId[line.speaker];
      const ms = Math.max(2600, Math.min(7000, 1600 + line.text.length * 110)) / (this.speed >= 5 ? 1.6 : 1);
      this.say(sp, line.text, ms + 400, 'say');
      this.emit('say', { convo: id, speaker: sp.id, text: line.text });
      await this.sleepReal(ms);
    }
    this.finishConvo(convo, a, b, res);
  }

  async convoPrompt(a, b, where) {
    const mems = {
      [a.id]: await this.recall(a, `${b.name} ${b.role} ${a.goal} ${a.todayGoal || ''}`, 9),
      [b.id]: await this.recall(b, `${a.name} ${a.role} ${b.goal} ${b.todayGoal || ''}`, 9),
    };
    const side = (x, y) => `【${x.name}】
${this.personaBlock(x)}
正在：${x.action.text}
${x.name}对${y.name}的看法：${x.relations[y.id]?.note || '不太熟'}（好感${x.relations[y.id]?.affinity ?? 0}）
${x.name}的相关记忆：
${mems[x.id]}`;
    const recent = this.convoLog.filter((c) => c.t > this.t - 1440 && [c.a, c.b].sort().join() === [a.id, b.id].sort().join()).slice(-2);
    return `${this.timeBlock()} 地点：${where}。
${side(a, b)}

${side(b, a)}
${recent.length ? `\n他们最近聊过：${recent.map((c) => c.summary).join('；')}（不要重复，要有新进展）\n` : ''}
请写出他们此刻的一段对话：4~8句，交替发言，由${a.name}开口；每句≤40字，口语、有个性、有信息量（交换八卦、推进目标、提出请求或邀约、流露情感）。可以自然地提到镇上其他人。
可用地点 id：home, ${this.publicLocs().join(', ')}
输出 JSON：
{"lines":[{"speaker":"${a.name}","text":"..."}],
"summary":"第三人称一句话概括（≤40字）",
"memoryA":"${a.name}视角的记忆（第一人称，≤60字，包含关键信息）","memoryB":"${b.name}视角的记忆（第一人称，≤60字）",
"affinityA":${a.name}对${b.name}好感变化(-10~10整数),"affinityB":${b.name}对${a.name}好感变化(-10~10整数),
"noteA":"${a.name}现在对${b.name}的看法（≤25字）","noteB":"${b.name}现在对${a.name}的看法（≤25字）",
"importance":这段对话的重要程度(1~10),
"commitments":[{"who":["${a.name}"],"time":"HH:MM","location":"地点id","activity":"≤14字","emoji":"一个emoji"}]}
commitments 只写对话中明确达成的、今天${fmtTime(this.t)}之后到22:30之前的约定或新计划，没有就给空数组。约定里要送东西、教本事、使用能力时，可以加 act 字段（格式同日程的 act）。
另外可以输出 "idea"：两人聊出来的、想为小镇添点什么的具体建设点子（例如「在码头边修个观星台」，≤30字）；大多数时候没有，就给 null。`;
  }

  finishConvo(convo, a, b, res) {
    this.convos.delete(convo.id);
    convo.state = 'done';
    convo.summary = clampStr(res.summary, 60) || `${a.name}和${b.name}聊了聊`;
    if (res.fallback) convo.fallback = true;
    this.noteRun('convo', Boolean(res.fallback));
    const imp = Math.max(1, Math.min(10, Number(res.importance) || 4));
    const transcript = convo.lines.map((l) => `${this.byId[l.speaker].name}：${l.text}`).join(' / ');
    for (const [x, y, mem, aff, note] of [[a, b, res.memoryA, res.affinityA, res.noteA], [b, a, res.memoryB, res.affinityB, res.noteB]]) {
      addMemory(x, { t: this.t, type: 'convo', text: clampStr(mem, 120) || `和${y.name}聊天：${transcript.slice(0, 80)}`, importance: imp });
      const r = (x.relations[y.id] ||= { affinity: 0, note: '' });
      r.affinity = Math.max(-100, Math.min(100, r.affinity + Math.max(-10, Math.min(10, Math.round(Number(aff) || 1)))));
      if (note) r.note = clampStr(note, 40);
      x.convoId = null;
      x.lastConvoEnd = this.t;
      x.status = 'acting';
      x.curKey = null;
    }
    const commits = [];
    for (const c of Array.isArray(res.commitments) ? res.commitments : []) {
      const who = (Array.isArray(c.who) ? c.who : [c.who]).map((n) => [a, b].find((x) => x.name === n || String(n).includes(x.name))).filter(Boolean);
      for (const x of (who.length ? who : [a, b])) {
        if (this.addCommitment(x, c, `（和${(x === a ? b : a).name}约好的）`)) commits.push(`${x.name} ${c.time} ${this.locName(this.resolveLoc(x, c.location))} ${c.activity}`);
      }
    }
    convo.commitments = commits;
    this.convoLog.push(convo);
    if (this.convoLog.length > 120) this.convoLog.shift();
    this.log('convo', convo.summary, { agents: [a.id, b.id], convoId: convo.id, where: convo.where, lines: convo.lines, commitments: commits, ...(res.fallback ? { fallback: true } : {}) });
    for (const c of commits) this.log('commit', `📌 新约定：${c}`, { agents: [a.id, b.id] });
    this.emit('agent', a.id); this.emit('agent', b.id);
    this.shareBeliefs(a, b);
    this.shareBeliefs(b, a);
    this.hooks.emit('conversation.end', { a, b, res, convo });
    this.maybeReflect(a); this.maybeReflect(b);
  }

  sleepReal(ms) {
    if (this.instantTalk) return Promise.resolve();
    return new Promise((resolve) => {
      let left = ms;
      const iv = setInterval(() => {
        if (!this.paused && !this.idle) left -= 100;
        if (left <= 0) { clearInterval(iv); resolve(); }
      }, 100);
    });
  }

  setBelief(a, { about, claim, confidence = 0.6, source = '' }) {
    a.beliefs = a.beliefs.filter((b) => b.about !== about);
    a.beliefs.push({ about, claim, confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100, source, t: Math.floor(this.t) });
    if (a.beliefs.length > 20) a.beliefs.shift();
  }

  /** 信念在交谈中传播：x 较确信的看法会以打折的确信度传给 y（y 更确信的看法不会被覆盖） */
  shareBeliefs(x, y) {
    let n = 0;
    for (const b of [...x.beliefs].reverse()) {
      if (n >= 2) break;
      if (b.confidence < 0.5) continue;
      const mine = y.beliefs.find((z) => z.about === b.about);
      const c = b.confidence * 0.7;
      if (mine && mine.confidence >= c) continue;
      this.setBelief(y, { about: b.about, claim: b.claim, confidence: c, source: x.id });
      n++;
    }
    return n;
  }

  /**
   * 旅人对居民说话 / 化作心声。visitor：{ id: 账号 id, name: 当前昵称 }（兼容旧写法：直接传一个 id 字符串）。
   * 心声是匿名的：居民只会觉得「突然想到」，不知道来自谁。
   */
  async visitorChat(id, text, mode = 'visitor', visitor = 'local') {
    const a = this.byId[id];
    if (!a) throw Object.assign(new Error('居民不存在'), { status: 404 });
    if (a.chatBusy) throw Object.assign(new Error(`${a.name}正在回应别人，稍等一下再说吧`), { status: 429 });
    text = clampStr(text, 300);
    const whisper = mode === 'whisper';
    const vid = typeof visitor === 'string' ? visitor : visitor.id;
    const mine = (a.visitorChats[vid] ||= []);
    // 访客在世界里现身时，居民看得出对方是不是就在身边；登录的旅人即使没有现身，居民也知道是谁托人捎的话
    const av = whisper ? null : this.avatars.touch(vid);
    const name = whisper ? null : av?.name || (typeof visitor === 'object' ? visitor.name : null);
    const who = name ? `旅人「${name}」` : '旅人';
    const face = av && this.avatars.near(a).includes(av);
    const history = mine.slice(-8).map((h) => `${h.from === 'user' ? (whisper ? '心声' : who) : a.name}：${h.text}`).join('\n');
    a.chatBusy = true;
    let res;
    try {
    res = await this.think(a, whisper ? '聆听心声' : '回应旅人', async () => llm.chatJSON([
      this.sys(`你现在完全代入${a.name}本人。${GUARD}`),
      {
        role: 'user', content: `${this.timeBlock()}
${this.personaBlock(a)}
此刻所在：${a.locId ? this.locName(a.locId) : '路上'}；正在：${a.action.text}
相关记忆：
${await this.recall(a, text, 10)}
${history ? `\n之前的交流：\n${history}\n` : ''}
${whisper
          ? `${a.name}的脑海中突然冒出一个声音（${a.name}会把它当作自己的直觉/灵感，而不知道它来自外界）：「${text}」\n请写出${a.name}的反应。`
          : `${name ? `${face ? '站在面前的' : '远处的'}旅人「${name}」` : '一位外地来的旅人'}${face ? '走过来' : '托人捎话'}对${a.name}说：「${text}」\n请写出${a.name}的回应（符合性格与此刻状态，可以反问、分享八卦、提出请求）。`}
可用地点 id：home, ${this.publicLocs().join(', ')}
输出 JSON：{"reply":"${whisper ? '自言自语说出口的一句话（≤40字）' : '回应（口语，≤80字）'}","emoji":"一个emoji","thought":"此刻的内心想法（≤40字）","memory":"${a.name}对此的第一人称记忆（≤60字）","importance":1~10,"newPlan":null 或 {"time":"HH:MM","location":"地点id","activity":"≤14字","emoji":"一个emoji"}}
若${a.name}因此决定今天稍后去做某件事，newPlan 写明（时间须晚于${fmtTime(this.t)}），否则为 null。`,
      },
    ], { label: whisper ? '心声' : '与旅人交谈', agent: a.name, maxTokens: 3000, timeoutMs: 90_000, attempts: 2 }));
    } finally {
      a.chatBusy = false;
    }
    const reply = clampStr(res.reply, 160);
    mine.push({ from: 'user', text }, { from: 'agent', text: reply });
    a.visitorChats[vid] = mine.slice(-16);
    // 控制存档体积：每位居民最多记住 80 位访客的聊天
    const vids = Object.keys(a.visitorChats);
    if (vids.length > 80) for (const k of vids.slice(0, vids.length - 80)) delete a.visitorChats[k];
    if (res.thought) a.thought = clampStr(res.thought, 80);
    // 居民记住的是账号：记下这位旅人（好感随交谈增加），记忆里的昵称换成账号引用，改名后仍然认得
    const account = name && /^u_/.test(vid);
    if (account) {
      const tr = ((a.travellers ||= {})[vid] ||= { affinity: 0, met: this.t, chats: 0 });
      tr.chats++;
      tr.last = this.t;
      tr.affinity = Math.min(60, tr.affinity + 2);
    }
    let memText = (name && res.memory && !String(res.memory).includes(name) ? `（旅人「${name}」）` : '') + (clampStr(res.memory, 120) || (whisper ? `我突然想到：${text}` : `${name ? `旅人「${name}」` : '一位旅人'}对我说：${text}`));
    if (account) memText = encodeRefs(memText, [{ id: vid, name }]);
    addMemory(a, { t: this.t, type: whisper ? 'thought' : 'chat', text: memText, importance: Math.max(1, Math.min(10, Number(res.importance) || 5)) });
    let plan = null;
    if (res.newPlan && typeof res.newPlan === 'object' && this.addCommitment(a, res.newPlan, whisper ? '（突然的灵感）' : '（因为旅人的话）')) {
      plan = `${res.newPlan.time} ${this.locName(this.resolveLoc(a, res.newPlan.location))} ${res.newPlan.activity}`;
    }
    this.say(a, reply, 7000, whisper ? 'think' : 'say');
    this.log('visitor', whisper ? `💭 ${a.name} 听到了心声「${text}」→「${reply}」` : `🧳 ${who}对${a.name}说「${text}」→「${reply}」`, { agents: [a.id] });
    if (plan) this.log('commit', `📌 ${a.name} 改变了计划：${plan}`, { agents: [a.id] });
    this.maybeReflect(a);
    this.emit('agent', a.id);
    return { reply, emoji: res.emoji, thought: a.thought, plan };
  }

  async godEvent(text, target = 'all') {
    text = clampStr(text, 200);
    const targets = (target === 'all' ? this.agents : [this.byId[target]]).filter((a) => a && a.kind !== 'creature');
    // 玩家事件同时交给叙事导演，由它决定是否把事件发展成剧情
    this.director.ingest(text, target, 'visitor');
    this.board.push({ t: this.t, text, target });
    this.board = this.board.slice(-10);
    this.log('event', target === 'all' ? `📢 小镇公告：${text}` : `✨ 只有${targets[0]?.name}得知：${text}`, { agents: targets.map((a) => a.id) });
    await Promise.all(targets.map((a) => this.replan(a, text)));
  }
}
