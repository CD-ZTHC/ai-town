// 冒险的界面（docs/design/adventure.md §4.4~§4.8）：冒险者面板、预告滚动条、区域标题卡、升级卡片、撤退字幕、
// 世界全图（羊皮纸风格，道路点亮动画）、战斗音乐。只依赖快照的 adv 字段、区域视图与 adv 事件，不关心是哪个世界。
import { TS } from './render.js';
import { esc } from './ui.js';
import * as Stage from './stage.js';

let app;
const $ = (s) => document.querySelector(s);
const st = { panelT: 0, ticker: [], atlasOpen: false, atlasAnim: null, cards: [], subs: [], music: null, trail: [] };

export function init(a) {
  app = a;
  document.body.insertAdjacentHTML('beforeend', `
    <aside id="adv-panel" class="panel" data-safe="l" hidden>
      <div class="adv-head"><b id="adv-party"></b><button id="adv-atlas-btn" title="世界全图 (M)">🗺</button><button id="adv-fold" title="收起">▾</button></div>
      <div class="adv-front" id="adv-front"></div>
      <div class="adv-cards" id="adv-cards"></div>
      <div class="adv-foot" id="adv-foot"></div>
    </aside>
    <div id="adv-ticker" hidden></div>
    <div id="adv-title" hidden><small id="adv-title-sub"></small><b id="adv-title-main"></b><p id="adv-title-intro"></p></div>
    <div id="adv-cardbox"></div>
    <div id="adv-sub" hidden></div>
    <div id="atlas" hidden>
      <div class="atlas-card">
        <div class="atlas-head"><b>🗺 世界全图</b><span id="atlas-legend"></span><button id="atlas-close" aria-label="关闭">✕</button></div>
        <canvas id="atlas-canvas"></canvas>
      </div>
    </div>`);
  $('#adv-atlas-btn').addEventListener('click', () => openAtlas());
  $('#atlas-close').addEventListener('click', closeAtlas);
  $('#atlas').addEventListener('pointerdown', (e) => { if (e.target.id === 'atlas') closeAtlas(); });
  $('#adv-fold').addEventListener('click', () => { const p = $('#adv-panel'); p.classList.toggle('folded'); app.storage.set('town-adv-fold', p.classList.contains('folded') ? '1' : '0'); });
  // 窄屏默认收起（只留头像），用户展开过就按用户的来
  const fold = app.storage.get('town-adv-fold');
  if (fold === '1' || (fold == null && innerWidth < 1100)) $('#adv-panel').classList.add('folded');
  addEventListener('keydown', (e) => {
    if (e.target.closest?.('input,textarea')) return;
    if (e.key === 'm' || e.key === 'M') { if (st.atlasOpen) closeAtlas(); else if (app.snap?.adv) openAtlas(); }
    if (e.key === 'Escape' && st.atlasOpen) closeAtlas();
  });
  try { st.trail = JSON.parse(app.storage.get(trailKey()) || '[]'); } catch { st.trail = []; }
}

const trailKey = () => `town-trail-${app.perms?.world || 'yunxi'}`;

