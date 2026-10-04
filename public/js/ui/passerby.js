// 路人（docs/design/populace.md §9）：点地图上的路人看到他的临时称呼和一句话；登录的旅人可以和他搭话。
// 对话只留在这个弹窗里，不写进任何居民的记忆；次数和旅人聊天共用。
import { app, esc, openModal, toast } from './core.js';

/** 路人的点击 id：p:地点:类别序号:序号 */
export const isPasserby = (id) => typeof id === 'string' && id.startsWith('p:');
const parse = (id) => { const [, loc, g, i] = id.split(':'); return { loc, g: Number(g) || 0, i: Number(i) || 0 }; };

/** 鼠标悬停时的一行说明 */
export function passerbyTip(id) {
  const { loc, g } = parse(id);
  const grp = app.populace?.groups?.[g];
  const place = loc.startsWith('@') ? '路上' : app.world?.locations?.[loc]?.name || '';
  return `<b>${esc(grp?.emoji || '🧑')} ${esc(grp?.name || '路人')}</b> <span style="color:var(--muted)">${esc(place)}</span><br><span style="color:var(--muted)">点一下搭话</span>`;
}

export async function openPasserby(id) {
  const q = parse(id);
  let p;
  try { p = await app.api(`/api/passerby?loc=${encodeURIComponent(q.loc)}&g=${q.g}&i=${q.i}`); } catch (e) { toast(`⚠️ ${esc(e.message)}`); return; }
  const mood = p.mood.fear >= 0.5 ? '提心吊胆' : p.mood.anger >= 0.4 ? '憋着火' : p.mood.joy >= 0.55 ? '很高兴' : '平平常常';
  const history = [];
  let pending = false;
  const card = openModal(`<h2>${esc(p.emoji)} ${esc(p.name)}</h2>
    <div class="sub">${esc(p.locName)} · ${esc(p.groupName)} · 心情${mood}</div>
    <div class="pb-line">「${esc(p.line)}」</div>
    <div class="pb-chat" id="pb-chat"></div>
    ${app.perms.canTry ? `<div class="pform"><input id="pb-text" maxlength="200" placeholder="和这位路人搭句话…"><button class="primary" id="pb-go">说</button><span class="quota" id="pb-msg"></span></div>` : '<div class="sub">登录之后可以和路人搭话。</div>'}
    <div class="sub">路人是这里的普通人，只知道街坊之间流传的事；和他说的话不会被任何居民记住。</div>`, 'passerby');
  const box = card.querySelector('#pb-chat');
  const render = () => {
    box.innerHTML = history.map((h) => `<div class="${h.from === 'user' ? 'me' : ''}">${h.from === 'user' ? '你' : esc(p.name)}：${esc(h.text)}</div>`).join('') + (pending ? `<div class="me">${esc(p.name)}想了想……</div>` : '');
    box.scrollTop = box.scrollHeight;
  };
  const input = card.querySelector('#pb-text');
  const send = async () => {
    const text = input.value.trim();
    if (!text || pending) return;
    input.value = '';
    history.push({ from: 'user', text });
    pending = true;
    render();
    try {
      const r = await app.api('/api/passerby/chat', { ...q, text, history: history.slice(0, -1).slice(-6) });
      history.push({ from: 'npc', text: `${r.emoji ? `${r.emoji} ` : ''}${r.reply}` });
      if (r.remaining) app.perms.remaining = r.remaining;
      card.querySelector('#pb-msg').textContent = r.remaining?.chat != null ? `本小时还能说 ${r.remaining.chat} 句` : '';
    } catch (e) {
      history.pop();
      input.value = text;
      card.querySelector('#pb-msg').textContent = e.message;
    } finally {
      pending = false;
      render();
    }
  };
  card.querySelector('#pb-go')?.addEventListener('click', send);
  input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  input?.focus();
}
