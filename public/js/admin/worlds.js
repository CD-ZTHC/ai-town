// 管理面板 · 世界：列表（状态、owner、观众、磁盘占用、模型）、下架 / 恢复、调整单个世界的配额、卸载；
// 任何世界（包括官方世界）的全部世界级设置与 AI 设置；官方世界的公开 / 不公开 / 暂停（world-llm 设计 §9）
import { api, esc, $, $$, toast, fmtBytes } from '../site/api.js';
import { aiDialog, worldSettingsDialog } from '../site/ai-settings.js';

const STATUS = { drafting: '创世中', preview: '预览', failed: '失败', public: '公开', paused: '暂停', unlisted: '不公开', suspended: '已下架', archived: '已归档' };
const PILL = { public: 'good', suspended: 'bad', unlisted: 'warn', failed: 'bad', paused: 'warn' };

async function render(el, ctx) {
  const r = await api('api/admin/worlds');
  el.innerHTML = `<div class="muted small" style="margin-bottom:10px">运行中 ${r.running} / ${r.max}（按磁盘占用排序）</div>
    <div class="card"><table><tr><th>世界</th><th>状态</th><th>创世者</th><th>运行</th><th>模型</th><th>磁盘</th><th>配额</th><th></th></tr>
    ${r.list.map((w) => {
      const pct = w.diskLimitMB ? Math.round((w.diskBytes / (w.diskLimitMB * 1048576)) * 100) : null;
      const parts = Object.entries(w.disk || {}).filter(([k, v]) => k !== 'total' && v > 0).map(([k, v]) => `${k} ${fmtBytes(v)}`).join(' · ');
      return `<tr>
        <td><a href="../w/${esc(w.id)}/" target="_blank">${esc(w.title)}</a>${w.official ? ' <span class="pill good">官方</span>' : ''}<div class="muted small">${esc(w.id)}</div></td>
        <td><span class="pill ${PILL[w.status] || ''}">${STATUS[w.status] || esc(w.status)}</span>${w.statusReason ? `<div class="small muted">${esc(w.statusReason)}</div>` : ''}
          ${w.official && ['public', 'unlisted', 'paused'].includes(w.status) ? `<div><select class="small" data-status="${esc(w.id)}">${['public', 'unlisted', 'paused'].map((k) => `<option value="${k}" ${w.status === k ? 'selected' : ''}>${STATUS[k]}</option>`).join('')}</select></div>` : ''}</td>
        <td>${esc(w.owner || '—')}</td>
        <td class="small">${w.runtime ? `🟢 ${w.runtime.viewers} 人${w.runtime.idle ? ' · 休眠' : ''}${w.runtime.pinned ? ' · 常驻' : ''}` : '—'}</td>
        <td class="small">${w.ai?.source === 'own' ? `${esc(w.ai.credential?.name || '凭据已删除')}<div class="muted">${esc(w.ai.model || '')}</div>` : '<span class="muted">站点</span>'}${w.ai?.halted ? `<div class="bad">⛔ ${esc(w.ai.haltText)}</div>` : ''}</td>
        <td class="small">${fmtBytes(w.diskBytes)}${pct != null ? ` / ${w.diskLimitMB} MB <span class="${pct > 100 ? 'bad' : pct > 80 ? 'warn' : 'muted'}">（${pct}%）</span>` : ''}<div class="muted">${esc(parts)}</div></td>
        <td class="small">${w.official ? '不限' : `磁盘 <input data-disk="${esc(w.id)}" type="number" min="1" style="width:70px" value="${w.quota?.diskMB ?? ''}" placeholder="${w.diskLimitMB}"> MB<br>每日 <input data-tok="${esc(w.id)}" type="number" min="0" style="width:90px" value="${w.quota?.dailyWorldTokens ?? ''}" placeholder="默认"> tokens <button class="small" data-quota="${esc(w.id)}">保存</button>`}</td>
        <td><div class="row" style="gap:4px"><button class="small" data-settings="${esc(w.id)}">设置</button><button class="small" data-ai="${esc(w.id)}">AI</button>
          ${w.runtime && !w.runtime.pinned ? `<button class="small" data-unload="${esc(w.id)}">卸载</button>` : ''}
          ${!w.official && ['public', 'unlisted', 'paused'].includes(w.status) ? `<button class="small danger" data-suspend="${esc(w.id)}">下架</button>` : ''}
          ${!w.official && (w.status === 'suspended' || w.status === 'unlisted') ? `<button class="small" data-restore="${esc(w.id)}">恢复</button>` : ''}</div></td>
      </tr>`;
    }).join('')}</table></div>`;
  const on = (attr, fn) => { for (const b of $$(`[data-${attr}]`, el)) b.onclick = async () => { try { await fn(b.dataset[attr]); ctx.reload(); } catch (e) { toast(`⚠️ ${esc(e.message)}`); } }; };
  on('unload', (id) => api(`api/admin/worlds/${id}/unload`, {}));
  on('quota', (id) => {
    const d = $(`[data-disk="${id}"]`, el).value, t = $(`[data-tok="${id}"]`, el).value;
    return api(`api/admin/worlds/${id}/quota`, { diskMB: d === '' ? null : Number(d), dailyWorldTokens: t === '' ? null : Number(t) }).then(() => toast('✅ 已保存'));
  });
  on('suspend', async (id) => { const reason = prompt('下架原因（owner 可以看到）：'); if (reason) await api(`api/admin/worlds/${id}/suspend`, { reason }); });
  on('restore', (id) => api(`api/admin/worlds/${id}/restore`, {}));
  for (const b of $$('[data-settings]', el)) b.onclick = () => worldSettingsDialog(r.list.find((w) => w.id === b.dataset.settings), { admin: true, onSaved: ctx.reload });
  for (const b of $$('[data-ai]', el)) b.onclick = () => aiDialog(b.dataset.ai, { onSaved: ctx.reload });
  for (const s of $$('[data-status]', el)) {
    s.onchange = async () => {
      try { await api(`api/admin/worlds/${s.dataset.status}/status`, { status: s.value }); toast('✅ 已切换'); } catch (e) { toast(`⚠️ ${esc(e.message)}`); }
      ctx.reload();
    };
  }
}

export const page = { id: 'worlds', title: '🌍 世界', render };
