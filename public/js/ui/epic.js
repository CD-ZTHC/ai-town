// 故事面板的「史诗」与「大纲」两页（docs/design/epic-outline.md §8）。
// 史诗：目录（部 → 卷 → 章）与阅读；大纲：其他人看到已经发生的部分，管理者看到完整的大纲，可以 AI 生成 / 修改、手动编辑，
// 提交评审后保存，也可以修改分级、在故事完结后开启下一部。
// 要调用模型的操作都是后台任务：任务记在 ui.jobs 里（也存进 sessionStorage），面板被 SSE 刷新、切换标签、甚至刷新页面之后
// 进度都还在，完成后按任务类型处理结果。AI 生成 / 修改的大纲存在服务端的草稿里，评审通过后才保存成正式大纲。
import { $, $$, app, esc, toast, ui } from './core.js';

const KIND = { good: '好结局', bad: '坏结局', neutral: '结局' };
const RT = { cozy: '温馨', adventure: '冒险', epic: '史诗', dark: '黑暗', tragic: '悲剧' };
const ST = { done: '已完成', active: '进行中', planned: '计划中', dropped: '已放弃' };
const BST = { planned: '未发生', done: '已发生', transformed: '变形发生', skipped: '不会发生' };
const SEV = { major: '必须修改', minor: '建议' };
const SRC = { generate: 'AI 生成', assist: 'AI 修改', manual: '手动编辑', revision: '修订记录' };
const JOBS_KEY = 'town-ai-jobs';

// ---------- 后台 AI 任务 ----------
ui.jobs ||= {};
const saveJobs = () => { try { sessionStorage.setItem(JOBS_KEY, JSON.stringify({ path: location.pathname, jobs: ui.jobs })); } catch { /* 无痕模式等 */ } };
const sec = (t0) => Math.max(0, Math.round((Date.now() - t0) / 1000));
/** 当前打开着的故事面板主体（任务完成时面板可能已经换了标签或关掉了） */
const storyBody = () => (ui.storyOpen ? $('#story-body') : null);
/** 任务完成后刷新对应的标签页（不在这个标签页时只提示） */
function refresh(tab, hint) {
  const body = storyBody();
  if (body && ui.storyTab === tab) (tab === 'epic' ? renderEpic : renderOutline)(body);
  else if (hint) toast(hint, 7000);
}

/** 任务完成之后做什么：只依赖任务结果与任务的 meta（页面刷新后恢复的任务也能处理） */
const DONE = {
  // 评审：结果放回编辑器；AI 生成 / 修改：结果（已存为草稿并评审过）放进编辑器
  outline: (r, m) => {
    if (m.review) {
      if (ui.outlineEdit) Object.assign(ui.outlineEdit, { draft: r.draft, reviewId: r.reviewId, review: r.result, errors: [] });
      else openFromDraft({ draft: r.draft, base: m.base, reviewId: r.reviewId, review: r.result });
      refresh('outline', '🧪 大纲评审完成：打开 🎭 故事 → 🗺️ 大纲 查看');
      return;
    }
    openFromDraft({ ...r, source: m.source });
    refresh('outline', '📝 大纲草稿已经好了（已自动评审）：打开 🎭 故事 → 🗺️ 大纲 查看并保存');
  },
  rating: (r, m) => { ui.ratingPlan = { to: m.to, direction: m.direction, plan: r }; ui.outlinePanel = 'rating'; refresh('outline', '⚖️ 分级适配计划已经好了：打开 🎭 故事 → 🗺️ 大纲 查看'); },
  sequel: (r, m) => { ui.sequelPlan = { direction: m.direction, threats: m.threats, plan: r }; ui.outlinePanel = 'sequel'; refresh('outline', '📖 下一部的计划已经好了：打开 🎭 故事 → 🗺️ 大纲 查看'); },
  epic: () => { toast('📜 新的一章写好了'); refresh('epic'); },
};

async function poll(key) {
  const j0 = ui.jobs[key];
  if (!j0) return;
  try {
    for (;;) {
      await new Promise((res) => setTimeout(res, 1500));
      if (ui.jobs[key] !== j0) return;
      const j = await app.api(`/api/ai-jobs/${j0.jobId}`);
      if (j.status === 'running') {
        if (sec(j0.t0) > 10 * 60) throw new Error('等待超时，请稍后刷新再看');
        continue;
      }
      delete ui.jobs[key];
      saveJobs();
      if (j.status === 'failed') throw new Error(j.error || 'AI 任务失败');
      DONE[key]?.(j.result, j0.meta || {});
      return;
    }
  } catch (e) {
    delete ui.jobs[key];
    saveJobs();
    toast(`⚠️ ${esc(e.message)}`, 7000);
    refresh(ui.storyTab);
  }
}

/** 发起一个后台任务（同一类同时只有一个）；返回 false 表示没有发起 */
async function startJob(key, label, path, body, meta = {}) {
  if (ui.jobs[key]) { toast('上一个任务还在进行中'); return false; }
  let r;
  try { r = await app.api(path, body); } catch (e) { toast(`⚠️ ${esc(e.message)}`); return false; }
  ui.jobs[key] = { jobId: r.jobId, label, t0: Date.now(), meta };
  saveJobs();
  poll(key);
  return true;
}

