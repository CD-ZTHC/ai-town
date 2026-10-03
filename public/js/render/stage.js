// 演出的画面元素（docs/design/presentation.md §4.2、§4.7）：电影黑边、名字卡、旁白字幕、全屏闪光，以及 Boss 的大血条。
// 播放的节奏由 stage.js 控制，这里只按 this.stageUI 的状态画（屏幕坐标）。
import { roundRect } from './util.js';

const FONT = '"PingFang SC","Microsoft YaHei",sans-serif';
const now = () => performance.now();

export class StageLayer {
  drawCinema(ctx, S) {
    const ui = (this.stageUI ||= {});
    const W = this.vw, H = this.vh;
    ctx.save();
    ctx.textBaseline = 'middle';
    // 黑边：缓缓推进 / 退出
    this.lbk = (this.lbk || 0) + ((ui.letterbox ? 1 : 0) - (this.lbk || 0)) * 0.12;
    if (this.lbk > 0.01) {
      const h = H * 0.11 * this.lbk;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, h); ctx.fillRect(0, H - h, W, h);
    }
    // 名字卡：从左边滑入，左下三分之一处
    if (ui.card) {
      const c = ui.card, k = (now() - c.born) / c.ms;
      if (k >= 1) ui.card = null;
      else {
        const a = k < 0.12 ? k / 0.12 : k > 0.85 ? (1 - k) / 0.15 : 1;
        const slide = (1 - Math.min(1, k / 0.15)) * -60;
        const x = W * 0.08 + slide, y = H * 0.66;
        ctx.globalAlpha = a;
        ctx.fillStyle = c.color; ctx.fillRect(x - 14, y - 34, 5, 74);
        ctx.textAlign = 'left';
        ctx.font = `900 ${W < 600 ? 26 : 38}px ${FONT}`;
        ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,.75)';
        const name = `${c.emoji ? `${c.emoji} ` : ''}${c.name}`;
        ctx.strokeText(name, x, y - 8); ctx.fillStyle = '#fff'; ctx.fillText(name, x, y - 8);
        if (c.title) {
          ctx.font = `600 ${W < 600 ? 13 : 16}px ${FONT}`;
          ctx.lineWidth = 4; ctx.strokeText(c.title, x + 2, y + 26); ctx.fillStyle = c.color; ctx.fillText(c.title, x + 2, y + 26);
        }
        ctx.globalAlpha = 1;
      }
    }
    // 旁白：底部居中，逐字出现
    if (ui.narr) {
      const n = ui.narr, k = (now() - n.born) / n.ms;
      if (k >= 1) ui.narr = null;
      else {
        const shown = n.text.slice(0, Math.ceil(n.text.length * Math.min(1, k / 0.45)));
        const a = k > 0.88 ? (1 - k) / 0.12 : 1;
        ctx.globalAlpha = a;
        ctx.font = `500 ${W < 600 ? 15 : 19}px ${FONT}`;
        ctx.textAlign = 'center';
        const y = H - Math.max(H * 0.11 * (this.lbk || 0), 90) + (this.lbk > 0.5 ? H * 0.055 : -10);
        const w = Math.min(W - 40, ctx.measureText(n.text).width + 48);
        ctx.fillStyle = 'rgba(10,8,18,.55)'; roundRect(ctx, W / 2 - w / 2, y - 20, w, 40, 12); ctx.fill();
        ctx.fillStyle = '#f4ead2'; ctx.fillText(shown, W / 2, y + 1);
        ctx.globalAlpha = 1;
      }
    }
    // 全屏闪光
    if (ui.flash) {
      const k = (now() - ui.flash.born) / 450;
      if (k >= 1) ui.flash = null;
      else { ctx.globalAlpha = (1 - k) * 0.8; ctx.fillStyle = ui.flash.color; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1; }
    }
    this.drawBossBar(ctx, S);
    ctx.restore();
  }

  /** Boss 的大血条：这张地图上有 Boss 在战斗时，屏幕顶部显示名字、阶段与血量 */
  drawBossBar(ctx, S) {
    let boss = null;
    for (const F of S.fights || []) for (const f of F.fighters) if (f.boss) boss = f;
    if (!boss) { this.bossHp = null; return; }
    const ratio = Math.max(0, Math.min(1, boss.hp / (boss.maxHp || 1)));
    // 掉血时后面那层慢慢追上（看得出一刀砍掉了多少）
    this.bossHp = this.bossHp == null ? ratio : this.bossHp + (ratio - this.bossHp) * 0.04;
    const W = this.vw, w = Math.min(560, W * 0.72), x = W / 2 - w / 2, y = Math.max(100, 30 + (this.lbk || 0) * this.vh * 0.11 + 40);
    ctx.textAlign = 'center';
    ctx.font = `800 15px ${FONT}`;
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.8)';
    const label = `${boss.boss.emoji} ${boss.boss.name}${boss.boss.phases ? `  ${'◆'.repeat(boss.boss.phase)}${'◇'.repeat(Math.max(0, boss.boss.phases - boss.boss.phase))}` : ''}`;
    ctx.strokeText(label, W / 2, y - 12); ctx.fillStyle = '#ffe0e0'; ctx.fillText(label, W / 2, y - 12);
    ctx.fillStyle = 'rgba(10,6,14,.8)'; roundRect(ctx, x - 3, y - 3, w + 6, 16, 6); ctx.fill();
    ctx.fillStyle = 'rgba(255,220,160,.55)'; roundRect(ctx, x, y, w * Math.max(ratio, this.bossHp), 10, 4); ctx.fill();
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, '#b0203a'); g.addColorStop(1, '#ff5a5a');
    ctx.fillStyle = g; roundRect(ctx, x, y, w * ratio, 10, 4); ctx.fill();
  }
}
