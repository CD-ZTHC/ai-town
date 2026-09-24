// 记忆流：写入、按「时近性 + 重要性 + 相关性」检索（中文双字组相似度，无需向量模型）
const PUNCT = /[\s，。！？、；：“”‘’（）《》…—\-,.!?;:'"()[\]{}~·]/g;

function bigrams(text) {
  const s = String(text).replace(PUNCT, '');
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

let memSeq = 0;
export function addMemory(agent, { t, type = 'obs', text, importance = 3 }) {
  const m = { id: `${agent.id}-${Date.now().toString(36)}-${(memSeq++).toString(36)}`, t, type, text, importance };
  agent.memories.push(m);
  agent.importanceAcc = (agent.importanceAcc || 0) + importance;
  // 控制容量：保留反思与高重要性记忆，淘汰旧的琐碎记忆
  if (agent.memories.length > 400) {
    const drop = agent.memories.findIndex((x) => x.type !== 'reflect' && x.importance < 6);
    agent.memories.splice(drop >= 0 ? drop : 0, 1);
  }
  return m;
}

export function retrieve(agent, query, now, k = 10) {
  const q = bigrams(query);
  const scored = agent.memories.map((m) => {
    const hours = Math.max(0, (now - m.t) / 60);
    const recency = Math.pow(0.97, hours);
    const importance = m.importance / 10;
    let relevance = 0;
    if (q.size) {
      const b = bigrams(m.text);
      let hit = 0;
      for (const g of q) if (b.has(g)) hit++;
      relevance = Math.min(1, (hit / Math.sqrt(q.size * Math.max(1, b.size))) * 3);
    }
    return { m, score: recency + importance + relevance * 1.5 + (m.type === 'reflect' ? 0.2 : 0) };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.m)
    .sort((a, b) => a.t - b.t);
}

export function fmtTime(t) {
  const m = Math.floor(t % 1440);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
export function fmtStamp(t) {
  return `第${Math.floor(t / 1440) + 1}天 ${fmtTime(t)}`;
}
export function parseHM(s) {
  const m = /(\d{1,2})[:：](\d{2})/.exec(String(s));
  if (!m) return null;
  return Math.min(24 * 60, Number(m[1]) * 60 + Number(m[2]));
}