/** 正在进行的任务的进度条（每秒更新秒数） */
const jobBar = (key) => (ui.jobs[key] ? `<div class="ol-job"><span class="spin">⏳</span> ${esc(ui.jobs[key].label)}…… <span data-job-sec="${key}">${sec(ui.jobs[key].t0)}</span> 秒<small>可以关掉面板做别的事，好了会提示你</small></div>` : '');
// 只在浏览器里：每秒更新进度条的秒数；页面刷新前还在进行的任务，在同一个世界里接着等结果（Node 里导入这个模块做测试时不启动）
if (typeof document !== 'undefined') {
  setInterval(() => { for (const el of $$('[data-job-sec]')) { const j = ui.jobs[el.dataset.jobSec]; if (j) el.textContent = sec(j.t0); } }, 1000);
  try {
    const saved = JSON.parse(sessionStorage.getItem(JOBS_KEY) || 'null');
    if (saved?.path === location.pathname) for (const [k, j] of Object.entries(saved.jobs || {})) { ui.jobs[k] = j; poll(k); }
  } catch { /* 无痕模式等 */ }
}

// ---------- 史诗 ----------
export async function renderEpic(body) {
  if (ui.epicView) return renderChapter(body, ui.epicView);
  let d;
  try { d = await app.api('/api/epic'); } catch (e) { body.innerHTML = `<div class="empty">⚠️ ${esc(e.message)}</div>`; return; }
  if (!body.isConnected) return;
  const groups = [];
  for (const c of d.chapters) {
    let p = groups.find((g) => g.part === c.part);
    if (!p) groups.push(p = { part: c.part, title: c.partTitle, vols: [] });
    let v = p.vols.find((x) => x.id === c.volume);
    if (!v) p.vols.push(v = { id: c.volume, title: c.volumeTitle, list: [] });
    v.list.push(c);
  }
  const multi = groups.length > 1 || d.part > 1;
  body.innerHTML = `<div class="srow"><span>📜 <b>《${esc(d.title)}》</b></span><span>已写 <b>${d.chapters.length}</b> 章</span>
      ${d.pending ? `<span>待写素材 <b>${d.pending}</b> 条</span>` : ''}${d.writing ? '<span>✍️ 正在写下一章……</span>' : ''}
      ${d.chapters.length ? '<a class="mini-link" href="api/epic.md" download>⬇️ 导出全书</a>' : ''}
      ${d.manager && d.pending && !ui.jobs.epic ? '<button class="mini adm" id="ep-write">现在写一章</button>' : ''}</div>
    ${jobBar('epic')}
    ${d.enabled ? '' : '<div class="sub">这个世界关闭了史诗。</div>'}
    ${d.synopsis ? `<details class="ep-syn"><summary>全书梗概</summary><p>${esc(d.synopsis)}</p></details>` : ''}
    ${groups.map((g) => `${multi ? `<h3>第${g.part}部${g.title ? ` · ${esc(g.title)}` : ''}</h3>` : ''}${g.vols.map((v) => `<div class="ep-vol"><div class="ep-vt">${esc(v.title)}</div>
      ${v.list.map((c) => `<button class="ep-ch ${c.ending ? 'end' : ''}" data-ch="${c.part}:${c.n}"><b>第${c.n}章 ${esc(c.title)}${c.ending ? ` · ${c.ending.kind === 'bad' ? '🌑' : '🌅'}大结局` : ''}</b><small>${esc(c.summary)}</small></button>`).join('')}</div>`).join('')}`).join('')
    || '<div class="empty">史诗还没有开篇。世界里发生了足够多的事之后，作者会写下第一章（每隔几天，或者发生重大事件时）。</div>'}`;
  $$('[data-ch]', body).forEach((b) => b.addEventListener('click', () => { const [part, n] = b.dataset.ch.split(':').map(Number); ui.epicView = { part, n }; renderEpic(body); }));
  const w = $('#ep-write', body);
  if (w) w.onclick = async () => { w.disabled = true; if (await startJob('epic', '作者正在写下一章', '/api/epic/write', {})) renderEpic(body); else w.disabled = false; };
}

async function renderChapter(body, { part, n }) {
  let c;
  try { c = await app.api(`/api/epic/${part}/${n}`); } catch (e) { ui.epicView = null; body.innerHTML = `<div class="empty">⚠️ ${esc(e.message)}</div>`; return; }
  if (!body.isConnected) return;
  body.innerHTML = `<div class="ep-nav"><button class="mini" id="ep-back">← 目录</button>
      ${c.prev ? `<button class="mini" data-go="${c.prev.part}:${c.prev.n}">‹ 上一章</button>` : ''}${c.next ? `<button class="mini" data-go="${c.next.part}:${c.next.n}">下一章 ›</button>` : ''}</div>
    <article class="ep-read"><div class="ep-vt">${c.part > 1 ? `第${c.part}部 · ` : ''}${esc(c.volumeTitle)}</div>
      <h2>第${c.n}章 ${esc(c.title)}${c.ending ? `<small>（大结局 · ${esc(c.ending.title)}）</small>` : ''}</h2>
      ${String(c.body).split(/\n+/).filter((x) => x.trim()).map((p) => `<p>${esc(p)}</p>`).join('')}
      ${c.beats?.length ? `<div class="ep-beats">🗺️ 对应大纲：${c.beats.map((b) => `<span>${esc(b.act)} · ${esc(b.text)}</span>`).join('')}</div>` : ''}</article>`;
  body.scrollTop = 0;
  $('#ep-back', body).onclick = () => { ui.epicView = null; renderEpic(body); };
  $$('[data-go]', body).forEach((b) => b.addEventListener('click', () => { const [p, k] = b.dataset.go.split(':').map(Number); ui.epicView = { part: p, n: k }; renderEpic(body); }));
}

// ---------- 大纲 ----------
/** 把服务端的草稿（或任务结果）放进编辑器 */
function openFromDraft(d) {
  if (!d?.draft) return;
  ui.outlineEdit = { draft: structuredClone(d.draft), base: d.base ?? 0, reviewId: d.reviewId || null, review: d.review || null, summary: d.summary || '', errors: d.errors || [], source: d.source || 'manual', json: false };
  ui.outlinePanel = null;
}