// ---------- 冒险者面板（§4.7） ----------
/** 每帧调用（内部限频）：焦点队伍的卡片、前线、今日战绩、进度物、预告 */
export function frame(S) {
  preloadNeighbors();
  const pt = st.pendingTitle;
  if (pt && (performance.now() > pt.until || app.view === pt.ev.region)) {
    st.pendingTitle = null;
    if (app.view === pt.ev.region) title(pt.ev.title || '', pt.ev.name, pt.ev.intro);
  }
  const adv = app.snap?.adv;
  const panel = $('#adv-panel');
  panel.hidden = !adv;
  $('#adv-ticker').hidden = !adv?.foreshadows?.length || app.mode === 'play';
  if (!adv) return;
  const now = performance.now();
  if (now - st.panelT < 300) return;
  st.panelT = now;
  const exp = adv.expeditions?.[0];
  const party = exp ? adv.parties?.[exp.party] : Object.values(adv.parties || {})[0];
  const ids = party?.members || adv.spotlight || [];
  $('#adv-party').textContent = party ? `⚔ ${party.name}` : '⚔ 冒险';
  const front = exp?.stages.find((x) => x.id === exp.front);
  $('#adv-front').innerHTML = front ? `🚩 <b>${esc(front.title)}</b><small>${esc(regionName(front.region))} · 击败 ${front.kills}${front.levelHint ? ` · 建议 Lv${front.levelHint}` : ''}</small>` : exp ? '🏁 远征完成' : '';
  const fights = new Set((app.snap.fights || []).flatMap((F) => F.fighters.map((f) => `${f.kind}:${f.id}`)));
  $('#adv-cards').innerHTML = ids.map((id) => {
    const a = app.snap.agents.find((x) => x.id === id);
    const m = app.meta[id];
    if (!a || !m) return '';
    const max = a.maxHp || 100, hp = a.hp ?? max, r = Math.max(0, Math.min(1, hp / max));
    const state = fights.has(`agent:${id}`) ? ['⚔', '战斗中'] : a.rest === 'downed' ? ['💫', '倒下了'] : a.rest ? ['🏕', '休整中'] : a.status === 'sleeping' ? ['💤', '睡觉'] : a.status === 'walking' ? ['🚶', '行军中'] : [a.emoji || '🙂', a.action || ''];
    return `<button class="adv-hero ${app.selected === id ? 'on' : ''} ${r < 0.3 ? 'danger' : ''}" data-id="${esc(id)}" title="${esc(m.name)}：${esc(state[1])}">
      <img src="${m.portrait || ''}" alt=""><span class="ah-name">${esc(m.name)}${a.lv ? `<i>Lv${a.lv}</i>` : ''}</span><span class="ah-st">${esc(state[0])}</span>
      <span class="ah-bar"><i style="width:${(r * 100).toFixed(0)}%" class="${r < 0.3 ? 'low' : r < 0.6 ? 'mid' : ''}"></i></span><span class="ah-hp">${Math.round(hp)}/${max}</span></button>`;
  }).join('');
  for (const b of document.querySelectorAll('#adv-cards .adv-hero')) b.onclick = () => { if (app.mode !== 'observe') app.setMode('observe'); app.select(b.dataset.id); };
  const d = adv.today || {};
  const tk = exp?.tokens;
  $('#adv-foot').innerHTML = `<span>今日 ⚔${d.kills || 0} · 🎁${d.loot || 0} · ↩${d.retreats || 0}</span>${tk ? `<span class="adv-tokens" title="${esc(tk.name)} ${tk.got}/${tk.total}">${tk.emoji} ${'◆'.repeat(tk.got)}${'◇'.repeat(Math.max(0, tk.total - tk.got))}</span>` : ''}`;
  // 预告滚动条
  const f = adv.foreshadows?.[0];
  if (f) $('#adv-ticker').innerHTML = `<span class="tk-emoji">${esc(f.emoji)}</span><span class="tk-text">${esc(f.text)}</span><small>${esc(regionName(f.region))}${f.eta ? ` · 约 ${f.eta} 分钟后` : ' · 就要来了'}</small>`;
  // 焦点角色走过的区域（世界全图的路线）
  const lead = app.snap.agents.find((x) => x.id === (adv.spotlight || [])[0]);
  if (lead && st.trail.at(-1) !== (lead.region || 'town')) { st.trail.push(lead.region || 'town'); st.trail = st.trail.slice(-40); app.storage.set(trailKey(), JSON.stringify(st.trail)); }
  if (st.atlasOpen) drawAtlas();
}

/** 游戏模式里走近通往休眠区域的路口时，先把那边的地图取回来（过图时本地预判要用） */
function preloadNeighbors() {
  if (app.mode !== 'play') return;
  const me = (app.snap?.avatars || []).find((v) => v.id === app.perms?.avatar);
  if (!me) return;
  for (const l of app.links || []) if (l.from === me.region && app.regionWorlds?.[l.to]?.stub && Math.hypot(l.a.x - me.x, l.a.y - me.y) < 12) app.loadRegion(l.to).catch(() => {});
}

const regionName = (id) => app.regionsOpen?.[id]?.name || (id === 'town' ? app.spec?.voice?.place || '小镇' : id);

