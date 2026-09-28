// 创世向导（多世界设计 §4.3）：1 来源 → 2 声明 → 3 选项 → 4 提交（排队位置、阶段、用量）→ 5 预览与编辑 → 6 发布
import { api, esc, $, $$, toast, ROOT, fmtNum } from './api.js';
import { loginDialog } from './auth.js';

const STAGES = { queued: '排队中', G1: '阅读原文', G2: '整理世界圣经', G3: '确定改编方案', G4: '生成地图、居民与剧情线', G5: '验证：考据、试跑、审核', done: '完成', failed: '失败' };
const RATING = { cozy: '温馨', adventure: '冒险', epic: '史诗', dark: '黑暗（允许战斗、怪异与死亡作为叙事事件）', tragic: '悲剧（允许离别与死亡作为叙事事件）' };
const app = $('#app');
const state = { source: 'paste', text: '', file: null };

async function boot() {
  const me = await api('api/me').catch(() => null);
  if (!me?.user || me.user.local && !me.admin) { app.innerHTML = '<div class="card"><p>创世需要登录。</p><button class="primary" id="login">登录</button></div>'; $('#login').onclick = async () => { if (await loginDialog()) boot(); }; return; }
  let q;
  try { q = await api('api/genesis/quota'); } catch (e) { app.innerHTML = `<div class="card"><h2>还没有创世权限</h2><p class="muted">${esc(e.message)}。创世权限由管理员授予，授予时会给出可创建的世界数、原文字数与 token 额度。</p><a href="./">← 回到大厅</a></div>`; return; }
  const jobId = new URLSearchParams(location.search).get('job');
  if (jobId) return progress(jobId);
  wizard(q);
}

