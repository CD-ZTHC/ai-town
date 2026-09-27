// 预览与编辑（多世界设计 §4.3 第 5、6 步）：人物卡、地点、设定集、叙述口吻，每项可以编辑，或者「重新生成这一项」；最后发布
import { api, esc, $, $$, toast, fmtNum } from './api.js';

const app = $('#app');
const id = decodeURIComponent(location.hash.slice(1));
const PART = { personas: '居民', map: '地图', extras: '剧情线、物品与本事', voice: '叙述口吻' };
const lines = (v) => String(v || '').split('\n').map((x) => x.trim()).filter(Boolean);

async function render() {
  let d;
  try { d = await api(`api/worlds/${encodeURIComponent(id)}/draft`); } catch (e) { app.innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; return; }
  const w = d.pack.world, map = d.pack.map, wr = d.world;
  const editable = ['drafting', 'preview'].includes(wr.status);
  const dis = editable ? '' : 'disabled';
  const places = map.regions.flatMap((r) => (r.areas || []).map((a) => ({ ...a, region: r.name })));
  const running = d.regen.find((j) => ['queued', 'running'].includes(j.status));
  app.innerHTML = `
    <div class="row" style="margin-bottom:12px"><h1 style="margin:0">${esc(w.voice.emoji)} ${esc(w.meta.name)}</h1><span class="pill ${wr.status === 'public' ? 'good' : 'warn'}">${esc(wr.status)}</span>
      <span class="grow" style="flex:1"></span><a href="w/${encodeURIComponent(id)}/" target="_blank"><button>进入世界看看</button></a>
      ${wr.status === 'preview' ? '<button class="primary" id="publish">6 · 发布</button>' : ''}</div>
    ${wr.statusReason ? `<div class="banner ${wr.status === 'suspended' ? 'bad' : ''}">${esc(wr.statusReason)}</div>` : ''}
    ${d.report?.warnings?.length ? `<div class="banner">生成时留意到：${d.report.warnings.map(esc).join('；')}</div>` : ''}
    ${running ? `<div class="banner">⏳ 正在重新生成「${esc(PART[running.log?.[0]?.note?.split('：')[1]] || '')}」…（${esc(running.stage)}）</div>` : ''}
    ${w.adaptation ? `<div class="card stack" style="margin-bottom:14px"><h2>改编方案</h2>
      <div class="small">开局：${esc(w.adaptation.start || '—')} · 忠实度：${esc({ faithful: '忠实', drift: '偏离', free: '自由' }[w.adaptation.fidelity] || w.adaptation.fidelity)}</div>
      <div class="small muted">${esc(w.adaptation.notes || '')}</div>
      <div class="small">命运节点：${w.adaptation.fateNodes.map((f) => `<span class="pill">第${f.day}天 ${esc(f.text)}</span>`).join(' ') || '—'}</div></div>` : ''}
    <div class="card stack" style="margin-bottom:14px"><div class="row"><h2 style="margin:0">设定</h2><span style="flex:1"></span>${regenBtn('voice', editable, running)}</div>
      <div class="setting"><div class="k">世界名</div><div class="v"><input id="title" value="${esc(w.meta.name)}" maxlength="16" ${dis}></div></div>
      <div class="setting"><div class="k">世界背景</div><div class="v"><textarea id="summary" rows="4" ${dis}>${esc(w.lore.summary)}</textarea></div></div>
      <div class="setting"><div class="k">支柱设定<div class="help">一行一条，世界里不可违背</div></div><div class="v"><textarea id="pillars" rows="3" ${dis}>${esc(w.lore.pillars.join('\n'))}</textarea></div></div>
      <div class="setting"><div class="k">欢迎语</div><div class="v"><input id="welcome" value="${esc(w.voice.ui.welcome)}" maxlength="200" ${dis}></div></div>
      <div class="setting"><div class="k">每晚的编年</div><div class="v"><input id="chronicle" value="${esc(w.voice.chronicle.name)}" maxlength="16" ${dis}></div></div>
      <div class="setting"><div class="k">事件示例<div class="help">一行一条</div></div><div class="v"><textarea id="events" rows="3" ${dis}>${esc(w.voice.ui.sampleEvents.join('\n'))}</textarea></div></div>
    </div>
    <div class="row" style="margin-bottom:8px"><h2 style="margin:0">居民（${w.personas.length}）</h2><span style="flex:1"></span>${regenBtn('personas', editable, running)}</div>
    <div class="cards" style="margin-bottom:14px">${w.personas.map((p) => `
      <div class="card stack" data-p="${esc(p.id)}">
        <div class="row"><span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:${esc(p.look.shirt)}"></span><input data-f="name" value="${esc(p.name)}" maxlength="12" style="width:110px" ${dis}>
          <span class="pill ${p.tier === 'support' ? '' : 'good'}">${p.tier === 'support' ? '配角' : '主角'}</span><span class="muted small">${esc(p.id)} · ${p.age} 岁</span></div>
        <input data-f="role" value="${esc(p.role)}" maxlength="30" ${dis}>
        <label class="small muted">性格与说话方式</label><textarea data-f="persona" rows="3" ${dis}>${esc(p.persona)}</textarea>
        <label class="small muted">此刻的目标</label><input data-f="goal" value="${esc(p.goal)}" maxlength="120" ${dis}>
        <label class="small muted">初始记忆（一行一条，只写本人知道的事）</label><textarea data-f="memories" rows="3" ${dis}>${esc(p.memories.join('\n'))}</textarea>
        <div class="small muted">住在 ${esc(p.home)} · 常在 ${esc(p.work)}</div>
      </div>`).join('')}</div>
    <div class="row" style="margin-bottom:8px"><h2 style="margin:0">地点</h2><span style="flex:1"></span>${regenBtn('map', editable, running)}</div>
    <div class="card" style="margin-bottom:14px">${places.map((a) => `<h3>${esc(a.name)} <span class="pill">${esc(a.biome)}</span></h3>
      <table>${a.places.map((p) => `<tr data-pl="${esc(p.id)}"><td style="width:60px"><input data-f="emoji" value="${esc(p.emoji || '')}" maxlength="4" style="width:44px" ${dis}></td>
        <td style="width:150px"><input data-f="name" value="${esc(p.name)}" maxlength="16" ${dis}></td><td><input data-f="desc" value="${esc(p.desc || '')}" maxlength="110" style="width:100%" ${dis}></td>
        <td class="small muted">${esc(p.kind)}${p.public === false ? ' · 私宅' : ''}</td></tr>`).join('')}</table>`).join('')}</div>
    <div class="row" style="margin-bottom:8px"><h2 style="margin:0">剧情线、物品与本事</h2><span style="flex:1"></span>${regenBtn('extras', editable, running)}</div>
    <div class="card stack" style="margin-bottom:14px">
      ${w.threads.map((t) => `<div>🧵 <b>${esc(t.title)}</b> <span class="muted small">${esc(t.hook)}</span></div>`).join('')}
      <div class="small">${Object.values(w.items).map((i) => `${esc(i.emoji)} ${esc(i.name)}`).join(' · ') || '（没有物品）'}</div>
      <div class="small">${w.abilities.map((a) => `${esc(a.emoji)} ${esc(a.name)}：${esc(a.desc)}`).join(' · ') || '（没有本事）'}</div>
    </div>
    ${d.pack.bible?.book ? `<div class="card small muted" style="margin-bottom:14px">原著：《${esc(d.pack.bible.book.title)}》${esc(d.pack.bible.book.summary)}（圣经里的人物 ${d.pack.bible.characters?.length || 0} 位，每条事实都标了出处或「改编」）</div>` : ''}
    ${editable ? '<div class="row" style="position:sticky;bottom:10px"><button class="primary" id="save">保存修改</button><span id="msg" class="small"></span></div>' : ''}`;

  $('#save')?.addEventListener('click', async () => {
    const body = {
      title: $('#title').value,
      lore: { summary: $('#summary').value, pillars: lines($('#pillars').value) },
      voice: { welcome: $('#welcome').value, chronicle: $('#chronicle').value, sampleEvents: lines($('#events').value) },
      personas: $$('[data-p]').map((el) => ({ id: el.dataset.p, name: $('[data-f="name"]', el).value, role: $('[data-f="role"]', el).value, persona: $('[data-f="persona"]', el).value, goal: $('[data-f="goal"]', el).value, memories: lines($('[data-f="memories"]', el).value) })),
      places: $$('[data-pl]').map((el) => ({ id: el.dataset.pl, emoji: $('[data-f="emoji"]', el).value, name: $('[data-f="name"]', el).value, desc: $('[data-f="desc"]', el).value })),
    };
    try { await api(`api/worlds/${encodeURIComponent(id)}/draft`, body, 'PATCH'); toast('✅ 已保存'); render(); } catch (e) { $('#msg').innerHTML = `<span class="bad">⚠️ ${esc(e.message)}</span>`; }
  });
  for (const b of $$('[data-regen]')) {
    b.onclick = async () => {
      if (!confirm(`重新生成「${PART[b.dataset.regen]}」？没保存的修改会丢失，会消耗创世额度。`)) return;
      try { await api(`api/worlds/${encodeURIComponent(id)}/draft/regenerate`, { part: b.dataset.regen }); toast('⏳ 已开始重新生成'); render(); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
    };
  }
  $('#publish')?.addEventListener('click', async () => {
    if (!confirm('发布之后世界对所有人公开，短名和世界包不能再修改。发布前会做一次自动审核（结构、文本、试跑、分级）。确定发布吗？')) return;
    const b = $('#publish');
    b.disabled = true; b.textContent = '审核中…';
    try { await api(`api/worlds/${encodeURIComponent(id)}/publish`, {}); toast('🎉 已发布'); render(); } catch (e) { toast(`⚠️ ${esc(e.message)}`, 8000); b.disabled = false; b.textContent = '6 · 发布'; }
  });
  if (running) setTimeout(render, 2500);
}

const regenBtn = (part, editable, running) => (editable ? `<button class="small" data-regen="${part}" ${running ? 'disabled' : ''}>🎲 重新生成</button>` : '');

if (!id) app.innerHTML = '<div class="banner bad">没有指定世界</div>';
else render();
window.addEventListener('hashchange', () => location.reload());