// ---------- 事件（§4.4~§4.6） ----------
export function onAdv(ev) {
  app.renderer.onAdv?.(ev, app.renderer.S || {});
  const mode = Stage.mode();
  if (ev.type === 'levelup') {
    const g = ev.gains || {};
    const parts = [g.atk ? `攻 +${g.atk}` : '', g.def ? `防 +${g.def}` : '', g.maxHp ? `血 +${g.maxHp}` : ''].filter(Boolean).join(' · ');
    card(`⭐ ${esc(ev.name)} 升到了 <b>Lv ${ev.level}</b>`, [parts, ev.learned?.length ? `习得：${ev.learned.map((x) => esc(x.name)).join('、')}` : ''].filter(Boolean).join('<br>'), 'gold');
  }
  if (ev.type === 'foreshadow') sub(`${ev.emoji} ${ev.text}`, 'warn');
  if (ev.type === 'retreat') sub(`↩️ ${ev.name}退出战场，往${ev.toName}撤去`);
  if (ev.type === 'downed') sub(ev.carrier ? `🤝 ${ev.carrier.name}扶起倒下的${ev.name}，往${ev.toName}走去` : `💫 ${ev.name}倒下了……`, 'bad');
  if (ev.type === 'revive') sub(`✚ ${ev.name}在${ev.atName}醒了过来`);
  if (ev.type === 'party') card(`🤝 ${esc(ev.name)} ${ev.party ? `加入了${esc(ev.partyName)}` : `离开了${esc(ev.partyName)}`}`, '', 'gold');
  // 区域标题卡：只在观众正看着那张地图时播放（跟随的镜头会在一两秒内切过去）；2.5 秒内没看过去就不播
  if (ev.type === 'region' && mode !== 'off') st.pendingTitle = { ev, until: performance.now() + 2500 };
  if (ev.type === 'frontier') {
    card(`🚩 「${esc(ev.title)}」征服了${esc(ev.fromName)}`, ev.to?.length ? `前面的路打开了：${ev.to.map((x) => esc(x.name)).join('、')}` : '', 'gold');
    if (mode === 'all') setTimeout(() => openAtlas({ anim: ev }), 1200);
  }
}

/** 屏幕下方的一行字幕（撤退、倒下、醒来、预告） */
function sub(text, kind = '') {
  const el = $('#adv-sub');
  el.textContent = text;
  el.className = kind;
  el.hidden = false;
  clearTimeout(st.subT);
  st.subT = setTimeout(() => { el.hidden = true; }, 3800);
}

/** 右上角滑入的小卡片（升级、入队、征服） */
function card(head, body, kind = '') {
  const el = document.createElement('div');
  el.className = `adv-card ${kind}`;
  el.innerHTML = `<b>${head}</b>${body ? `<small>${body}</small>` : ''}`;
  $('#adv-cardbox').appendChild(el);
  while ($('#adv-cardbox').children.length > 3) $('#adv-cardbox').firstChild.remove();
  setTimeout(() => el.classList.add('out'), 4200);
  setTimeout(() => el.remove(), 4800);
}

/** 区域标题卡：「第二章 幽影森林」+ 一句引子 */
function title(sub, name, intro) {
  const el = $('#adv-title');
  $('#adv-title-sub').textContent = sub && !sub.includes(name) ? sub : '';
  $('#adv-title-main').textContent = sub && sub.includes(name) ? sub : name;
  $('#adv-title-intro').textContent = intro || '';
  el.hidden = false;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  app.renderer.sfx?.('chime');
  clearTimeout(st.titleT);
  st.titleT = setTimeout(() => { el.hidden = true; }, 4200);
}

