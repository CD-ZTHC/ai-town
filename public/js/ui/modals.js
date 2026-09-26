// 其他弹窗：访客化身、发布事件、日报、关系网、说明、管理员
import { $, $$, app, closeModal, esc, face, guarded, name, openModal, toast } from './core.js';
import { closeInspector } from './inspector.js';
const AV_COLORS = ['#e57373', '#64b5f6', '#81c784', '#ffb74d', '#ba68c8', '#4db6ac', '#f06292', '#a1887f'];

export function avatarModal() {
  const mine = app.avatars.find((v) => v.id === app.perms.avatar);
  if (!mine) {
    const saved = app.storage.get('town-avatar-name') || '';
    let color = app.storage.get('town-avatar-color') || AV_COLORS[0];
    const card = openModal(`<h2>👣 以旅人的身份现身</h2>
      <div class="sub">起一个名字，你会以旅人的样子出现在中央广场。居民们看得见你、会跟你打招呼，和你聊过的话也会记住是你说的。20 分钟不操作会自动离开。</div>
      <div class="pform"><input id="av-name" maxlength="8" placeholder="你的名字（≤8 字）" value="${esc(saved)}">
      <div class="av-colors">${AV_COLORS.map((c) => `<button class="av-c${c === color ? ' on' : ''}" data-c="${c}" style="background:${c}"></button>`).join('')}</div>
      <button class="primary" id="av-go">现身 ✨</button><span class="quota" id="av-msg"></span></div>`);
    $$('.av-c', card).forEach((b) => b.addEventListener('click', () => { color = b.dataset.c; $$('.av-c', card).forEach((x) => x.classList.toggle('on', x === b)); }));
    $('#av-go', card).onclick = async () => {
      const name = $('#av-name', card).value.trim();
      try {
        const r = await app.api('/api/avatar', { name, color });
        app.storage.set('town-avatar-name', r.avatar.name); app.storage.set('town-avatar-color', r.avatar.color);
        await app.refreshPerms();
        app.setView('town');
        closeModal();
        toast(`👣 ${esc(r.avatar.name)}来到了中央广场`);
      } catch (e) { $('#av-msg', card).innerHTML = `<span style="color:var(--bad)">⚠️ ${esc(e.message)}</span>`; }
    };
    return;
  }
  const locs = Object.entries(app.spec.locations).filter(([, l]) => l.public && (!l.region || app.regionsOpen[l.region]?.open));
  const card = openModal(`<h2>👣 ${esc(mine.name)}</h2>
    <div class="sub">想去哪里？点一下就会走过去。${mine.region !== 'town' ? '（你现在在异界）' : ''}走到居民身边再和他们聊天，他们会知道是「站在面前的」你。</div>
    <div class="av-locs">${locs.map(([id, l]) => `<button class="mini" data-go="${id}">${l.region ? '🌗 ' : ''}${esc(l.name)}</button>`).join('')}</div>
    <div class="pact"><button class="mini" id="av-find">🔍 找到我</button><button class="mini" id="av-leave">👋 离开小镇</button></div>`);
  $$('[data-go]', card).forEach((b) => b.addEventListener('click', async () => {
    try { await app.api('/api/avatar/move', { location: b.dataset.go }); closeModal(); toast(`👣 前往${esc(app.spec.locations[b.dataset.go].name)}`); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
  }));
  $('#av-find', card).onclick = () => {
    const v = app.avatars.find((x) => x.id === app.perms.avatar);
    if (!v) return;
    app.follow = null;
    app.setView(v.region, { center: false });
    app.cam.x = v.x * 32 + 16; app.cam.y = v.y * 32 + 16;
    closeModal();
  };
  $('#av-leave', card).onclick = async () => { await app.api('/api/avatar/leave', {}).catch(() => {}); await app.refreshPerms(); closeModal(); };
}

const PRESETS = [
  '🎆 今晚八点，中央广场将举办一场神秘的烟花表演！',
  '🍉 陈家农场西瓜大丰收，下午五点在农场免费请全镇吃西瓜！',
  '🌊 有人在镜湖码头捡到一个漂流瓶，里面是半张藏宝图。',
  '💌 公告栏上出现一封匿名情书，收信人写着“咖啡馆的她”。',
  '🎪 流动马戏团明天抵达，今天下午在广场招募帮手。',
  '⚡ 气象台预警：今晚有雷暴，请大家早点回家。',
  '🎤 萤火节音乐会招募表演者，报名处设在星光咖啡馆。',
  '🐱 孙婆婆的猫走丢了，最后有人在樱花公园见过它。',
];

export function eventModal() {
  const opts = ['<option value="all">📢 全镇公告（所有人都会知道）</option>', ...Object.values(app.meta).map((a) => `<option value="${a.id}">✨ 只让 ${esc(a.name)} 知道（看消息如何传开）</option>`)].join('');
  const card = openModal(`
    <h2>📢 发布小镇事件</h2>
    <div class="sub">你是这座小镇的命运之手。写下一个事件，居民们会根据各自的性格、记忆与关系作出反应，并重新规划今天。</div>
    <textarea id="ev-text" rows="3" maxlength="120" style="width:100%" placeholder="例如：今晚八点，中央广场将举办一场神秘的烟花表演！"></textarea>
    <div class="presets">${PRESETS.map((p) => `<button>${esc(p)}</button>`).join('')}</div>
    <div class="row"><select id="ev-target">${opts}</select></div>
    <div class="row" style="justify-content:space-between"><span class="quota" id="ev-msg">${app.perms.admin ? '管理员不受频率限制' : `本小时还可发布 ${app.perms.remaining?.event ?? '-'} 次 · 事件会经过审核，请保持温馨友善`}</span>
      <span style="display:flex;gap:10px"><button class="ghost" id="ev-cancel">取消</button><button class="primary" id="ev-go">发布 ✨</button></span></div>`);
  card.style.width = 'min(640px, 94vw)';
  $$('.presets button', card).forEach((b) => b.addEventListener('click', () => { $('#ev-text').value = b.textContent.replace(/^\S+\s/, ''); }));
  $('#ev-cancel').onclick = closeModal;
  $('#ev-go').onclick = async (e) => {
    const text = $('#ev-text').value.trim();
    if (!text) return;
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = '审核中…';
    try {
      const r = await app.api('/api/event', { text, target: $('#ev-target').value });
      if (r.remaining) app.perms.remaining = r.remaining;
      closeModal();
      toast('🌀 消息已送达，居民们正在重新盘算……');
    } catch (err) {
      $('#ev-msg').innerHTML = `<span style="color:var(--bad)">⚠️ ${esc(err.message)}</span>`;
      btn.disabled = false; btn.textContent = '发布 ✨';
    }
  };
}

export async function newsModal(idx) {
  const papers = app.newspapers;
  if (!papers.length) {
    const card = openModal(`<div class="paper"><div class="masthead"><h1>云溪日报</h1></div><div class="paper-empty">
      <p>📰 本报每晚 22:45 出版，记录小镇一天里的大事小情。</p><p>今天的新闻还在发生中……</p>
      ${app.perms.admin ? '<button class="primary" id="np-now">📝 立即出版今日号外</button>' : ''}</div></div>`, 'paper-wrap');
    if ($('#np-now', card)) $('#np-now', card).onclick = publishNow;
    return;
  }
  const i = idx ?? papers.length - 1;
  const p = papers[i];
  const card = openModal(`
    <div class="paper-tabs">${papers.map((x, j) => `<button data-i="${j}" class="${i === j ? 'on' : ''}">第${x.day}天</button>`).join('')}${app.perms.admin ? '<button id="np-now" style="margin-left:auto">📝 出版号外</button>' : ''}</div>
    <div class="paper">
      <div class="masthead"><h1>云溪日报</h1>
        <div class="meta"><span>第 ${p.day} 期 · ${esc(p.weekday || '')}</span><span>YUNXI DAILY</span><span>天气：${esc(app.weathers[p.weather]?.name || '')} · 售价 两颗西瓜籽</span></div></div>
      <div class="headline">${esc(p.headline)}</div>
      <div class="subhead">${esc(p.subhead || '')}</div>
      <div class="lead">${esc(p.lead || '')}</div>
      <div class="cols">${(p.articles || []).slice(0, 3).map((a) => `<article><h3>${esc(a.title)}</h3>${esc(a.body)}</article>`).join('')}</div>
      <div class="pfoot">
        <div class="gossip"><b>🗣️ 街头巷尾</b><br>${esc(p.gossip || '')}</div>
        <div><div class="quote">“${esc(p.quote?.text || '')}”</div><div style="text-align:right">—— ${esc(p.quote?.who || '')}</div>
        <div style="margin-top:8px"><b>明日预告：</b>${esc(p.forecast || '')}</div></div>
      </div>
    </div>`, 'paper-wrap');
  $$('.paper-tabs button[data-i]', card).forEach((b) => b.addEventListener('click', () => newsModal(Number(b.dataset.i))));
  if ($('#np-now', card)) $('#np-now', card).onclick = publishNow;
}

async function publishNow(e) {
  const b = e.currentTarget;
  b.disabled = true;
  b.textContent = '✒️ 主编正在奋笔疾书……';
  try {
    await app.api('/api/newspaper', {});
    newsModal();
  } catch (err) {
    b.disabled = false; b.textContent = '📝 重试';
    toast(`⚠️ 出版失败：${esc(err.message)}`);
  }
}

export async function graphModal() {
  const card = openModal(`<h2>🕸️ 关系网络</h2><div class="sub">箭头表示“谁对谁”的好感，颜色越绿越亲近、越红越疏远；悬停头像查看细节，点击头像查看居民。</div>
    <canvas id="graph"></canvas>
    <div class="legend"><span><i style="background:#7ddc8a"></i>亲近</span><span><i style="background:#8a8aa0"></i>普通</span><span><i style="background:#ff7a7a"></i>疏远</span></div>
    <div id="graph-info" style="min-height:70px;margin-top:10px;font-size:12.5px"></div>`, 'graph-wrap');
  const data = await app.api('/api/relations');
  const cv = $('#graph', card);
  const dpr = devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  const n = data.length;
  const R = Math.min(W, H) * 0.38;
  const pos = Object.fromEntries(data.map((a, i) => {
    const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
    return [a.id, [W / 2 + Math.cos(ang) * R, H / 2 + Math.sin(ang) * R]];
  }));
  const imgs = Object.fromEntries(data.map((a) => { const im = new Image(); im.src = face(a.id); return [a.id, im]; }));
  let hover = null, t0 = performance.now();
  const colorOf = (v) => v >= 0 ? `rgba(${Math.round(138 - v)},${Math.round(138 + v * 0.8)},${Math.round(160 - v * 0.2)},` : `rgba(255,${Math.round(122 + v * 0.5)},${Math.round(122 + v * 0.5)},`;
  function draw() {
    if (!document.body.contains(cv)) return;
    const t = (performance.now() - t0) / 1000;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    for (const a of data) for (const r of a.relations) {
      if (!pos[r.id]) continue;
      const on = !hover || hover === a.id || hover === r.id;
      const [x1, y1] = pos[a.id], [x2, y2] = pos[r.id];
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const nx = -(y2 - y1) * 0.12, ny = (x2 - x1) * 0.12;
      const cx = mx + nx, cy = my + ny;
      const v = r.affinity;
      g.strokeStyle = colorOf(v) + (on ? 0.9 : 0.08) + ')';
      g.lineWidth = 1 + Math.abs(v) / 18;
      g.beginPath(); g.moveTo(x1, y1); g.quadraticCurveTo(cx, cy, x2, y2); g.stroke();
      // 流动的光点
      if (on) {
        const p = (t * 0.35 + (a.id.length + r.id.length) * 0.13) % 1;
        const px = (1 - p) ** 2 * x1 + 2 * (1 - p) * p * cx + p * p * x2, py = (1 - p) ** 2 * y1 + 2 * (1 - p) * p * cy + p * p * y2;
        g.fillStyle = colorOf(v) + '1)';
        g.beginPath(); g.arc(px, py, 2.5, 0, 7); g.fill();
      }
      // 箭头
      const k = 0.78;
      const ax = (1 - k) ** 2 * x1 + 2 * (1 - k) * k * cx + k * k * x2, ay = (1 - k) ** 2 * y1 + 2 * (1 - k) * k * cy + k * k * y2;
      const ang = Math.atan2(y2 - cy, x2 - cx);
      g.fillStyle = colorOf(v) + (on ? 0.9 : 0.08) + ')';
      g.beginPath(); g.moveTo(ax + Math.cos(ang) * 7, ay + Math.sin(ang) * 7); g.lineTo(ax + Math.cos(ang + 2.5) * 7, ay + Math.sin(ang + 2.5) * 7); g.lineTo(ax + Math.cos(ang - 2.5) * 7, ay + Math.sin(ang - 2.5) * 7); g.fill();
    }
    for (const a of data) {
      const [x, y] = pos[a.id];
      const s = hover === a.id ? 64 : 54;
      g.save();
      g.shadowColor = hover === a.id ? '#ffb86b' : 'rgba(0,0,0,.5)'; g.shadowBlur = hover === a.id ? 24 : 10;
      g.beginPath(); g.arc(x, y, s / 2, 0, 7); g.fillStyle = '#222'; g.fill();
      g.restore();
      g.imageSmoothingEnabled = false;
      if (imgs[a.id].complete) g.drawImage(imgs[a.id], x - s / 2, y - s / 2, s, s);
      g.fillStyle = '#fff'; g.font = '600 13px "PingFang SC",sans-serif'; g.textAlign = 'center';
      g.fillText(a.name, x, y + s / 2 + 16);
    }
    requestAnimationFrame(draw);
  }
  draw();
  const info = $('#graph-info', card);
  const hitNode = (e) => {
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    return data.find((a) => Math.hypot(pos[a.id][0] - x, pos[a.id][1] - y) < 30)?.id || null;
  };
  cv.addEventListener('mousemove', (e) => {
    const id = hitNode(e);
    cv.style.cursor = id ? 'pointer' : 'default';
    if (id === hover) return;
    hover = id;
    if (!id) { info.innerHTML = ''; return; }
    const a = data.find((x) => x.id === id);
    const inbound = data.flatMap((o) => o.relations.filter((r) => r.id === id).map((r) => ({ from: o.id, ...r })));
    info.innerHTML = `<b>${esc(a.name)} 眼中的别人：</b> ${a.relations.map((r) => `${esc(name(r.id))}(<span style="color:${r.affinity >= 0 ? 'var(--good)' : 'var(--bad)'}">${r.affinity}</span>) ${esc(r.note)}`).join('；')}<br><b style="color:var(--muted)">别人眼中的 TA：</b> ${inbound.map((r) => `${esc(name(r.from))}：${esc(r.note)}`).join('；')}`;
  });
  cv.addEventListener('click', (e) => { const id = hitNode(e); if (id) { closeModal(); app.select(id); } });
}

export function helpModal() {
  const adm = app.perms.admin;
  const k = (x) => x.split(' ').map((y) => (y === '/' ? '/' : `<kbd>${y}</kbd>`)).join(' ');
  const rows = [
    ['WASD / 方向键', '平移镜头', '—', '走路'],
    ['拖拽 / 滚轮', '平移 / 缩放', '—', '平移 / 缩放'],
    ['点击', '查看居民', '显示控制条', '走过去 / 和居民聊天'],
    ['空格', adm ? '暂停' : '—', '锁定镜头', '—'],
    ['Tab', '切换居民', '下一个镜头', '切换附近的人'],
    ['E', '—', '—', '和最近的人聊天'],
    ['F', '跟随选中的居民', '—', '镜头回到自己'],
    ['I / G', '进入沉浸 / 游戏', '退出', '—'],
    ['Ctrl+K', '搜索与跳转', '—', '搜索与跳转'],
    ['Esc', '关闭面板', '退出沉浸', '结束对话 / 退出游戏'],
  ];
  openModal(`<h2>🌸 欢迎来到云溪镇</h2>
  <div class="sub">一座由大语言模型驱动的生成式智能体小镇。居民们各有性格、记忆、秘密和目标，他们会自己规划一天、相遇交谈、传播消息、反思成长。</div>
  <div class="help-modes">
    <button data-go="observe"><b>🔭 观察模式</b><small>点击居民查看日程、记忆、关系与日记；发布事件、改变天气、翻阅日报。</small></button>
    <button data-go="immerse"><b>🎬 沉浸模式</b><small>隐藏界面，镜头自动去有故事的地方，对白变成字幕。适合挂着慢慢看。</small></button>
    ${app.perms.interaction ? '<button data-go="play"><b>🎮 游戏模式</b><small>以旅人的身份走进小镇，走到居民身边和 TA 聊天——TA 会记住你。</small></button>' : ''}
  </div>
  <table class="keys"><thead><tr><th></th><th>🔭 观察</th><th>🎬 沉浸</th><th>🎮 游戏</th></tr></thead>
  <tbody>${rows.map(([key, ...c]) => `<tr><td>${k(key)}</td>${c.map((x) => `<td>${x}</td>`).join('')}</tr>`).join('')}</tbody></table>
  ${adm ? '<div class="sub" style="margin-top:8px">管理员：<kbd>1-4</kbd> 调速。</div>' : ''}
  ${app.perms.publicMode && !adm ? `<div class="sub" style="margin-top:10px">🌿 你正以访客身份参观：可以搭话、发布事件和改变天气（有频率限制，内容会经过审核）；时间流速由小镇管理员掌管。</div>` : ''}
  <div class="row" style="justify-content:flex-end"><button class="primary" id="help-ok">开始 ✨</button></div>`, 'help');
  $('#help-ok').onclick = closeModal;
  $$('.help-modes [data-go]').forEach((b) => b.addEventListener('click', () => { closeModal(); app.setMode(b.dataset.go); }));
}

export function adminModal() {
  openModal(`<h2>🔐 管理</h2>
  <div class="sub">${app.perms.admin ? '已登录为管理员：可以调速、暂停、立即出版号外和重置小镇。' : '输入管理员令牌后，可以调速、暂停、立即出版号外和重置小镇。'}</div>
  <form id="admin-form" class="chatin">${app.perms.admin ? '<span class="quota" style="flex:1">已登录为管理员</span><button class="ghost" type="button" id="admin-out">退出登录</button>' : '<input id="admin-token" type="password" autocomplete="current-password" placeholder="管理员令牌"><button class="send">登录</button>'}</form>
  ${app.perms.admin ? '<div class="row"><button class="ghost" id="help-reset">🔄 重置小镇</button></div>' : ''}`, 'help');
  $('#admin-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    app.storage.set('town-admin', $('#admin-token').value.trim());
    await app.refreshPerms();
    if (app.perms.admin) { toast('🔐 已登录为管理员'); closeModal(); }
    else { app.storage.set('town-admin', null); toast('⚠️ 令牌不正确'); }
  });
  $('#admin-out')?.addEventListener('click', async () => {
    app.storage.set('town-admin', null);
    await app.refreshPerms();
    closeModal();
    toast('已退出管理员');
  });
  $('#help-reset')?.addEventListener('click', guarded(async (e) => {
    const b = e.currentTarget;
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = '⚠️ 再点一次：重新开始（旧存档会自动备份）'; return; }
    await app.api('/api/reset', { confirm: 'RESET' });
    closeModal();
    closeInspector();
    toast('🌱 小镇回到了第一天的清晨');
  }));
}