/** 正在 SSE 刷新时不能打断的状态（编辑器、计划面板、AI 修改的输入框） */
export const outlineBusy = () => Boolean(ui.outlineEdit || ui.outlinePanel || ui.outlineAsk);

export async function renderOutline(body) {
  let d;
  try { d = await app.api('/api/outline'); } catch (e) { body.innerHTML = `<div class="empty">⚠️ ${esc(e.message)}</div>`; return; }
  if (!body.isConnected) return;
  if (ui.outlineEdit && d.full) return renderEditor(body, d);
  if (ui.outlinePanel && d.full) return ui.outlinePanel === 'rating' ? renderRating(body) : renderSequel(body, d);
  const end = d.ending || {};
  const banner = end.ended ? `<div class="ol-end ${end.ended.kind}">📕 故事完结：「${esc(end.ended.title)}」${end.part > 1 ? `（第${end.part}部）` : ''}<small>世界已经停止演进，可以在「📜 史诗」里读到大结局。</small></div>`
    : end.triggered ? `<div class="ol-end ${end.triggered.kind}">🎬 终幕：「${esc(end.triggered.title)}」<small>故事正在走向结局。</small></div>` : '';
  const chLinks = (b) => (b.chapters || []).map((k) => `<button class="mini" data-ch="${k}">第${k.split(':')[1]}章</button>`).join('');
  if (!d.full) {
    body.innerHTML = `${banner}${d.exists ? `${d.premise ? `<div class="sub">${esc(d.premise)}</div>` : ''}
      ${d.parts.map((p) => `<h3>${esc(p.title)}</h3>${p.acts.map((a) => (a.status === 'done'
        ? `<div class="ol-act done"><b>${esc(a.title)}</b><p>${esc(a.recap)}</p>${a.beats.map((b) => `<div class="ol-beat ${b.status}">· ${esc(b.text)} ${chLinks(b)}</div>`).join('')}</div>`
        : `<div class="ol-act active"><b>${esc(a.title)}</b> <span class="badge">进行中</span></div>`)).join('')}`).join('')}
      <div class="sub">接下来会发生什么？只有世界的创建者知道。</div>` : '<div class="empty">这个世界还没有故事大纲。</div>'}`;
    bindChapterLinks(body);
    return;
  }
  // ---------- 管理者 ----------
  const o = d.outline;
  const dr = d.draft;
  const running = Boolean(ui.jobs.outline);
  const ends = (end.endings || []).map((e) => `<div class="dec">${e.kind === 'bad' ? '🌑' : e.kind === 'good' ? '🌅' : '🔚'} <b>${esc(e.title)}</b>（${KIND[e.kind]}）
      <code>${esc(e.when)}</code>${e.for ? ` · 连续 ${e.for} 天` : ''} · ${e.now ? `<b class="good">现在满足${e.heldDays != null ? `（已 ${e.heldDays} 天）` : ''}</b>` : '<span class="muted">未满足</span>'}
      ${e.hint ? `<div class="sub">${esc(e.hint)}</div>` : ''}</div>`).join('');
  const draftBanner = dr ? `<div class="ol-draft">📝 <b>有一份未保存的大纲草稿</b>（${SRC[dr.source] || '编辑'} · ${new Date(dr.t).toLocaleString()}${dr.review ? ` · ${dr.review.issues.some((i) => i.severity === 'major') ? '评审：需要修改' : '评审已通过'}` : ''}${dr.stale ? ' · 大纲在这之后更新过' : ''}）
      ${dr.summary ? `<small>${esc(dr.summary)}</small>` : ''}<div class="ol-bar"><button class="mini adm" id="ol-resume">继续编辑并保存</button><button class="mini" id="ol-discard">丢弃草稿</button></div></div>` : '';
  body.innerHTML = `${banner}${jobBar('outline')}${draftBanner}
    ${ui.outlineAsk ? `<div class="ol-ask"><textarea id="ol-ask-text" rows="3" maxlength="600" placeholder="描述想怎么改，例如：让萧九在第三幕叛出之后回来帮忙；把坏结局的门槛提高一些"></textarea>
      <div class="ol-bar"><button class="mini adm" id="ol-ask-go">让 AI 修改</button><button class="mini" id="ol-ask-x">取消</button></div></div>` : ''}
    <div class="ol-bar">
      ${d.exists ? `<button class="mini adm" id="ol-ai" ${running ? 'disabled' : ''}>🤖 AI 修改</button><button class="mini adm" id="ol-edit">✏️ 手动编辑</button>` : `<button class="mini adm" id="ol-gen" ${running ? 'disabled' : ''}>🤖 生成大纲</button>`}
      ${end.ended ? '<button class="mini adm" id="ol-seq">📖 开启下一部</button>' : '<button class="mini adm" id="ol-rate">⚖️ 修改分级</button>'}
      ${d.exists ? `<label class="mini-check"><input type="checkbox" id="ol-auto" ${o.autoAdjust ? 'checked' : ''}> 让 AI 按世界的走向调整未来</label>` : ''}</div>
    <div class="sub">🔒 完整的大纲只有你能看到；其他人只能看到已经发生的部分。大纲是故事的方向：导演会往这里安排局面，结果仍由世界自己决定。AI 生成或修改的内容先成为草稿，评审通过后保存才会生效。</div>
    ${d.exists ? `${o.premise ? `<div class="ol-premise">${esc(o.premise)}${o.theme ? `<small>主题：${esc(o.theme)}</small>` : ''}</div>` : ''}
      <h3>结局</h3>${ends || '<div class="sub">没有设定结局：这个故事会一直写下去。</div>'}
      ${o.parts.map((p) => `<h3>${esc(p.title)} <span class="badge">${ST[p.status]}</span></h3>${p.acts.map((a) => `<div class="ol-act ${a.status}">
        <b>${esc(a.title)}</b> <span class="badge">${ST[a.status]}</span>${a.locked ? ' 🔒' : ''}${a.endingRef ? ` <span class="badge">→ ${esc(o.endings.find((e) => e.id === a.endingRef)?.title || a.endingRef)}</span>` : ''}
        <p>${esc(a.status === 'done' ? a.recap || a.plan : a.plan)}</p>
        ${a.beats.map((b) => `<div class="ol-beat ${b.status}">${{ planned: '○', done: '●', transformed: '◐', skipped: '×' }[b.status]} ${esc(b.text)}${b.locked ? ' 🔒' : ''}${b.done ? ` <code>${esc(b.done)}</code>` : ''}${b.note ? ` <small>（${esc(b.note)}）</small>` : ''} ${chLinks(b)}</div>`).join('')}</div>`).join('')}`).join('')}
      <details class="ol-revs"><summary>修订记录（${d.revisions.length}）</summary>${d.revisions.map((r) => `<div class="dec">v${r.v} · 第${r.day}天 · ${esc({ seed: '世界包', genesis: '创世', keeper: 'AI 维护', 'owner-ai': 'AI 修改', 'owner-manual': '手动编辑', part: '新的一部', rerate: '分级修改' }[r.kind] || r.kind)}
        ${r.note ? `· ${esc(r.note)}` : ''}${r.review?.forced ? ' · ⚠️ 强制保存' : ''} <button class="mini" data-rev="${r.v}">载入编辑</button></div>`).join('')}</details>`
    : `<div class="empty">这个世界还没有大纲。${running ? '' : '可以让 AI 根据世界现在的样子生成一份（会自动评审），确认后保存。'}</div>`}`;
  bindChapterLinks(body);
  const base = d.version || 0;
  const gen = $('#ol-gen', body);
  if (gen) gen.onclick = async () => { gen.disabled = true; if (await startJob('outline', 'AI 正在写大纲并评审', '/api/outline/generate', { baseVersion: base }, { source: 'generate' })) renderOutline(body); else gen.disabled = false; };
  const ai = $('#ol-ai', body);
  if (ai) ai.onclick = () => { ui.outlineAsk = true; renderOutline(body); };
  const ask = $('#ol-ask-go', body);
  if (ask) {
    $('#ol-ask-text', body).focus();
    $('#ol-ask-x', body).onclick = () => { ui.outlineAsk = false; renderOutline(body); };
    ask.onclick = async () => {
      const instruction = $('#ol-ask-text', body).value.trim();
      if (!instruction) return;
      ask.disabled = true;
      if (await startJob('outline', 'AI 正在修改大纲并评审', '/api/outline/assist', { instruction, baseVersion: base }, { source: 'assist' })) { ui.outlineAsk = false; renderOutline(body); } else ask.disabled = false;
    };
  }
  const resume = $('#ol-resume', body);
  if (resume) resume.onclick = () => { openFromDraft(dr); renderOutline(body); };
  const discard = $('#ol-discard', body);
  if (discard) discard.onclick = async () => { if (!confirm('丢弃这份草稿吗？')) return; try { await app.api('/api/outline/draft/discard', {}); } catch (e) { toast(`⚠️ ${esc(e.message)}`); } renderOutline(body); };
  const ed = $('#ol-edit', body);
  if (ed) ed.onclick = () => { if (dr && !confirm('已经有一份未保存的草稿，开始新的编辑会替换它。继续吗？')) return; openFromDraft({ draft: o, base, source: 'manual' }); renderOutline(body); };
  const auto = $('#ol-auto', body);
  if (auto) auto.onchange = async () => { try { await app.api('/api/outline/auto', { on: auto.checked }); toast(auto.checked ? '已开启自动调整' : '已关闭自动调整'); } catch (e) { toast(`⚠️ ${esc(e.message)}`); auto.checked = !auto.checked; } };
  const rate = $('#ol-rate', body);
  if (rate) rate.onclick = () => { ui.outlinePanel = 'rating'; renderOutline(body); };
  const seq = $('#ol-seq', body);
  if (seq) seq.onclick = () => { ui.outlinePanel = 'sequel'; renderOutline(body); };
  $$('[data-rev]', body).forEach((b) => b.addEventListener('click', async () => {
    try { const r = await app.api(`/api/outline/revisions/${b.dataset.rev}`); openFromDraft({ draft: r.snapshot, base, source: 'revision', summary: `从 v${r.v} 载入（已经发生的部分会按现在的大纲校验）` }); renderOutline(body); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
  }));
}

function bindChapterLinks(body) {
  $$('[data-ch]', body).forEach((b) => b.addEventListener('click', () => {
    const [part, n] = b.dataset.ch.split(':').map(Number);
    ui.epicView = { part, n };
    $('.stabs button[data-t="epic"]')?.click();
  }));
}

// ---------- 编辑器 ----------
const newId = (p) => `${p}${Math.random().toString(36).slice(2, 7)}`;
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, path, v) {
  const ks = path.split('.');
  const last = ks.pop();
  const o = ks.reduce((x, k) => x[k], obj);
  if (v === '' || v == null) delete o[last]; else o[last] = v;
}