// ---------- 世界全图（§4.5） ----------
/** 各区域在全图上的矩形：写了 atlas 的用它；相邻地图按接壤的方向拼；其余排在主地图上方 */
function atlasLayout() {
  const rs = app.regionsOpen || {};
  const ids = Object.keys(rs);
  const out = {};
  const size = (id) => { const r = rs[id]; const k = 0.5; return [Math.max(10, (r.W || 40) * k), Math.max(8, (r.H || 30) * k)]; };
  for (const id of ids) if (rs[id].atlas) { const [w, h] = size(id); out[id] = { x: rs[id].atlas.x * 2.2 - w / 2, y: rs[id].atlas.y * 1.4 - h / 2, w, h }; }
  if (!out.town) { const [w, h] = size('town'); out.town = { x: 100 - w / 2, y: 70 - h / 2, w, h }; }
  for (let pass = 0; pass < 6; pass++) for (const id of ids) {
    if (out[id]) continue;
    const adj = rs[id].adjacent;
    const base = adj && out[adj.to];
    const [w, h] = size(id);
    if (base) {
      const s = adj.side;
      out[id] = s === 'east' ? { x: base.x + base.w + 2, y: base.y, w, h } : s === 'west' ? { x: base.x - w - 2, y: base.y, w, h } : s === 'north' ? { x: base.x, y: base.y - h - 2, w, h } : { x: base.x, y: base.y + base.h + 2, w, h };
    } else if (!adj) {
      const n = Object.values(out).length;
      out[id] = { x: out.town.x + (n % 3) * 30 - 30, y: out.town.y - 34 - Math.floor(n / 3) * 26, w, h };
    }
  }
  return out;
}

function openAtlas({ anim = null } = {}) {
  st.atlasOpen = true;
  st.atlasAnim = anim ? { ...anim, born: performance.now() } : null;
  $('#atlas').hidden = false;
  drawAtlas();
  cancelAnimationFrame(st.atlasRaf);
  const tick = () => { if (!st.atlasOpen) return; drawAtlas(); st.atlasRaf = requestAnimationFrame(tick); };
  st.atlasRaf = requestAnimationFrame(tick);
  if (anim) { app.renderer.sfx?.('chime'); clearTimeout(st.atlasT); st.atlasT = setTimeout(() => { if (st.atlasAnim) closeAtlas(); }, 5200); }
}
function closeAtlas() { st.atlasOpen = false; st.atlasAnim = null; $('#atlas').hidden = true; cancelAnimationFrame(st.atlasRaf); }

const BIOME_COL = { meadow: '#8cc963', village: '#9ccf6a', forest: '#5a9a48', dark_forest: '#3e6e40', mountain: '#8a9478', volcano: '#7a4a3a', cave: '#5a524a', ruins: '#d9c79c', desert: '#e2c98f', castle: '#5b5866', snow: '#e8eef4', swamp: '#5d7a50', chaos: '#4a4158', sky: '#cfe3f5', lake: '#7ab8d8', urban: '#8a8c90', old_town: '#7a766e', autumn: '#c4a24e' };

