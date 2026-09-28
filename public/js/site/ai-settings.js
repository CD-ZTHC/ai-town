// 按世界配置模型服务（docs/design/world-llm.md §10.2）：模型服务凭据的管理、世界的 AI 设置对话框、世界设置对话框。
// 「我的世界」和管理面板共用。密钥只在填写时经过浏览器，之后接口只返回末 4 位。
import { api, esc, $, $$, dialog, toast, fmtNum } from './api.js';

export const PROVIDERS = { openai: 'OpenAI 兼容接口', anthropic: 'Anthropic（Claude）', google: 'Google（Gemini）' };
const STATUS = { ok: ['good', '正常'], unchecked: ['', '未测试'], failing: ['bad', '出错'] };
const FAIL = { auth: '密钥无效或没有权限', balance: '余额不足', model: '模型不存在', address: '地址不允许访问', net: '连不上', credential: '凭据失效' };
const PLACEHOLDER = { openai: 'https://api.deepseek.com/v1', anthropic: '留空 = 官方地址', google: '留空 = 官方地址' };

export const credStatus = (c) => {
  const [cls, text] = STATUS[c.status] || ['', c.status];
  return `<span class="pill ${cls}">${text}${c.status === 'failing' && c.failCode ? `：${esc(FAIL[c.failCode] || c.failCode)}` : ''}</span>`;
};

/**
 * 凭据列表与增删改查
 * @param {HTMLElement} el
 * @param {{ base: string, title?: string, onChange?: () => void }} o base：'api/me/llm-credentials' 或 'api/admin/llm-credentials'
 */
export async function credentialsPanel(el, { base, title = '🔑 我的模型服务', onChange = null }) {
  let r;
  try { r = await api(base); } catch (e) {
    if (e.status === 403 || e.status === 401) { el.innerHTML = ''; return; } // 没有创世权限：不显示
    el.innerHTML = `<div class="banner bad">${esc(e.message)}</div>`; return;
  }
  const full = r.max != null && r.list.length >= r.max;
  el.innerHTML = `<div class="card stack">
    <div class="row"><h2 style="margin:0">${title}</h2><span class="grow" style="flex:1"></span>
      ${r.enabled ? `<button class="small primary" id="cred-add" ${full ? 'disabled' : ''}>＋ 添加</button>` : ''}</div>
    <p class="muted small" style="margin:0">世界可以使用你自己的模型服务，不占用站点额度；世界里的所有模型调用（包括旅人和居民的对话）都会用它，只有内容审核仍由站点完成。
      密钥加密保存，保存后谁都看不到原文（包括管理员），页面上只显示末 4 位。${r.max != null ? `最多 ${r.max} 份。` : ''}</p>
    ${r.enabled ? '' : '<div class="banner">站点暂时没有开放自带模型服务。</div>'}
    ${r.list.length ? `<table><tr><th>名称</th><th>类型与地址</th><th>密钥</th><th>状态</th><th>使用它的世界</th><th></th></tr>
      ${r.list.map((c) => `<tr>
        <td>${esc(c.name)}</td>
        <td class="small">${esc(PROVIDERS[c.provider] || c.provider)}<div class="muted">${esc(c.baseUrl || '官方地址')}</div></td>
        <td class="small"><code>●●●● ${esc(c.keyLast4)}</code></td>
        <td>${credStatus(c)}${c.lastError ? `<div class="small bad" style="max-width:260px">${esc(c.lastError)}</div>` : ''}${c.checkedAt ? `<div class="small muted">${esc(new Date(c.checkedAt).toLocaleString())}</div>` : ''}</td>
        <td class="small">${c.worlds.map((w) => `${esc(w.title)}${w.halted ? ' <span class="bad">（已暂停）</span>' : ''}`).join('<br>') || '<span class="muted">—</span>'}</td>
        <td><div class="row"><button class="small" data-test="${esc(c.id)}">测试</button><button class="small" data-edit="${esc(c.id)}">修改</button><button class="small danger" data-del="${esc(c.id)}">删除</button></div></td>
      </tr>`).join('')}</table>` : '<div class="muted small">还没有添加。</div>'}
  </div>`;
  const reload = () => { credentialsPanel(el, { base, title, onChange }); onChange?.(); };
  $('#cred-add', el)?.addEventListener('click', () => credentialDialog({ base, providers: r.providers, privateNet: r.privateNet, onSaved: reload }));
  for (const b of $$('[data-edit]', el)) b.onclick = () => credentialDialog({ base, providers: r.providers, privateNet: r.privateNet, cred: r.list.find((c) => c.id === b.dataset.edit), onSaved: reload });
  for (const b of $$('[data-test]', el)) {
    b.onclick = async () => {
      b.disabled = true;
      b.textContent = '测试中…';
      try {
        const t = await api(`${base}/${b.dataset.test}/test`, {});
        toast(t.ok ? `✅ 连接正常（${t.ms} ms）${t.models?.length ? `，${t.models.length} 个模型` : ''}${t.warning ? `：${esc(t.warning)}` : ''}` : `⚠️ ${esc(FAIL[t.kind] || '')}：${esc(t.error)}`, 8000);
      } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
      reload();
    };
  }
  for (const b of $$('[data-del]', el)) {
    b.onclick = async () => {
      const id = b.dataset.del;
      try { await api(`${base}/${id}`, undefined, 'DELETE'); toast('已删除'); } catch (e) {
        if (!e.data?.confirm) { toast(`⚠️ ${esc(e.message)}`); return; }
        if (!confirm(`${e.message}：\n${e.data.worlds.map((w) => `· ${w.title}`).join('\n')}\n\n确定删除吗？`)) return;
        await api(`${base}/${id}?confirm=1`, undefined, 'DELETE');
        toast('已删除，使用它的世界已暂停');
      }
      reload();
    };
  }
}

