// 管理面板 · 设置（多世界设计 §14.2~§14.7）：按组编辑、来源标记、待重启提示、测试连接、历史与恢复
import { api, esc, $, $$, toast, dialog, fmtTime } from '../site/api.js';

const SOURCE = { env: '由环境变量锁定', panel: '面板设置', default: '默认值' };
const LLM_KEYS = new Set(['BASE_URL', 'API_KEY', 'MODEL', 'LLM_PROVIDER']);

function control(it) {
  const locked = it.source === 'env' || it.bootstrap;
  const dis = locked ? 'disabled' : '';
  const k = esc(it.key);
  if (it.kind === 'bool') return `<label class="row"><input type="checkbox" data-k="${k}" ${it.value ? 'checked' : ''} ${dis} /> <span>${it.value ? '开' : '关'}</span></label>`;
  if (it.kind === 'enum') return `<select data-k="${k}" ${dis}>${it.values.map((v) => `<option value="${esc(v)}" ${v === it.value ? 'selected' : ''}>${esc(v || '（空）')}</option>`).join('')}</select>`;
  if (it.secret) return `<input type="password" data-k="${k}" placeholder="${it.isSet ? esc(it.value) : '未设置'}" autocomplete="new-password" ${dis} />${it.isSet && !locked ? `<label class="row small"><input type="checkbox" data-clear="${k}" /> 清空</label>` : ''}`;
  const v = it.kind === 'list' ? (it.value || []).join(', ') : it.value ?? '';
  const type = it.kind === 'int' || it.kind === 'number' ? 'number' : 'text';
  return `<input type="${type}" ${it.kind === 'number' ? 'step="any"' : ''} data-k="${k}" value="${esc(v)}" ${dis} />`;
}

function readValue(it, root) {
  const el = $(`[data-k="${it.key}"]`, root);
  if (!el) return undefined;
  if (it.secret) {
    if ($(`[data-clear="${it.key}"]`, root)?.checked) return '';
    return el.value ? el.value : undefined;
  }
  if (it.kind === 'bool') return el.checked;
  if (it.kind === 'list') return el.value.split(',').map((s) => s.trim()).filter(Boolean);
  if (it.kind === 'int' || it.kind === 'number') return el.value === '' ? null : Number(el.value);
  return el.value;
}