/** 编辑中的草稿暂存到服务端（停手 1.2 秒后） */
let autosaveTimer = null;
function autosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    const ed = ui.outlineEdit;
    if (!ed) return;
    app.api('/api/outline/draft', { draft: ed.draft, baseVersion: ed.base, source: ed.source, summary: ed.summary }).catch(() => {});
  }, 1200);
}

function reviewHTML(r, { fix = false } = {}) {
  if (!r) return '';
  const major = r.issues.some((i) => i.severity === 'major');
  return `<div class="ol-review ${major ? 'bad' : 'ok'}"><b>${major ? '⚠️ 评审：需要修改' : r.issues.length ? '✅ 评审通过（有建议）' : '✅ 评审通过'}</b> <small>${esc(r.summary)}${r.by === 'none' ? '（没有配置模型，只做了规则校验）' : ''}</small>
    ${r.issues.map((i) => `<div class="ol-issue ${i.severity}"><span class="badge">${SEV[i.severity]}</span> ${i.where ? `<b>${esc(i.where)}</b>：` : ''}${esc(i.text)}${i.suggestion ? `<div class="sub">建议：${esc(i.suggestion)}</div>` : ''}</div>`).join('')}
    ${fix && r.issues.length ? '<button class="mini adm" id="ol-fix">🤖 让 AI 按评审意见修改</button>' : ''}</div>`;
}