/** 添加 / 修改一份凭据 */
function credentialDialog({ base, providers, privateNet, cred = null, onSaved }) {
  const d = dialog(`<h2>${cred ? '修改模型服务' : '添加模型服务'}</h2>
    <form id="cf">
      <label>名称</label><input name="name" maxlength="20" value="${esc(cred?.name || '')}" placeholder="例如：我的 DeepSeek">
      <label>类型</label><select name="provider">${providers.map((p) => `<option value="${p}" ${cred?.provider === p ? 'selected' : ''}>${esc(PROVIDERS[p] || p)}</option>`).join('')}</select>
      <label>接口地址</label><input name="baseUrl" value="${esc(cred?.baseUrl || '')}" placeholder="${PLACEHOLDER[cred?.provider || providers[0]] || ''}">
      <div class="muted small">${privateNet ? '可以填本机或内网地址（例如 http://localhost:11434/v1）。' : '必须是 https，不能是内网地址。'}</div>
      <label>密钥${cred ? `（当前 ●●●● ${esc(cred.keyLast4)}，留空不修改）` : ''}</label><input name="apiKey" type="password" autocomplete="off" ${cred ? '' : 'required'}>
      <div class="bad small" id="cf-msg" style="margin-top:8px"></div>
      <div class="actions"><button type="button" id="cf-cancel">取消</button><button class="primary" id="cf-ok">${cred ? '保存并测试' : '保存'}</button></div>
    </form>`);
  const sel = $('[name=provider]', d.el);
  sel.onchange = () => { $('[name=baseUrl]', d.el).placeholder = PLACEHOLDER[sel.value] || ''; };
  $('#cf-cancel', d.el).onclick = d.close;
  $('#cf', d.el).onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    if (cred && !body.apiKey) delete body.apiKey;
    $('#cf-ok', d.el).disabled = true;
    try {
      const r = cred ? await api(`${base}/${cred.id}`, body, 'PATCH') : await api(base, body);
      d.close();
      if (r.test) toast(r.test.ok ? '✅ 已保存，连接正常；因它暂停的世界已恢复' : `⚠️ 已保存，但测试没通过：${esc(r.test.error)}`, 8000);
      else toast(cred ? '✅ 已保存' : '✅ 已添加，可以点「测试」检查一下');
      onSaved?.();
    } catch (err) { $('#cf-msg', d.el).textContent = err.message; $('#cf-ok', d.el).disabled = false; }
  };
}