function wizard(q) {
  const left = q.quota.genesisTokens - q.used.genesisTokens;
  app.innerHTML = `
    <h1>把一个故事变成会自己生活的世界</h1>
    <p class="muted">你的配额：还能创建 ${q.quota.maxWorlds - q.used.worlds} 个世界 · 原文最多 ${fmtNum(q.quota.maxSourceChars)} 字 · 创世额度剩余 ${fmtNum(left)} tokens</p>
    <div class="card stack">
      <h2>1 · 来源</h2>
      <div class="tabs">${[['paste', '粘贴原文'], ['file', '上传 .txt'], ['desc', '只写一段设定'], ['inspire', '参考题材（原创）']].map(([k, l]) => `<button data-src="${k}" class="${state.source === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div id="src-paste" ${state.source === 'paste' ? '' : 'hidden'}><textarea id="text" rows="10" placeholder="把童话、小说或剧本粘贴在这里">${esc(state.text)}</textarea><div class="small muted" id="count"></div></div>
      <div id="src-file" ${state.source === 'file' ? '' : 'hidden'}><input type="file" id="file" accept=".txt,text/plain"><div class="small muted" id="fcount"></div></div>
      <div id="src-desc" ${state.source === 'desc' || state.source === 'inspire' ? '' : 'hidden'}><textarea id="desc" rows="5" maxlength="2000" placeholder="${state.source === 'inspire' ? '写下你想要的世界：在哪里、什么基调、有哪些人、害怕什么……' : '例如：一座漂在云上的小城，住着会修风车的猫、怕高的鸟和一个捡到星星的孩子……'}"></textarea></div>
      <div id="src-inspire" class="stack" ${state.source === 'inspire' ? '' : 'hidden'}>
        <div class="small muted">参考模式不改编原著：只借用参考作品的类型要素（比如「规律怪谈」「代价沉重的力量」），人名、地名、专有名词和情节全部原创。</div>
        <input id="inspiration" maxlength="200" placeholder="题材参考，例如：像某部作品那样的规律怪谈">
        <textarea id="avoid" rows="2" maxlength="600" placeholder="避免清单：原作里的人名、地名、专有名词，用逗号隔开；生成的文本里出现它们会被拦下"></textarea>
      </div>
    </div>
    <div class="card stack" style="margin-top:14px">
      <h2>2 · 声明</h2>
      <label class="row"><input type="checkbox" id="decl"> 来源是公版作品，或者我本人有权使用（会写入审计记录）</label>
    </div>
    <div class="card stack" style="margin-top:14px">
      <h2>3 · 选项</h2>
      <div class="setting"><div class="k">世界短名<div class="help">分享链接会是 /w/短名/，发布后不能修改</div></div><div class="v"><input id="wid" placeholder="little-red" maxlength="32"><div class="small" id="wid-msg"></div></div></div>
      <div class="setting"><div class="k">开局时间点<div class="help">从原著的哪里开始</div></div><div class="v"><input id="start" maxlength="60" placeholder="故事开始之前"></div></div>
      <div class="setting"><div class="k">忠实度</div><div class="v"><select id="fidelity"><option value="faithful">忠实：尽量回到原著的关键情节</option><option value="drift" selected>偏离：关键节点以变形的方式出现</option><option value="free">自由：原著只当背景</option></select></div></div>
      <div class="setting"><div class="k">内容分级</div><div class="v"><select id="rating">${q.quota.ratings.map((r) => `<option value="${r}" ${r === 'adventure' ? 'selected' : ''}>${RATING[r] || r}</option>`).join('')}</select></div></div>
      <div class="setting"><div class="k">叙事者</div><div class="v"><select id="storyteller"><option value="voyage" selected>远航：每 7 天一个完整的故事</option><option value="gentle">静水：以日常为主</option><option value="chaos">掷骰：出人意料的小事频繁发生</option><option value="horror">恐怖：平静 → 征兆 → 受害者 → 恐慌 → 对抗</option></select></div></div>
      <div class="setting"><div class="k">生成按规律行事的威胁<div class="help">它们按各自的规律伤人，居民要靠线索、禁忌和对抗活下去（黑暗、悲剧分级默认开启）</div></div><div class="v"><label class="row"><input type="checkbox" id="threats"> 开启</label></div></div>
      <div class="setting"><div class="k">主角数量<div class="help">主角有完整的思考与反思，其余是配角</div></div><div class="v"><input id="leads" type="number" min="1" max="8" value="4"></div></div>
      <div class="setting"><div class="k">允许这个世界自主进化<div class="help">AI 可以为这个世界长出新功能（上线前由你终审）</div></div><div class="v"><label class="row"><input type="checkbox" id="evo"> 开启</label></div></div>
    </div>
    <div class="row" style="margin-top:16px"><button class="primary" id="go">4 · 提交创世</button><span id="go-msg" class="small"></span></div>`;
  for (const b of $$('[data-src]')) b.onclick = () => { state.text = $('#text')?.value || state.text; state.source = b.dataset.src; wizard(q); };
  const count = () => { const n = $('#text').value.length; $('#count').textContent = `${fmtNum(n)} 字${n > q.quota.maxSourceChars ? `，超过了你的配额 ${fmtNum(q.quota.maxSourceChars)} 字` : ''}`; };
  $('#text')?.addEventListener('input', count);
  if ($('#text')) count();
  $('#file')?.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    state.text = await f.text();
    $('#fcount').textContent = `${esc(f.name)} · ${fmtNum(state.text.length)} 字`;
  });
  let t = null;
  $('#wid').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const v = $('#wid').value.trim();
      if (!v) { $('#wid-msg').textContent = ''; return; }
      const r = await api(`api/worlds/id-available?id=${encodeURIComponent(v)}`);
      $('#wid-msg').innerHTML = r.ok ? `<span class="good">✓ 可以用：${esc(new URL(`w/${v}/`, ROOT).href)}</span>` : `<span class="bad">${esc(r.reason)}</span>`;
    }, 300);
  });
  // 黑暗、悲剧分级默认生成威胁（用户可以取消）
  const syncThreats = () => { $('#threats').checked = ['dark', 'tragic'].includes($('#rating').value); };
  $('#rating').addEventListener('change', syncThreats);
  syncThreats();
  $('#go').onclick = async () => {
    const btn = $('#go');
    btn.disabled = true;
    try {
      let sourceId = null;
      const text = state.source === 'paste' ? $('#text').value : state.source === 'file' ? state.text : '';
      if (text.trim()) {
        $('#go-msg').textContent = '上传原文并审核中…';
        const res = await fetch(new URL('api/genesis/source', ROOT), { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text, credentials: 'same-origin' });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error);
        sourceId = d.sourceId;
      }
      const r = await api('api/genesis', {
        id: $('#wid').value.trim(), sourceId, declaration: $('#decl').checked,
        options: {
          description: $('#desc')?.value || '', start: $('#start').value, fidelity: $('#fidelity').value, rating: $('#rating').value, leads: Number($('#leads').value), evolution: $('#evo').checked,
          storyteller: $('#storyteller').value, threats: $('#threats').checked,
          ...(state.source === 'inspire' ? { mode: 'inspire', inspiration: $('#inspiration').value, avoid: $('#avoid').value } : {}),
        },
      });
      history.replaceState(null, '', `?job=${r.jobId}`);
      progress(r.jobId);
    } catch (e) { $('#go-msg').innerHTML = `<span class="bad">⚠️ ${esc(e.message)}</span>`; btn.disabled = false; }
  };
}

async function progress(jobId) {
  let j;
  try { j = await api(`api/genesis/${jobId}`); } catch (e) { app.innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; return; }
  const order = ['G1', 'G2', 'G3', 'G4', 'G5'];
  const cur = order.indexOf(j.stage);
  app.innerHTML = `
    <h1>创世：${esc(j.worldId)}</h1>
    <div class="card stack">
      <div class="row"><b>${esc(STAGES[j.status === 'running' ? j.stage : j.status] || j.stage)}</b>
        ${j.status === 'queued' ? `<span class="pill warn">前面还有 ${j.position} 个任务</span>` : ''}<span class="muted small">已用 ${fmtNum(j.tokens)} tokens</span></div>
      <div class="row">${order.map((s, i) => `<span class="pill ${j.status === 'done' || i < cur ? 'good' : i === cur && j.status === 'running' ? 'warn' : ''}">${s} ${STAGES[s]}</span>`).join('')}</div>
      <div class="small muted">${j.log.map((l) => `<div>${esc(new Date(l.at).toLocaleTimeString())} · ${esc(l.stage)} ${esc(l.note || '')}</div>`).join('')}</div>
      ${j.status === 'failed' ? `<div class="banner bad">创世失败：${esc(j.error)}。短名已经释放，可以调整后重新提交。<a href="genesis.html">重新开始</a></div>` : ''}
      ${j.status === 'done' ? `<div class="banner">🎉 世界生成好了，现在是预览状态，只有你能看见。${j.report?.warnings?.length ? `<br>需要留意：${j.report.warnings.map(esc).join('；')}` : ''}</div>
        <div class="row"><a class="primary" href="draft.html#${encodeURIComponent(j.worldId)}"><button class="primary">5 · 预览与编辑</button></a><a href="w/${encodeURIComponent(j.worldId)}/" target="_blank"><button>进入世界看看</button></a></div>` : ''}
    </div>`;
  if (['queued', 'running'].includes(j.status)) setTimeout(() => progress(jobId), 2000);
}

boot();