function renderEditor(body, d) {
  const ed = ui.outlineEdit;
  const o = ed.draft;
  o.parts ||= []; o.endings ||= [];
  const stale = ed.base !== (d.version || 0);
  const canSave = Boolean(ed.reviewId) && !stale && !ed.review?.issues.some((i) => i.severity === 'major');
  const settledAct = (a) => a.status === 'done' || (a.status === 'dropped' && d.outline?.parts.some((p) => p.acts.some((x) => x.id === a.id && x.status === 'dropped')));
  const opt = (map, v, keys = Object.keys(map)) => keys.map((k) => `<option value="${k}" ${v === k ? 'selected' : ''}>${map[k]}</option>`).join('');
  const inp = (path, v, attrs = '') => `<input data-k="${path}" value="${esc(v ?? '')}" ${attrs}>`;
  const parts = o.parts.map((p, pi) => `<div class="ol-ed-part"><div class="ol-row">部名 ${inp(`parts.${pi}.title`, p.title, `maxlength="20" ${p.status === 'done' ? 'disabled' : ''}`)} <span class="badge">${ST[p.status]}</span></div>
    ${p.acts.map((a, ai) => {
      const k = `parts.${pi}.acts.${ai}`;
      if (settledAct(a)) return `<div class="ol-act done"><b>${esc(a.title)}</b> <span class="badge">${ST[a.status]}</span><p>${esc(a.recap || a.plan)}</p><div class="sub">已经过去的幕不能修改</div></div>`;
      return `<div class="ol-ed-act"><div class="ol-row">幕 ${inp(`${k}.title`, a.title, 'maxlength="20"')}
          <select data-k="${k}.status">${opt(ST, a.status, ['active', 'planned', 'dropped'])}</select>
          <label class="mini-check"><input type="checkbox" data-k="${k}.locked" data-bool ${a.locked ? 'checked' : ''}>🔒 锁定</label>
          <select data-k="${k}.endingRef"><option value="">（不指向结局）</option>${o.endings.map((e) => `<option value="${esc(e.id)}" ${a.endingRef === e.id ? 'selected' : ''}>→ ${esc(e.title || e.id)}</option>`).join('')}</select>
          <button class="mini" data-del="${k}">删除这一幕</button></div>
        <textarea data-k="${k}.plan" rows="2" maxlength="300" placeholder="这一幕要讲什么">${esc(a.plan)}</textarea>
        ${a.beats.map((b, bi) => {
          const bk = `${k}.beats.${bi}`;
          const old = d.outline && [...d.outline.parts.flatMap((x) => x.acts.flatMap((y) => y.beats))].find((x) => x.id === b.id);
          if (old && old.status !== 'planned') return `<div class="ol-beat ${b.status}">● ${esc(b.text)} <small>（${BST[b.status]}，不能修改）</small></div>`;
          return `<div class="ol-row ol-ed-beat">${inp(`${bk}.text`, b.text, 'maxlength="80" placeholder="要发生的事"')}
            <select data-k="${bk}.status">${opt(BST, b.status)}</select>
            ${inp(`${bk}.done`, b.done, 'class="code" placeholder="完成条件（可选），如 flag(\'x\')"')}
            <label class="mini-check"><input type="checkbox" data-k="${bk}.locked" data-bool ${b.locked ? 'checked' : ''}>🔒</label>
            <button class="mini" data-del="${bk}">×</button></div>`;
        }).join('')}
        <button class="mini" data-add-beat="${k}">＋ 节点</button></div>`;
    }).join('')}
    ${p.status !== 'done' ? `<button class="mini" data-add-act="parts.${pi}">＋ 幕</button>` : ''}</div>`).join('');
  const ends = o.endings.map((e, i) => {
    const k = `endings.${i}`;
    return `<div class="ol-ed-act"><div class="ol-row">${inp(`${k}.title`, e.title, 'maxlength="16" placeholder="结局名"')}
        <select data-k="${k}.kind">${opt(KIND, e.kind)}</select>
        连续 ${inp(`${k}.for`, e.for, 'type="number" min="0" max="14" class="num" data-num')} 天
        <button class="mini" data-del="${k}">删除</button></div>
      <div class="ol-row">条件 ${inp(`${k}.when`, e.when, 'class="code" placeholder="例如 unresolvedThreats() == 0"')}</div>
      <div class="ol-row">${inp(`${k}.hint`, e.hint, 'maxlength="80" placeholder="写给导演看的说明"')}
        终幕 ${inp(`${k}.finale.hours`, e.finale?.hours, 'type="number" min="0" max="48" class="num" data-num')} 小时</div>
      <div class="ol-row">${inp(`${k}.finale.text`, e.finale?.text, 'maxlength="80" placeholder="终幕的一句话"')}</div></div>`;
  }).join('');
  const running = Boolean(ui.jobs.outline);
  body.innerHTML = `<div class="ol-bar"><b>📝 大纲草稿 · 未保存</b><span class="badge">${SRC[ed.source] || '编辑'}</span>
      <button class="mini" id="ol-json">${ed.json ? '表单' : 'JSON'}</button>
      <button class="mini adm" id="ol-review" ${running ? 'disabled' : ''}>🧪 ${ed.review ? '重新评审' : '提交评审'}</button>
      <button class="mini adm" id="ol-save" ${canSave ? '' : 'disabled'}>💾 保存为正式大纲</button>
      ${app.perms.admin ? '<button class="mini" id="ol-force" title="跳过评审（记入审计）">强制保存</button>' : ''}
      <button class="mini" id="ol-close" title="草稿会保留，之后可以继续">关闭</button>
      <button class="mini" id="ol-discard">丢弃草稿</button></div>
    ${jobBar('outline')}
    ${stale ? `<div class="ol-review bad">⚠️ 正式大纲在这份草稿之后又更新过（v${ed.base} → v${d.version || 0}，可能是 AI 维护推进了进度）。<button class="mini adm" id="ol-rebase">基于最新版本继续</button><div class="sub">已经发生的部分会按最新的大纲校验，之后需要重新评审。</div></div>` : ''}
    ${ed.summary ? `<div class="sub">🤖 ${esc(ed.summary)}</div>` : ''}
    ${ed.errors?.length ? `<div class="ol-review bad"><b>AI 写的草稿还有这些问题：</b>${ed.errors.slice(0, 6).map((x) => `<div>· ${esc(x)}</div>`).join('')}</div>` : ''}
    ${reviewHTML(ed.review, { fix: !running })}
    <div class="sub">${canSave ? '评审已通过：点「保存为正式大纲」后生效。' : '这是草稿：提交评审（先过规则校验，再由 AI 评审），评审通过（或只有建议）后才能保存。草稿会自动暂存，刷新页面也不会丢。已经发生的部分不能改。'}</div>
    ${ed.json ? `<textarea id="ol-json-text" rows="22" class="code">${esc(JSON.stringify(o, null, 1))}</textarea>`
    : `<div class="ol-row">故事前提 ${inp('premise', o.premise, 'maxlength="120"')}</div><div class="ol-row">主题 ${inp('theme', o.theme, 'maxlength="40"')}</div>
      <h3>结局 <button class="mini" id="ol-add-end">＋ 结局</button></h3>${ends || '<div class="sub">没有结局：这个故事会一直写下去。</div>'}
      <div class="sub">条件可以用：unresolvedThreats()、liveThreats()、containedThreats()、crowdDead()、namedDeaths()、aliveIn('阵营id')、flag('标记')、day。</div>
      ${parts}`}`;
  const dirty = () => { ed.reviewId = null; ed.review = null; const s = $('#ol-save', body); if (s) s.disabled = true; autosave(); };
  $$('[data-k]', body).forEach((el) => el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => {
    const path = el.dataset.k;
    if (path.endsWith('.finale.hours') || path.endsWith('.finale.text')) { const e = getPath(o, path.split('.').slice(0, 2).join('.')); e.finale ||= {}; }
    const v = el.dataset.bool != null ? (el.checked || '') : el.dataset.num != null ? (el.value === '' ? '' : Number(el.value)) : el.value;
    setPath(o, path, v);
    dirty();
  }));
  const rerender = () => { dirty(); renderEditor(body, d); };
  $$('[data-del]', body).forEach((b) => b.addEventListener('click', () => {
    const ks = b.dataset.del.split('.');
    const i = Number(ks.pop());
    getPath(o, ks.join('.')).splice(i, 1);
    rerender();
  }));
  $$('[data-add-beat]', body).forEach((b) => b.addEventListener('click', () => { getPath(o, b.dataset.addBeat).beats.push({ id: newId('b_'), text: '', status: 'planned', chapters: [] }); rerender(); }));
  $$('[data-add-act]', body).forEach((b) => b.addEventListener('click', () => { getPath(o, b.dataset.addAct).acts.push({ id: newId('act_'), title: '', plan: '', status: 'planned', beats: [] }); rerender(); }));
  const addEnd = $('#ol-add-end', body);
  if (addEnd) addEnd.onclick = () => { o.endings.push({ id: newId('end_'), title: '', kind: 'bad', when: '' }); rerender(); };
  const syncJson = () => { if (!ed.json) return true; try { ed.draft = JSON.parse($('#ol-json-text', body).value); return true; } catch { toast('⚠️ JSON 写得不对'); return false; } };
  $('#ol-json', body).onclick = () => { if (!syncJson()) return; ed.json = !ed.json; renderEditor(body, d); };
  const jt = $('#ol-json-text', body);
  if (jt) jt.oninput = () => { try { ed.draft = JSON.parse(jt.value); dirty(); } catch { /* 写到一半 */ } };
  $('#ol-close', body).onclick = () => { if (!syncJson()) return; clearTimeout(autosaveTimer); app.api('/api/outline/draft', { draft: ed.draft, baseVersion: ed.base, source: ed.source, summary: ed.summary }).catch(() => {}).finally(() => { ui.outlineEdit = null; renderOutline(body); }); };
  $('#ol-discard', body).onclick = async () => {
    if (!confirm('丢弃这份草稿吗？')) return;
    clearTimeout(autosaveTimer);
    try { await app.api('/api/outline/draft/discard', {}); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
    ui.outlineEdit = null; renderOutline(body);
  };
  const rb = $('#ol-rebase', body);
  if (rb) rb.onclick = () => { ed.base = d.version || 0; rerender(); };
  $('#ol-review', body).onclick = async () => {
    if (!syncJson()) return;
    clearTimeout(autosaveTimer);
    if (await startJob('outline', '评审中', '/api/outline/review', { draft: ed.draft, baseVersion: ed.base }, { review: true, base: ed.base })) renderEditor(body, d);
  };
  const save = async (force) => {
    if (!syncJson()) return;
    try {
      await app.api('/api/outline/save', { draft: ed.draft, baseVersion: ed.base, reviewId: ed.reviewId, force, kind: ['generate', 'assist'].includes(ed.source) ? 'owner-ai' : 'owner-manual', note: ed.summary || '' });
      toast('💾 大纲已保存，导演和史诗作者会按新的大纲推进'); ui.outlineEdit = null; renderOutline(body);
    } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
  };
  $('#ol-save', body).onclick = () => save(false);
  const force = $('#ol-force', body);
  if (force) force.onclick = () => confirm('跳过评审强制保存吗？这会记入审计日志。') && save(true);
  const fix = $('#ol-fix', body);
  if (fix) fix.onclick = async () => {
    const instruction = `按评审意见修改：${ed.review.issues.map((i) => `${i.where ? `${i.where}：` : ''}${i.text}${i.suggestion ? `（建议：${i.suggestion}）` : ''}`).join('；')}`.slice(0, 600);
    if (await startJob('outline', 'AI 正在按评审意见修改并重新评审', '/api/outline/assist', { instruction, baseVersion: ed.base, draft: ed.draft }, { source: 'assist' })) renderEditor(body, d);
  };
}