/** 模型名输入框：有测试连接拿到的模型列表时给出下拉提示 */
const modelInput = (name, value, models, placeholder = '') => `<input name="${name}" value="${esc(value || '')}" list="ml-${name}" placeholder="${esc(placeholder)}" autocomplete="off">
  <datalist id="ml-${name}">${(models || []).map((m) => `<option value="${esc(m)}">`).join('')}</datalist>`;

/**
 * AI 设置的表单片段（世界的 AI 设置对话框、创世向导共用）
 * @param {object} ai 当前配置（normalizeAi 的形式）
 * @param {object[]} creds 可以选的凭据
 */
export function aiForm(ai, creds, { maxConcurrency = 4, allowed = true, serverNote = '' } = {}) {
  const own = ai.source === 'own';
  const cred = creds.find((c) => c.id === ai.credential) || creds[0];
  const models = cred?.models || [];
  return `<div class="stack ai-form">
    <label class="row" style="margin:0"><input type="radio" name="source" value="server" ${own ? '' : 'checked'}> 使用站点的模型${serverNote ? `<span class="muted small">${esc(serverNote)}</span>` : ''}</label>
    <label class="row" style="margin:0"><input type="radio" name="source" value="own" ${own ? 'checked' : ''} ${allowed && creds.length ? '' : 'disabled'}> 使用我自己的模型服务
      ${!allowed ? '<span class="muted small">（站点没有开放）</span>' : !creds.length ? '<span class="muted small">（先在「我的模型服务」里添加一份）</span>' : ''}</label>
    <div class="own-fields stack" ${own ? '' : 'hidden'}>
      <label>模型服务</label><select name="credential">${creds.map((c) => `<option value="${esc(c.id)}" ${c.id === cred?.id ? 'selected' : ''}>${esc(c.name)}（${esc(PROVIDERS[c.provider] || c.provider)}）${c.status === 'failing' ? ' ⚠️' : ''}</option>`).join('')}</select>
      <label>默认模型</label>${modelInput('m-default', ai.models?.default, models, '必填')}
      <label>快模型（内心独白等高频小任务）</label>${modelInput('m-fast', ai.models?.fast, models, '不填用默认模型')}
      <label>强模型（导演、日报、世界架构师）</label>${modelInput('m-smart', ai.models?.smart, models, '不填用默认模型')}
      <div class="row"><div><label>并发（最多 ${maxConcurrency}）</label><input name="concurrency" type="number" min="1" max="${maxConcurrency}" value="${ai.concurrency || 2}" style="width:90px"></div>
        <div><label>每日上限（token，0 = 不限）</label><input name="dailyTokens" type="number" min="0" value="${ai.dailyTokens || 0}" style="width:140px"></div></div>
      <details><summary class="small muted">高级</summary>
        <label>单次请求超时（毫秒）</label><input name="timeoutMs" type="number" min="5000" value="${ai.timeoutMs || 150000}">
        <label class="row"><input type="checkbox" name="jsonMode" ${ai.jsonMode !== false ? 'checked' : ''}> JSON 模式（网关不支持时会自动关闭）</label>
        <label class="row"><input type="checkbox" name="jsonSchema" ${ai.jsonSchema ? 'checked' : ''}> 结构化输出（json_schema）</label>
        <label>语义检索的 embedding 模型（只支持 OpenAI 兼容接口，不填不开）</label>${modelInput('embed-model', ai.embed?.model, models)}
        <label>embedding 用的模型服务</label><select name="embed-credential"><option value="">同上</option>${creds.map((c) => `<option value="${esc(c.id)}" ${c.id === ai.embed?.credential ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        <label>进化评审模型（不填用强模型；建议与实施用的不同）</label>${modelInput('review-model', ai.review?.model, models)}
        <label>评审用的模型服务</label><select name="review-credential"><option value="">同上</option>${creds.map((c) => `<option value="${esc(c.id)}" ${c.id === ai.review?.credential ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      </details>
    </div>
  </div>`;
}

/** 绑定 aiForm 的交互；返回读取表单的函数 */
export function bindAiForm(root, creds) {
  const fields = $('.own-fields', root);
  for (const r of $$('[name=source]', root)) r.onchange = () => { fields.hidden = $('[name=source]:checked', root).value !== 'own'; };
  const sel = $('[name=credential]', root);
  if (sel) {
    sel.onchange = () => {
      const models = creds.find((c) => c.id === sel.value)?.models || [];
      for (const dl of $$('datalist', root)) dl.innerHTML = models.map((m) => `<option value="${esc(m)}">`).join('');
    };
  }
  return () => {
    const v = (n) => $(`[name="${n}"]`, root)?.value?.trim() || '';
    if ($('[name=source]:checked', root)?.value !== 'own') return { source: 'server' };
    return {
      source: 'own', credential: v('credential'),
      models: { default: v('m-default'), fast: v('m-fast'), smart: v('m-smart') },
      concurrency: Number(v('concurrency')) || 2, dailyTokens: Number(v('dailyTokens')) || 0, timeoutMs: Number(v('timeoutMs')) || 150000,
      jsonMode: $('[name=jsonMode]', root).checked, jsonSchema: $('[name=jsonSchema]', root).checked,
      embed: { model: v('embed-model'), credential: v('embed-credential') },
      review: { model: v('review-model'), credential: v('review-credential') },
    };
  };
}

/** 世界的 AI 设置对话框：选择模型来源、查看状态、暂停时重试 */
export async function aiDialog(worldId, { onSaved = null } = {}) {
  let r;
  try { r = await api(`api/worlds/${worldId}/ai`); } catch (e) { toast(`⚠️ ${esc(e.message)}`); return; }
  const u = r.usage || {};
  const d = dialog(`<h2>🧠 AI 设置</h2>
    ${r.halted ? `<div class="banner bad">${esc(r.haltText)}${r.ai.halt?.message ? `<div class="small">${esc(r.ai.halt.message)}</div>` : ''}
      <div class="small">修好模型服务（换密钥、充值、改地址或模型名）后，世界会自动恢复；也可以点「重试」。</div></div>` : ''}
    <div class="small muted">今日用量：站点额度 ${fmtNum(u.server?.total || 0)} · 自己的模型服务 ${fmtNum(u.own?.total || 0)}</div>
    ${r.lane ? `<div class="small muted">通道：进行中 ${r.lane.inflight} / ${r.lane.limit}，排队 ${r.lane.queued}${Object.keys(r.lane.fixes || {}).length ? ` · 模型名已自动纠正：${esc(Object.entries(r.lane.fixes).map(([a, b]) => `${a} → ${b}`).join('，'))}` : ''}</div>` : ''}
    <form id="af">${aiForm(r.ai, r.credentials, { maxConcurrency: r.maxConcurrency, allowed: r.allowed })}
      <div class="bad small" id="af-msg" style="margin-top:8px"></div>
      <div class="actions">${r.halted ? '<button type="button" id="af-retry">重试</button>' : ''}<span style="flex:1"></span><button type="button" id="af-cancel">取消</button><button class="primary" id="af-ok">保存</button></div>
    </form>`);
  d.el.style.width = 'min(560px, 100%)';
  const read = bindAiForm(d.el, r.credentials);
  $('#af-cancel', d.el).onclick = d.close;
  $('#af-retry', d.el)?.addEventListener('click', async () => {
    try {
      const t = await api(`api/worlds/${worldId}/ai/retry`, {});
      toast(t.ok ? '✅ 连接正常，世界已恢复' : `⚠️ 还是不行：${esc(t.error)}`, 8000);
      if (t.ok) { d.close(); onSaved?.(); }
    } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
  });
  $('#af', d.el).onsubmit = async (e) => {
    e.preventDefault();
    $('#af-ok', d.el).disabled = true;
    try {
      const s = await api(`api/worlds/${worldId}/ai`, read(), 'PUT');
      d.close();
      toast(s.retry ? (s.retry.ok ? '✅ 已保存，世界已恢复' : `⚠️ 已保存，但测试没通过：${esc(s.retry.error)}`) : '✅ 已保存，下一次模型调用起生效', 6000);
      onSaved?.();
    } catch (err) { $('#af-msg', d.el).textContent = err.message; $('#af-ok', d.el).disabled = false; }
  };
}

const RATINGS = { cozy: '温馨', adventure: '冒险', epic: '史诗', dark: '黑暗', tragic: '悲剧' };
const STORYTELLERS = { gentle: '温和', voyage: '远航', chaos: '混沌', horror: '恐怖' };

/**
 * 世界设置对话框（世界级设置）：owner 能改的一部分，管理员全部（按世界配置模型服务设计 §9.1）
 * @param {object} w 世界登记项（含 settings）
 * @param {{ admin?: boolean, onSaved?: () => void }} o
 */
export function worldSettingsDialog(w, { admin = false, onSaved = null } = {}) {
  const s = w.settings || {};
  const o = s.overrides || {};
  const d = dialog(`<h2>⚙️ 世界设置 · ${esc(w.title)}</h2>
    <form id="wf">
      <label>标题${w.official && o.title ? ' <span class="small muted">（已覆盖世界包的值）</span>' : ''}</label><input name="title" maxlength="40" value="${esc(w.title)}">
      <label>简介${w.official && o.summary ? ' <span class="small muted">（已覆盖世界包的值）</span>' : ''}</label><textarea name="summary" rows="3" maxlength="300">${esc(w.summary || '')}</textarea>
      ${w.official && (o.title || o.summary) ? '<label class="row"><input type="checkbox" name="reset"> 恢复为世界包里的标题与简介（下次启动时生效）</label>' : ''}
      <label>叙事者</label><select name="storyteller">${Object.entries(STORYTELLERS).map(([k, v]) => `<option value="${k}" ${(s.storyteller || 'voyage') === k ? 'selected' : ''}>${v}（${k}）</option>`).join('')}</select>
      ${admin ? `<label>内容分级</label><select name="rating">${Object.entries(RATINGS).map(([k, v]) => `<option value="${k}" ${(s.rating || w.rating) === k ? 'selected' : ''}>${v}（${k}）</option>`).join('')}</select>
      <label>加载的 Mod（逗号分隔）</label><input name="mods" value="${esc((s.mods || []).join(','))}">` : ''}
      <label>死亡预算（每 3 天最多几名具名角色死亡）</label><input name="deathNamed" type="number" min="0" max="20" value="${Number.isInteger(s.deathNamed) ? s.deathNamed : ''}" placeholder="默认">
      <label class="row"><input type="checkbox" name="migration" ${s.migration !== false ? 'checked' : ''}> 人员流动</label>
      <label class="row"><input type="checkbox" name="evolution" ${w.evolution ? 'checked' : ''}> 自主进化${w.official ? '（官方世界由设置里的 EVOLVE 决定）' : ''}</label>
      <div class="muted small">叙事者、分级、Mod 与进化开关要重新加载世界才生效，保存后会自动重新加载。</div>
      <div class="bad small" id="wf-msg" style="margin-top:8px"></div>
      <div class="actions"><button type="button" id="wf-cancel">取消</button><button class="primary" id="wf-ok">保存</button></div>
    </form>`);
  d.el.style.width = 'min(520px, 100%)';
  $('#wf-cancel', d.el).onclick = d.close;
  $('#wf', d.el).onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = { migration: f.get('migration') === 'on' };
    if (f.get('storyteller') !== (s.storyteller || 'voyage')) body.storyteller = f.get('storyteller'); // 改了才发：叙事者变了要重新加载世界
    if (f.get('title') !== w.title) body.title = f.get('title');
    if (f.get('summary') !== (w.summary || '')) body.summary = f.get('summary');
    if (!w.official) body.evolution = f.get('evolution') === 'on';
    if (f.get('reset') === 'on') body.resetOverrides = ['title', 'summary'];
    if (f.get('deathNamed') !== '') body.deathNamed = Number(f.get('deathNamed'));
    if (admin) {
      if (f.get('rating') !== (s.rating || w.rating)) body.rating = f.get('rating');
      const mods = String(f.get('mods') || '').split(/[,，\s]+/).filter(Boolean);
      if (mods.join(',') !== (s.mods || []).join(',')) body.mods = mods;
    }
    $('#wf-ok', d.el).disabled = true;
    try { await api(`api/worlds/${w.id}/settings`, body, 'PATCH'); d.close(); toast('✅ 已保存'); onSaved?.(); } catch (err) { $('#wf-msg', d.el).textContent = err.message; $('#wf-ok', d.el).disabled = false; }
  };
}
