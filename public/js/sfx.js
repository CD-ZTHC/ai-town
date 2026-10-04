// 战斗与演出的短音效（docs/design/presentation.md §2.2）：全部用 WebAudio 程序生成，不引入素材文件。
// 跟随环境音的开关；同一类音效 60 毫秒内只响一次（一拍里几十个命中不会叠成噪音）；按与镜头的距离衰减。
const last = {};

/** 白噪声缓冲（第一次用时生成） */
function noiseBuf(ctx) {
  if (ctx._noise) return ctx._noise;
  const buf = ctx.createBuffer(1, ctx.sampleRate * 0.6, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return (ctx._noise = buf);
}

function env(ctx, g, t, peak, attack, decay) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

/** 一段滤波噪声：挥动、命中的「嚓」声 */
function burst(ctx, out, t, { type = 'bandpass', freq = 1200, to = null, q = 1, peak = 0.3, attack = 0.005, decay = 0.12 }) {
  const src = ctx.createBufferSource(); src.buffer = noiseBuf(ctx);
  const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(freq, t);
  if (to) f.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
  const g = ctx.createGain(); env(ctx, g, t, peak, attack, decay);
  src.connect(f).connect(g).connect(out);
  src.start(t); src.stop(t + attack + decay + 0.05);
}

/** 一个音：低吼、钟声、护盾的「嗡」 */
function tone(ctx, out, t, { wave = 'sine', freq = 440, to = null, peak = 0.2, attack = 0.01, decay = 0.3 }) {
  const o = ctx.createOscillator(); o.type = wave;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
  const g = ctx.createGain(); env(ctx, g, t, peak, attack, decay);
  o.connect(g).connect(out);
  o.start(t); o.stop(t + attack + decay + 0.05);
}

const SOUNDS = {
  swing: (c, o, t) => burst(c, o, t, { freq: 900, to: 2600, q: 0.8, peak: 0.12, attack: 0.03, decay: 0.12 }),
  hit: (c, o, t) => { burst(c, o, t, { type: 'lowpass', freq: 1800, peak: 0.35, decay: 0.09 }); tone(c, o, t, { wave: 'triangle', freq: 160, to: 70, peak: 0.25, decay: 0.12 }); },
  crit: (c, o, t) => { burst(c, o, t, { type: 'lowpass', freq: 3000, peak: 0.45, decay: 0.14 }); tone(c, o, t, { wave: 'square', freq: 220, to: 60, peak: 0.18, decay: 0.2 }); tone(c, o, t + 0.02, { freq: 1400, to: 900, peak: 0.08, decay: 0.15 }); },
  dodge: (c, o, t) => burst(c, o, t, { type: 'highpass', freq: 2500, to: 600, peak: 0.1, attack: 0.02, decay: 0.15 }),
  shield: (c, o, t) => { tone(c, o, t, { freq: 880, to: 660, peak: 0.08, decay: 0.25 }); tone(c, o, t, { freq: 1320, to: 990, peak: 0.05, decay: 0.2 }); },
  roar: (c, o, t) => { tone(c, o, t, { wave: 'sawtooth', freq: 90, to: 45, peak: 0.25, attack: 0.08, decay: 0.9 }); burst(c, o, t, { type: 'lowpass', freq: 400, peak: 0.2, attack: 0.1, decay: 0.8 }); },
  quake: (c, o, t) => { tone(c, o, t, { wave: 'sine', freq: 50, to: 30, peak: 0.4, attack: 0.05, decay: 1.2 }); burst(c, o, t, { type: 'lowpass', freq: 250, peak: 0.3, attack: 0.05, decay: 1 }); },
  split: (c, o, t) => { burst(c, o, t, { type: 'highpass', freq: 4000, to: 300, peak: 0.35, attack: 0.01, decay: 0.6 }); tone(c, o, t + 0.05, { wave: 'sawtooth', freq: 60, to: 30, peak: 0.3, decay: 1.4 }); tone(c, o, t + 0.3, { freq: 660, peak: 0.1, attack: 0.2, decay: 1.5 }); },
  chime: (c, o, t) => { for (const [i, f] of [523, 659, 784, 1047].entries()) tone(c, o, t + i * 0.09, { freq: f, peak: 0.07, decay: 0.9 }); },
  // 冒险（docs/design/adventure.md §4）：升级的上行音阶、拾取的叮当、危险时的心跳、怪物消散
  levelup: (c, o, t) => { for (const [i, f] of [392, 523, 659, 784, 1047, 1319].entries()) tone(c, o, t + i * 0.07, { wave: i % 2 ? 'triangle' : 'square', freq: f, peak: 0.06, decay: 0.5 }); tone(c, o, t + 0.45, { freq: 1568, peak: 0.05, attack: 0.02, decay: 1.2 }); },
  loot: (c, o, t) => { tone(c, o, t, { wave: 'square', freq: 988, peak: 0.05, decay: 0.08 }); tone(c, o, t + 0.07, { wave: 'square', freq: 1319, peak: 0.05, decay: 0.2 }); },
  heart: (c, o, t) => { tone(c, o, t, { freq: 62, to: 40, peak: 0.35, attack: 0.01, decay: 0.16 }); tone(c, o, t + 0.22, { freq: 58, to: 38, peak: 0.25, attack: 0.01, decay: 0.18 }); },
  poof: (c, o, t) => { burst(c, o, t, { type: 'bandpass', freq: 1600, to: 300, q: 0.7, peak: 0.12, attack: 0.01, decay: 0.3 }); tone(c, o, t, { wave: 'triangle', freq: 700, to: 200, peak: 0.05, decay: 0.25 }); },
};
export const SFX = Object.keys(SOUNDS);

/**
 * 播放一个音效。sound：环境音模块（app.sound，关着时不响）；at：世界坐标（格），cam：镜头（像素）——按距离衰减
 */
export function play(sound, kind, { at = null, cam = null, vol = 1 } = {}) {
  if (!sound?.on || !sound.ctx || !SOUNDS[kind]) return;
  const ctx = sound.ctx;
  const now = ctx.currentTime;
  if (now - (last[kind] || 0) < 0.06) return;
  last[kind] = now;
  let v = vol;
  if (at && cam) {
    const d = Math.hypot(at.x * 32 - cam.x, at.y * 32 - cam.y) / 32; // 格
    v *= Math.max(0, 1 - d / 28);
    if (v <= 0.02) return;
  }
  const g = ctx.createGain(); g.gain.value = v; g.connect(sound.master);
  SOUNDS[kind](ctx, g, now + 0.005);
}