// ---------- 修改分级 ----------
async function renderRating(body) {
  let opts;
  try { opts = await app.api('/api/rating/options'); } catch (e) { ui.outlinePanel = null; toast(`⚠️ ${esc(e.message)}`); return renderOutline(body); }
  if (!body.isConnected) return;
  const st = ui.ratingPlan;
  const running = Boolean(ui.jobs.rating);
  body.innerHTML = `<div class="ol-bar"><b>⚖️ 修改内容分级</b><button class="mini" id="rt-x">返回</button></div>
    <div class="sub">现在是「${RT[opts.current]}」。改分级不只是一个开关：AI 会按新的分级改写设定支柱、调整反派的心智，升到黑暗 / 悲剧时还会为世界设计按规律行事的威胁，并且生成（或调整）这个世界的大纲与结局。计划先经过评审，确认后才会应用到世界上（已经发生的事不会改变）。</div>
    <div class="ol-row">改成 <select id="rt-to">${Object.keys(RT).filter((k) => k !== opts.current).map((k) => `<option value="${k}" ${!opts.allowed.includes(k) ? 'disabled' : ''} ${st?.to === k ? 'selected' : ''}>${RT[k]}${!opts.allowed.includes(k) ? '（未授权）' : ''}</option>`).join('')}</select>
      <label class="mini-check"><input type="checkbox" id="rt-th" checked> 需要时生成威胁</label></div>
    <textarea id="rt-dir" rows="2" maxlength="300" placeholder="可选：想要什么样的变化，例如：大灰狼不再能被感化，森林里开始有人失踪">${esc(st?.direction || '')}</textarea>
    <div class="ol-bar"><button class="mini adm" id="rt-plan" ${running ? 'disabled' : ''}>🤖 生成适配计划</button></div>
    ${jobBar('rating')}
    ${st?.plan && !running ? planHTML(st.plan) : ''}`;
  $('#rt-x', body).onclick = () => { ui.outlinePanel = null; ui.ratingPlan = null; renderOutline(body); };
  const go = $('#rt-plan', body);
  go.onclick = async () => {
    const to = $('#rt-to', body).value, direction = $('#rt-dir', body).value.trim();
    go.disabled = true;
    ui.ratingPlan = { to, direction, plan: null };
    if (await startJob('rating', 'AI 正在设计分级适配计划（含大纲，约 2~4 分钟）', '/api/rating/plan', { to, direction, threats: $('#rt-th', body).checked }, { to, direction })) renderRating(body); else go.disabled = false;
  };
  bindApply(body, '/api/rating/apply', st?.plan, (r) => {
    ui.ratingPlan = null; ui.outlinePanel = null;
    toast(r.outline === 'saved' ? '⚖️ 分级已修改，大纲与结局也已经按新的分级保存' : r.outline === 'adjusting' ? '⚖️ 分级已修改，AI 正在按新的分级调整大纲' : '⚖️ 分级已修改（这次没有生成大纲，可以在大纲页手动生成）', 7000);
    renderOutline(body);
  });
}

