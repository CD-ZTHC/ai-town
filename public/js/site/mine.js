// 我的世界（多世界设计 §12）：列表、状态、今日用量与降级档位、磁盘占用、待终审事项、进化开关；发布 / 暂停 / 恢复 / 归档
// 按世界配置模型服务（world-llm 设计 §10.2）：我的模型服务（凭据）、每个世界的 AI 设置、AI 服务暂停时的提示与修复入口
import { api, esc, $, $$, toast, fmtNum, fmtBytes } from './api.js';
import { loginDialog } from './auth.js';
import { credentialsPanel, aiDialog, worldSettingsDialog } from './ai-settings.js';

const STATUS = { drafting: '创世中', preview: '预览中（只有你能看见）', failed: '失败', public: '已公开', paused: '已暂停', unlisted: '暂不公开（收到举报）', suspended: '已下架', archived: '已归档' };
const PILL = { public: 'good', preview: 'warn', paused: 'warn', unlisted: 'warn', suspended: 'bad', failed: 'bad' };
const app = $('#app');

async function render() {
  let list;
  try { list = await api('api/worlds/mine'); } catch (e) {
    if (e.status === 401) { app.innerHTML = '<div class="card"><p>登录后才能看到你的世界。</p><button class="primary" id="login">登录</button></div>'; $('#login').onclick = async () => { if (await loginDialog()) render(); }; return; }
    app.innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; return;
  }
  const creds = '<div id="creds"></div>';
  if (!list.length) {
    app.innerHTML = `<div class="stack"><div class="card"><p>你还没有创建世界。</p><a href="genesis.html"><button class="primary">✨ 去创世</button></a></div>${creds}</div>`;
    credentialsPanel($('#creds'), { base: 'api/me/llm-credentials' });
    return;
  }
  app.innerHTML = `<div class="stack">${list.map((w) => {
    const ai = w.ai || {};
    const pct = w.diskLimitMB ? Math.round((w.diskBytes / (w.diskLimitMB * 1048576)) * 100) : null;
    return `<div class="card stack">
      <div class="row"><h2 style="margin:0">${esc(w.title)}</h2><span class="pill ${PILL[w.status] || ''}">${STATUS[w.status] || esc(w.status)}</span>
        <span class="muted small">/w/${esc(w.id)}/</span>${w.running ? `<span class="small">🟢 ${w.viewers} 人在看</span>` : ''}</div>
      ${w.statusReason ? `<div class="banner ${w.status === 'suspended' ? 'bad' : ''}">${esc(w.statusReason)}</div>` : ''}
      ${ai.halted ? `<div class="banner bad">⛔ ${esc(ai.haltText)}${ai.haltMessage ? `<div class="small">${esc(ai.haltMessage)}</div>` : ''}<div class="small">修好模型服务后世界会自动恢复。<a href="#" data-ai="${esc(w.id)}">去修复</a></div></div>` : ''}
      ${w.pendingDecisions ? `<div class="banner">🔔 有 ${w.pendingDecisions} 项决策等你终审（超时后由 AI 裁决官决定）<a href="w/${esc(w.id)}/?mode=observe">去看看</a></div>` : ''}
      ${w.job && ['queued', 'running'].includes(w.job.status) ? `<div class="small">⏳ 创世任务：${esc(w.job.stage)} <a href="genesis.html?job=${esc(w.job.id)}">查看进度</a></div>` : ''}
      <div class="stats">
        ${ai.active
          ? `<div class="stat"><span class="muted small">今日用量（自己的模型服务）</span><b>${fmtNum(w.ownUsage?.total || 0)}</b><span class="small muted">${ai.dailyTokens ? `上限 ${fmtNum(ai.dailyTokens)}` : '不限'} · ${esc(w.levelName || '')}${w.usage?.total ? ` · 审核用站点 ${fmtNum(w.usage.total)}` : ''}</span></div>`
          : `<div class="stat"><span class="muted small">今日用量</span><b>${fmtNum(w.usage?.total || 0)}</b><span class="small muted">${w.dailyLimit ? `额度 ${fmtNum(Math.round(w.dailyLimit))}` : '不限'} · ${esc(w.levelName || '')}</span></div>`}
        <div class="stat"><span class="muted small">模型</span><b style="font-size:15px">${ai.source === 'own' ? esc(ai.credential?.name || '（凭据已删除）') : '站点模型'}</b><span class="small muted">${ai.source === 'own' ? esc(ai.model || '') : ''}${ai.source === 'own' && !ai.active ? ' · 站点暂时关闭了自带模型，正在用站点模型' : ''}</span><button class="small" data-ai="${esc(w.id)}">AI 设置</button></div>
        <div class="stat"><span class="muted small">磁盘</span><b>${fmtBytes(w.diskBytes)}</b><span class="small ${pct > 100 ? 'bad' : pct > 80 ? 'warn' : 'muted'}">${pct != null ? `上限 ${w.diskLimitMB} MB（${pct}%）` : ''}${pct > 80 ? ' · 快满了，可以删掉一些时间线' : ''}</span></div>
        <div class="stat"><span class="muted small">人员流动</span><b>${w.migration ? '开启' : '关闭'}</b>${['public', 'paused', 'preview', 'unlisted'].includes(w.status) ? `<button class="small" data-mig="${esc(w.id)}" data-on="${w.migration ? 0 : 1}">${w.migration ? '关闭' : '开启'}</button>` : ''}<span class="small muted">会有新人到来、有人出门再回来</span></div>
        <div class="stat"><span class="muted small">自主进化</span><b>${w.evolution ? '开启' : '关闭'}</b>${['public', 'paused', 'preview', 'unlisted'].includes(w.status) ? `<button class="small" data-evo="${esc(w.id)}" data-on="${w.evolution ? 0 : 1}">${w.evolution ? '关闭' : '开启'}</button>` : ''}</div>
      </div>
      <div class="row">
        ${['public', 'paused', 'preview', 'unlisted'].includes(w.status) ? `<a href="w/${esc(w.id)}/"><button>进入世界</button></a>` : ''}
        ${['preview', 'drafting'].includes(w.status) ? `<a href="draft.html#${esc(w.id)}"><button>预览与编辑</button></a>` : ''}
        ${['public', 'paused', 'preview', 'unlisted'].includes(w.status) ? `<button data-settings="${esc(w.id)}">⚙️ 设置</button>` : ''}
        ${w.status === 'preview' ? `<button class="primary" data-act="publish" data-id="${esc(w.id)}">发布</button>` : ''}
        ${w.status === 'public' ? `<button data-act="pause" data-id="${esc(w.id)}">暂停</button>` : ''}
        ${w.status === 'paused' ? `<button class="primary" data-act="resume" data-id="${esc(w.id)}">恢复</button>` : ''}
        ${['public', 'paused', 'preview'].includes(w.status) ? `<button class="danger" data-act="archive" data-id="${esc(w.id)}">归档</button>` : ''}
      </div></div>`;
  }).join('')}${creds}</div>`;
  credentialsPanel($('#creds'), { base: 'api/me/llm-credentials', onChange: () => {} });
  for (const b of $$('[data-ai]')) b.onclick = (e) => { e.preventDefault(); aiDialog(b.dataset.ai, { onSaved: render }); };
  for (const b of $$('[data-settings]')) b.onclick = () => worldSettingsDialog(list.find((w) => w.id === b.dataset.settings), { onSaved: render });
  const CONFIRM = { publish: '发布之后世界对所有人公开，短名和世界包不能再修改。发布前会做一次自动审核。确定吗？', archive: '归档后世界停止运行、从大厅消失，30 天后清理数据，短名 30 天后才能被重新使用。确定吗？' };
  for (const b of $$('[data-act]')) {
    b.onclick = async () => {
      if (CONFIRM[b.dataset.act] && !confirm(CONFIRM[b.dataset.act])) return;
      b.disabled = true;
      try { await api(`api/worlds/${b.dataset.id}/${b.dataset.act}`, {}); toast('✅ 完成'); } catch (e) { toast(`⚠️ ${esc(e.message)}`, 8000); }
      render();
    };
  }
  for (const b of $$('[data-mig]')) {
    b.onclick = async () => { try { await api(`api/worlds/${b.dataset.mig}/settings`, { migration: b.dataset.on === '1' }, 'PATCH'); render(); } catch (e) { toast(`⚠️ ${esc(e.message)}`); } };
  }
  for (const b of $$('[data-evo]')) {
    b.onclick = async () => { try { await api(`api/worlds/${b.dataset.evo}/settings`, { evolution: b.dataset.on === '1' }, 'PATCH'); render(); } catch (e) { toast(`⚠️ ${esc(e.message)}`); } };
  }
}

render();