function drawAtlas() {
  const cv = $('#atlas-canvas');
  const box = cv.parentElement.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  const W = Math.max(300, box.width - 24), H = Math.max(220, box.height - 64);
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const t = performance.now() / 1000;
  // 羊皮纸
  const bg = ctx.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, Math.hypot(W, H) / 1.6);
  bg.addColorStop(0, '#efe0bd'); bg.addColorStop(1, '#c9ad7a');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(90,60,30,.35)'; ctx.lineWidth = 3; ctx.strokeRect(8, 8, W - 16, H - 16);
  const lay = atlasLayout();
  const all = Object.values(lay);
  if (!all.length) return;
  const x0 = Math.min(...all.map((r) => r.x)), y0 = Math.min(...all.map((r) => r.y)), x1 = Math.max(...all.map((r) => r.x + r.w)), y1 = Math.max(...all.map((r) => r.y + r.h));
  const k = Math.min((W - 80) / (x1 - x0 || 1), (H - 80) / (y1 - y0 || 1));
  const P = (r) => ({ x: 40 + (r.x - x0) * k + ((W - 80) - (x1 - x0) * k) / 2, y: 40 + (r.y - y0) * k + ((H - 80) - (y1 - y0) * k) / 2, w: r.w * k, h: r.h * k });
  const exp = app.snap?.adv?.expeditions?.[0];
  const stageOf = Object.fromEntries((exp?.stages || []).map((s) => [s.region, s]));
  const anim = st.atlasAnim;
  const ak = anim ? Math.min(1, (performance.now() - anim.born) / 2200) : 1;
  const revealing = new Set(anim ? (anim.to || []).map((x) => x.region) : []);
  // 路口之间的连线（传送门是虚线）
  const center = (id) => { const r = lay[id] && P(lay[id]); return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : null; };
  ctx.lineWidth = 3;
  const seen = new Set();
  for (const l of app.links || []) {
    const kk = [l.from, l.to].sort().join('|');
    if (seen.has(kk)) continue;
    seen.add(kk);
    const a = center(l.from), b = center(l.to);
    if (!a || !b) continue;
    const adj = app.regionsOpen[l.to]?.adjacent || app.regionsOpen[l.from]?.adjacent;
    ctx.strokeStyle = 'rgba(110,70,30,.55)'; ctx.setLineDash(adj ? [] : [6, 6]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.setLineDash([]);
  // 各区域
  for (const [id, r0] of Object.entries(lay)) {
    const r = P(r0);
    const info = app.regionsOpen[id] || {};
    const sg = stageOf[id];
    const open = id === 'town' || info.open;
    const hidden = !open || (revealing.has(id) && ak < 0.7);
    ctx.save();
    ctx.beginPath(); ctx.roundRect?.(r.x, r.y, r.w, r.h, 10) ?? ctx.rect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = hidden ? '#6b6258' : BIOME_COL[info.biome] || '#9ccf6a';
    ctx.globalAlpha = hidden ? 0.75 : sg?.status === 'cleared' || id === 'town' || sg?.status === 'front' ? 1 : 0.7;
    ctx.fill();
    if (hidden) { // 迷雾
      ctx.globalAlpha = 0.5;
      for (let i = 0; i < 6; i++) { ctx.fillStyle = 'rgba(230,225,215,.35)'; ctx.beginPath(); ctx.ellipse(r.x + r.w * ((i * 0.37 + t * 0.03) % 1), r.y + r.h * ((i * 0.53) % 1), r.w * 0.3, r.h * 0.2, 0, 0, 7); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.roundRect?.(r.x, r.y, r.w, r.h, 10) ?? ctx.rect(r.x, r.y, r.w, r.h);
    ctx.lineWidth = sg?.status === 'front' ? 4 : 2;
    ctx.strokeStyle = sg?.status === 'front' ? `rgba(255,190,60,${0.6 + Math.sin(t * 4) * 0.4})` : 'rgba(70,45,20,.8)';
    ctx.stroke();
    ctx.restore();
    ctx.font = `700 ${Math.max(12, Math.min(16, r.w / 6))}px "Noto Serif SC","PingFang SC",serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = hidden ? '#e8e0d0' : '#2a1a0a';
    const label = hidden ? '？？？' : info.name || id;
    if (revealing.has(id)) ctx.globalAlpha = Math.max(0, (ak - 0.6) / 0.4) || (hidden ? 1 : 0);
    ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + (sg && !hidden ? -8 : 0));
    ctx.globalAlpha = 1;
    if (sg && !hidden) {
      ctx.font = '11px "PingFang SC",sans-serif'; ctx.fillStyle = 'rgba(40,25,10,.8)';
      ctx.fillText(sg.status === 'cleared' ? '🚩 已征服' : sg.status === 'front' ? '⚔ 前线' : '已开放', r.x + r.w / 2, r.y + r.h / 2 + 10);
    }
  }
  // 走过的路线
  const pts = st.trail.map(center).filter(Boolean);
  if (pts.length > 1) {
    ctx.strokeStyle = 'rgba(160,40,30,.7)'; ctx.lineWidth = 2; ctx.setLineDash([3, 5]);
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.stroke(); ctx.setLineDash([]);
  }
  // 道路点亮：金线从征服的区域伸向新打开的区域
  if (anim) for (const to of anim.to || []) {
    const a = center(anim.from), b = center(to.region);
    if (!a || !b) continue;
    const e = Math.min(1, ak / 0.7);
    ctx.save();
    ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 5; ctx.shadowColor = '#ffd166'; ctx.shadowBlur = 16;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x + (b.x - a.x) * e, a.y + (b.y - a.y) * e); ctx.stroke();
    ctx.restore();
  }
  // 焦点角色的位置
  const lead = app.snap?.agents.find((x) => x.id === (app.snap?.adv?.spotlight || [])[0]);
  const lr = lead && lay[lead.region || 'town'] && P(lay[lead.region || 'town']);
  if (lr) {
    const w = app.regionsOpen[lead.region || 'town'] || {};
    const px = lr.x + (lead.x / (w.W || 40)) * lr.w, py = lr.y + (lead.y / (w.H || 30)) * lr.h;
    const img = app.meta[lead.id]?.portraitImg;
    ctx.save();
    ctx.beginPath(); ctx.arc(px, py, 13, 0, 7); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = `rgba(255,190,60,${0.7 + Math.sin(t * 5) * 0.3})`; ctx.stroke();
    if (img?.complete) { ctx.beginPath(); ctx.arc(px, py, 11, 0, 7); ctx.clip(); ctx.drawImage(img, px - 11, py - 11, 22, 22); }
    ctx.restore();
  }
  $('#atlas-legend').textContent = exp?.tokens ? `${exp.tokens.emoji} ${exp.tokens.name} ${exp.tokens.got}/${exp.tokens.total}` : '';
}

// ---------- 战斗音乐（§4.9）：跟随音效开关 ----------
/** 看着的地图里有战斗时，淡入一段程序生成的鼓点和低音；有 Boss 时更快；战斗结束 2 秒后淡出 */
export function music(S) {
  const snd = app.sound;
  if (!snd?.on || !snd.ctx) { if (st.music) stopMusic(); return; }
  const fights = S.fights || [];
  const boss = fights.some((F) => F.fighters.some((f) => f.boss));
  const want = fights.some((F) => !F.solo || F.fighters.length > 1);
  const now = snd.ctx.currentTime;
  if (want) st.musicUntil = now + 2;
  if (!st.music && want) startMusic(snd);
  if (st.music) {
    st.music.bpm = boss ? 150 : 118;
    if (now > (st.musicUntil || 0)) stopMusic();
    else scheduleMusic(snd);
  }
}

function startMusic(snd) {
  const g = snd.ctx.createGain();
  g.gain.value = 0.0001;
  g.connect(snd.master);
  g.gain.exponentialRampToValueAtTime(0.5, snd.ctx.currentTime + 1);
  st.music = { gain: g, next: snd.ctx.currentTime + 0.05, step: 0, bpm: 118 };
}
function stopMusic() {
  const m = st.music;
  st.music = null;
  if (!m) return;
  try { m.gain.gain.cancelScheduledValues(0); m.gain.gain.setTargetAtTime(0.0001, m.gain.context.currentTime, 0.6); setTimeout(() => m.gain.disconnect(), 3000); } catch {}
}
/** 往前排 0.3 秒的音符：底鼓、军鼓、低音（小调的四个音循环） */
function scheduleMusic(snd) {
  const m = st.music, ctx = snd.ctx;
  const beat = 60 / m.bpm / 2; // 八分音符
  const BASS = [55, 55, 65.4, 49];
  while (m.next < ctx.currentTime + 0.3) {
    const t = m.next, s = m.step % 16;
    if (s % 4 === 0) drum(ctx, m.gain, t, 'kick');
    if (s % 8 === 4) drum(ctx, m.gain, t, 'snare');
    if (s % 2 === 0) { const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sawtooth'; o.frequency.value = BASS[Math.floor(m.step / 16) % 4] * (s % 4 === 2 ? 2 : 1); const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420; g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.0001, t + beat * 1.6); o.connect(f).connect(g).connect(m.gain); o.start(t); o.stop(t + beat * 2); }
    m.next += beat; m.step++;
  }
}
function drum(ctx, out, t, kind) {
  const g = ctx.createGain();
  if (kind === 'kick') { const o = ctx.createOscillator(); o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.15); g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2); o.connect(g).connect(out); o.start(t); o.stop(t + 0.22); return; }
  const n = ctx.createBufferSource(); const len = ctx.sampleRate * 0.15; const b = ctx.createBuffer(1, len, ctx.sampleRate); const d = b.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  n.buffer = b; const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1500;
  g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12); n.connect(f).connect(g).connect(out); n.start(t); n.stop(t + 0.15);
}

/** 焦点：游戏模式里是自己的化身，否则是跟随的人，再否则是焦点角色（危险暗角、敌我光圈用） */
export function focusOf() {
  if (app.mode === 'play' && app.perms.avatar) return `avatar:${app.perms.avatar}`;
  const id = app.follow || app.snap?.adv?.spotlight?.[0];
  return id ? `agent:${id}` : null;
}

void TS;