function planHTML(p) {
  const s = p.summary || {};
  const major = p.review.issues.some((i) => i.severity === 'major');
  return `<div class="ol-plan"><h3>适配计划：${esc(s.fromName)} → ${esc(s.toName)}</h3>
    ${s.story ? `<p>${esc(s.story)}</p>` : ''}
    ${s.pillars ? `<div class="dec"><b>新的设定支柱</b>${s.pillars.map((x) => `<div>· ${esc(x)}</div>`).join('')}</div>` : ''}
    ${s.storyteller ? `<div class="dec"><b>叙事者</b> → ${esc(s.storyteller)}</div>` : ''}
    ${s.personas?.length ? `<div class="dec"><b>心智变化</b>${s.personas.map((x) => `<div>· ${esc(x.name)}${x.alignment ? `（${x.alignment === 'villain' ? '反派' : '中立'}）` : ''}${x.drives.length ? `：${x.drives.map(esc).join('；')}` : ''}</div>`).join('')}</div>` : ''}
    ${s.threats?.length ? `<div class="dec"><b>新的威胁</b>${s.threats.map((t) => `<div>· ${esc(t.emoji)} ${esc(t.name)}${t.kind ? `（${esc(t.kind)}）` : ''}${t.origin ? `：${esc(t.origin)}` : ''} <small>对抗：${t.counters.map(esc).join('、')}</small></div>`).join('')}</div>` : ''}
    ${s.items?.length || s.abilities?.length ? `<div class="dec"><b>新的物品与能力</b> ${[...s.items, ...s.abilities].map(esc).join('、')}</div>` : ''}
    ${s.hosts?.length ? `<div class="dec"><b>开局寄宿</b> ${s.hosts.map((h) => `${esc(h.name)} ← ${esc(h.threat)}`).join('、')}</div>` : ''}
    ${s.deathNamed != null ? `<div class="dec"><b>死亡预算</b> 每 3 天最多 ${s.deathNamed} 名具名角色</div>` : ''}
    ${s.outline ? `<div class="dec"><b>🗺️ ${s.outline.created ? '新的大纲' : '调整后的大纲'}</b>${s.outline.summary ? `<div class="sub">${esc(s.outline.summary)}</div>` : ''}
      ${s.outline.acts.map((a) => `<div>· <b>${esc(a.title)}</b>：${esc(a.plan)}</div>`).join('')}
      ${s.outline.endings.length ? `<div style="margin-top:4px">${s.outline.endings.map((e) => `${e.kind === 'bad' ? '🌑' : '🌅'} ${esc(e.title)}（${KIND[e.kind]}）${e.hint ? `：${esc(e.hint)}` : ''}`).join('<br>')}</div>` : '<div class="sub">没有设定结局</div>'}</div>` : ''}
    ${(s.notes || []).map((x) => `<div class="sub">· ${esc(x)}</div>`).join('')}
    ${reviewHTML(p.review)}
    <div class="ol-bar"><button class="mini adm" id="pl-apply" ${major || !p.planId ? 'disabled' : ''}>✅ 应用到世界</button>${app.perms.admin && p.planId ? '<button class="mini" id="pl-force">跳过评审应用</button>' : ''}</div></div>`;
}