async function render(el, ctx) {
  const s = await api('api/admin/settings');
  const byGroup = {};
  for (const it of s.items) (byGroup[it.group] ||= []).push(it);
  el.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <span class="muted small">值的来源：环境变量 &gt; 面板设置 &gt; 默认值。启动必需的项（端口、数据目录等）只能用环境变量修改。</span>
      <span style="flex:1"></span>
      <button id="s-history">历史版本</button>
      <button class="primary" id="s-save" disabled>保存</button>
    </div>
    ${Object.entries(byGroup).map(([g, items]) => `
      <div class="card" style="margin-bottom:14px">
        <h2>${esc(s.groups[g] || g)}${g === 'llm' ? ' <button class="small" id="s-test">测试连接</button>' : ''}</h2>
        ${items.map((it) => `
          <div class="setting" data-row="${esc(it.key)}">
            <div>
              <div class="k">${esc(it.label)}<code>${esc(it.key)}</code></div>
              <div class="help">${esc(it.help)}</div>
              <div class="small">
                <span class="pill ${it.source === 'env' ? 'warn' : it.source === 'panel' ? 'good' : ''}">${SOURCE[it.source]}</span>
                ${it.apply === 'restart' ? '<span class="pill">重启后生效</span>' : ''}
                ${it.pending ? '<span class="pill bad">待重启</span>' : ''}
                ${!it.secret && it.source !== 'default' ? `<span class="muted">默认：${esc(Array.isArray(it.default) ? it.default.join(', ') : String(it.default))}</span>` : ''}
              </div>
            </div>
            <div class="v">${control(it)}<div class="err" data-err="${esc(it.key)}"></div>
              ${it.source === 'panel' && !it.bootstrap ? `<button class="small" data-reset="${esc(it.key)}" style="align-self:flex-start">恢复默认</button>` : ''}</div>
          </div>`).join('')}
      </div>`).join('')}`;

  const items = Object.fromEntries(s.items.map((it) => [it.key, it]));
  const changes = () => {
    const out = {};
    for (const it of s.items) {
      if (it.source === 'env' || it.bootstrap) continue;
      const v = readValue(it, el);
      if (v === undefined) continue;
      if (it.secret || JSON.stringify(v) !== JSON.stringify(it.value)) out[it.key] = v;
    }
    return out;
  };
  const mark = () => {
    const c = changes();
    for (const row of $$('[data-row]', el)) row.classList.toggle('changed', Object.hasOwn(c, row.dataset.row));
    $('#s-save', el).disabled = !Object.keys(c).length;
  };
  el.addEventListener('input', mark);
  el.addEventListener('change', mark);

  for (const b of $$('[data-reset]', el)) {
    b.onclick = async () => {
      await api('api/admin/settings', { changes: { [b.dataset.reset]: null } }, 'PUT');
      toast(`已恢复 ${esc(items[b.dataset.reset].label)} 的默认值`);
      ctx.refreshAlerts();
      render(el, ctx);
    };
  }

  $('#s-save', el).onclick = async () => {
    const c = changes();
    for (const e of $$('[data-err]', el)) e.textContent = '';
    try {
      // 先试算影响范围（例如把世界上限调小会卸载哪些世界）
      const dry = await api('api/admin/settings', { changes: c, dryRun: true }, 'PUT');
      if (dry.impact?.length && !confirm(`保存后：\n${dry.impact.join('\n')}\n\n确定保存吗？`)) return;
      // 改了模型相关的设置：先测试连接，成功后才保存
      if (Object.keys(c).some((k) => LLM_KEYS.has(k))) {
        const t = await api('api/admin/settings/test-llm', pickLlm(c));
        if (!t.ok && !confirm(`用新的设置调用模型失败：${t.error}\n\n仍然保存吗？`)) return;
      }
      const r = await api('api/admin/settings', { changes: c }, 'PUT');
      toast(`✅ 已保存为版本 ${r.version}${r.restart.length ? `，${r.restart.length} 项需要重启才能生效` : ''}`);
      ctx.refreshAlerts();
      render(el, ctx);
    } catch (e) {
      for (const [k, msg] of Object.entries(e.data?.errors || {})) { const x = $(`[data-err="${k}"]`, el); if (x) x.textContent = msg; }
      toast(`⚠️ ${esc(e.message)}`);
    }
  };

  const tb = $('#s-test', el);
  if (tb) {
    tb.onclick = async () => {
      tb.disabled = true;
      tb.textContent = '测试中…';
      try {
        const t = await api('api/admin/settings/test-llm', pickLlm(changes()));
        toast(t.ok ? `✅ ${esc(t.model)} 回复了「${esc(t.reply)}」（${t.ms} ms）` : `⚠️ 调用失败：${esc(t.error)}`, 6000);
      } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
      tb.disabled = false;
      tb.textContent = '测试连接';
    };
  }

  $('#s-history', el).onclick = async () => {
    const list = await api('api/admin/settings/history');
    const d = dialog(`<h2>历史版本</h2>${list.length ? `<table><tr><th>版本</th><th>时间</th><th>修改人</th><th>改了哪些</th><th></th></tr>
      ${list.map((v) => `<tr><td>${v.v}${v.current ? ' <span class="pill good">当前</span>' : ''}${v.good ? '' : ' <span class="pill">未验证</span>'}</td><td class="small">${esc(fmtTime(v.at))}</td><td>${esc(v.by)}</td>
        <td class="small">${esc(v.note)} ${(v.changed || []).map((k) => `<code>${esc(k)}</code>`).join(' ')}</td>
        <td>${v.current ? '' : `<button class="small" data-restore="${v.v}">恢复</button>`}</td></tr>`).join('')}</table>` : '<div class="empty">还没有在面板里保存过设置</div>'}
      <div class="actions"><button id="h-close">关闭</button></div>`);
    d.el.style.width = 'min(760px, 100%)';
    $('#h-close', d.el).onclick = d.close;
    for (const b of $$('[data-restore]', d.el)) {
      b.onclick = async () => {
        if (!confirm(`恢复到版本 ${b.dataset.restore}？会生成一个新版本。`)) return;
        await api('api/admin/settings/restore', { version: Number(b.dataset.restore) });
        d.close();
        ctx.refreshAlerts();
        render(el, ctx);
      };
    }
  };
}

function pickLlm(c) {
  const out = {};
  for (const k of LLM_KEYS) if (Object.hasOwn(c, k)) out[k] = c[k];
  return out;
}

export const page = { id: 'settings', title: '⚙️ 设置', render };