function bindApply(body, path, plan, done) {
  if (!plan?.planId) return;
  const go = async (force) => {
    try { const r = await app.api(path, { planId: plan.planId, force }); if (r.failed?.length) toast(`⚠️ 有 ${r.failed.length} 项没有应用成功`); done(r); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
  };
  const a = $('#pl-apply', body);
  if (a) a.onclick = () => go(false);
  const f = $('#pl-force', body);
  if (f) f.onclick = () => confirm('跳过评审直接应用吗？这会记入审计日志。') && go(true);
}

// ---------- 开启下一部 ----------
function renderSequel(body, d) {
  const st = ui.sequelPlan;
  const n = (d.ending?.part || 1) + 1;
  const running = Boolean(ui.jobs.sequel);
  body.innerHTML = `<div class="ol-bar"><b>📖 开启第${n}部</b><button class="mini" id="sq-x">返回</button></div>
    <div class="sub">上一部的结局是「${esc(d.ending?.ended?.title || '')}」。写一句第${n}部的方向，AI 会规划新的一部和新的结局；评审通过后应用，世界会继续演进，史诗另起一部。</div>
    <textarea id="sq-dir" rows="2" maxlength="300" placeholder="例如：十年后，镇匣开始一个接一个地开裂">${esc(st?.direction || '')}</textarea>
    <div class="ol-row"><label class="mini-check"><input type="checkbox" id="sq-th" ${st?.threats ? 'checked' : ''}> 为世界补充新的威胁（黑暗 / 悲剧分级）</label></div>
    <div class="ol-bar"><button class="mini adm" id="sq-plan" ${running ? 'disabled' : ''}>🤖 规划第${n}部</button></div>
    ${jobBar('sequel')}
    ${st?.plan && !running ? `<div class="ol-plan"><h3>第${n}部「${esc(st.plan.title)}」</h3>
      ${(st.plan.draft.parts.at(-1)?.acts || []).map((a) => `<div class="ol-act planned"><b>${esc(a.title)}</b><p>${esc(a.plan)}</p>${a.beats.map((b) => `<div class="ol-beat">○ ${esc(b.text)}</div>`).join('')}</div>`).join('')}
      <h3>新的结局</h3>${st.plan.draft.endings.map((e) => `<div class="dec">${e.kind === 'bad' ? '🌑' : '🌅'} <b>${esc(e.title)}</b> <code>${esc(e.when)}</code>${e.for ? ` · 连续 ${e.for} 天` : ''}</div>`).join('') || '<div class="sub">没有结局</div>'}
      ${st.plan.content.threats.length ? `<div class="dec"><b>新的威胁</b> ${st.plan.content.threats.map(esc).join('、')}</div>` : ''}
      ${reviewHTML(st.plan.review)}
      <div class="ol-bar"><button class="mini adm" id="pl-apply" ${st.plan.review.issues.some((i) => i.severity === 'major') || !st.plan.planId ? 'disabled' : ''}>✅ 开启第${n}部</button>${app.perms.admin && st.plan.planId ? '<button class="mini" id="pl-force">跳过评审应用</button>' : ''}</div></div>` : ''}`;
  $('#sq-x', body).onclick = () => { ui.outlinePanel = null; ui.sequelPlan = null; renderOutline(body); };
  const go = $('#sq-plan', body);
  go.onclick = async () => {
    const direction = $('#sq-dir', body).value.trim();
    if (!direction) { toast('请写一句方向'); return; }
    const threats = $('#sq-th', body).checked;
    go.disabled = true;
    ui.sequelPlan = { direction, threats, plan: null };
    if (await startJob('sequel', `AI 正在规划第${n}部`, '/api/story/sequel', { direction, threats }, { direction, threats })) renderSequel(body, d); else go.disabled = false;
  };
  bindApply(body, '/api/story/sequel/apply', st?.plan, (r) => { ui.sequelPlan = null; ui.outlinePanel = null; toast(`📖 第${r.part}部「${esc(r.title)}」开始了`); renderOutline(body); });
}
