/* ============================================================
 *  共通エンジン: 曲の解析・音・タイトル/リザルト画面・得点まわり
 *  (斬る / 走る / 跳ぶ / 撃つ の4ゲームで共有)
 * ============================================================ */
'use strict';
(function () {
const RG = window.RG = {};
const TAU = RG.TAU = Math.PI * 2;
const clamp = RG.clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const $ = RG.$ = id => document.getElementById(id);
RG.lerp = (a, b, t) => a + (b - a) * t;
RG.rand = (a, b) => a + Math.random() * (b - a);
RG.pick = arr => arr[Math.random() * arr.length | 0];
RG.rng = function (a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
};
const FONT = RG.FONT = '"Segoe UI", "Yu Gothic UI", "Hiragino Sans", Meiryo, sans-serif';

/* ------------------------------------------------------------
 *  1. 曲の解析
 * ------------------------------------------------------------ */
const FFT_N = 1024, HOP = 512, BAND_HZ = [200, 800, 3200];
const T = (() => {
  const n = FFT_N, rev = new Uint16Array(n), cos = new Float32Array(n / 2), sin = new Float32Array(n / 2), win = new Float32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(TAU * i / n); sin[i] = Math.sin(TAU * i / n); }
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(TAU * i / (n - 1));
  return { rev, cos, sin, win };
})();
function fft(re, im) {
  const n = FFT_N, { rev, cos, sin } = T;
  for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { const t = re[i]; re[i] = re[j]; re[j] = t; } }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) for (let j = 0, k = 0; j < half; j++, k += step) {
      const a = i + j, b = a + half;
      const tr = re[b] * cos[k] + im[b] * sin[k], ti = im[b] * cos[k] - re[b] * sin[k];
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}

// 音の立ち上がり(flux)・帯域ごとの強さ・曲の盛り上がり(env) を求める
RG.analyze = async function (buffer, onProgress) {
  const sr = buffer.sampleRate, len = buffer.length, mono = new Float32Array(len);
  for (let c = 0; c < buffer.numberOfChannels; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < len; i++) mono[i] += d[i]; }
  const frames = Math.floor((len - FFT_N) / HOP) + 1;
  if (frames < 10) throw new Error('曲が短すぎます');
  const half = FFT_N / 2, binBand = new Uint8Array(half);
  for (let k = 0; k < half; k++) { const hz = k * sr / FFT_N; binBand[k] = hz < BAND_HZ[0] ? 0 : hz < BAND_HZ[1] ? 1 : hz < BAND_HZ[2] ? 2 : 3; }
  const flux = new Float32Array(frames), raw = new Float32Array(frames), bands = [0, 1, 2, 3].map(() => new Float32Array(frames));
  const prev = new Float32Array(half), re = new Float32Array(FFT_N), im = new Float32Array(FFT_N);
  let last = performance.now();
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FFT_N; i++) { re[i] = mono[off + i] * T.win[i]; im[i] = 0; }
    fft(re, im);
    let sum = 0, e = 0;
    for (let k = 1; k < half; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]), mag = Math.log1p(50 * m), d = mag - prev[k];
      e += mag;
      if (d > 0) { sum += d; bands[binBand[k]][f] += d; }
      prev[k] = mag;
    }
    flux[f] = sum; raw[f] = e;
    if ((f & 255) === 0 && performance.now() - last > 30) {
      onProgress && onProgress(f / frames);
      await new Promise(r => setTimeout(r));
      last = performance.now();
    }
  }
  flux[0] = 0; bands.forEach(b => b[0] = 0);
  const dt = HOP / sr;
  // 盛り上がり: 約2.4秒の移動平均を 0〜1 に正規化
  const ps = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) ps[i + 1] = ps[i] + raw[i];
  const W = Math.max(2, Math.round(1.2 / dt)), env = new Float32Array(frames);
  for (let i = 0; i < frames; i++) { const lo = Math.max(0, i - W), hi = Math.min(frames, i + W + 1); env[i] = (ps[hi] - ps[lo]) / (hi - lo); }
  const sorted = Array.from(env).sort((a, b) => a - b), p10 = sorted[Math.floor(frames * 0.1)], p95 = sorted[Math.floor(frames * 0.95)] || 1;
  for (let i = 0; i < frames; i++) env[i] = clamp((env[i] - p10) / Math.max(1e-6, p95 - p10), 0, 1);
  let seed = frames;
  for (let i = 0; i < frames; i += 97) seed = (seed * 31 + Math.round(flux[i] * 10)) | 0;
  onProgress && onProgress(1);
  return { flux, bands, env, frames, dt, sr, duration: buffer.duration, seed };
};
RG.intensity = (feat, t) => feat.env[clamp(Math.round(t / feat.dt), 0, feat.frames - 1)];

// 音の立ち上がりを拾って「ノーツ」にする。P = { mult: しきい値, gap: 最小間隔(秒) }
RG.onsets = function (feat, P) {
  const { flux, bands, frames, dt } = feat;
  const ps = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) ps[i + 1] = ps[i] + flux[i];
  const gm = ps[frames] / frames, W = Math.max(4, Math.round(0.5 / dt)), cands = [];
  for (let n = 2; n < frames - 2; n++) {
    const v = flux[n];
    if (v < flux[n - 1] || v <= flux[n + 1] || v < flux[n - 2] || v < flux[n + 2]) continue;
    const lo = Math.max(0, n - W), hi = Math.min(frames, n + W + 1), lm = (ps[hi] - ps[lo]) / (hi - lo);
    if (v > lm * P.mult + gm * 0.15) cands.push({ n, s: v - lm });
  }
  cands.sort((a, b) => b.s - a.s);
  const g = Math.max(1, Math.round(P.gap / dt)), taken = new Uint8Array(frames), picked = [];
  for (const c of cands) {
    if (taken[c.n]) continue;
    c.pct = picked.length; picked.push(c);
    taken.fill(1, Math.max(0, c.n - g + 1), Math.min(frames, c.n + g));
  }
  picked.sort((a, b) => a.n - b.n);
  const bandMean = bands.map(b => { let s = 0; for (let i = 0; i < frames; i++) s += b[i]; return s / frames || 1e-9; });
  const use = [1, 1, 1, 1], notes = [];
  for (let i = 0; i < picked.length; i++) {
    const c = picked[i], useSum = use[0] + use[1] + use[2] + use[3];
    let type = 0, best = -1;
    for (let b = 0; b < 4; b++) {
      const sc = (bands[b][c.n - 1] + bands[b][c.n] + bands[b][c.n + 1]) / bandMean[b] / (0.4 + 2.4 * use[b] / useSum);
      if (sc > best) { best = sc; type = b; }
    }
    for (let b = 0; b < 4; b++) use[b] *= 0.85;
    use[type] += 1;
    const t = (c.n * HOP + FFT_N / 2) / feat.sr + 0.002;
    const gap = i ? (c.n - picked[i - 1].n) * dt : 10, next = i + 1 < picked.length ? (picked[i + 1].n - c.n) * dt : 10;
    const strong = c.pct / picked.length;                 // 0 に近いほど強い音
    notes.push({ t, type, strong, gap, next, big: (strong < 0.07 && gap >= 0.5 && next >= 0.5) || i === picked.length - 1, done: false });
  }
  return notes;
};

// 曲のテンポと拍の位置を求める。戻り値 { period: 1拍の秒数, bpm, beats: [拍の時刻] }
RG.beats = function (feat) {
  if (feat.beatInfo) return feat.beatInfo;
  const { flux, frames, dt } = feat, T0 = FFT_N / 2 / feat.sr + 0.002;
  const ps = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) ps[i + 1] = ps[i] + flux[i];
  const W = Math.max(4, Math.round(0.5 / dt)), o = new Float32Array(frames);
  let avg = 0;
  for (let i = 0; i < frames; i++) { const lo = Math.max(0, i - W), hi = Math.min(frames, i + W + 1); o[i] = Math.max(0, flux[i] - (ps[hi] - ps[lo]) / (hi - lo)); avg += o[i]; }
  avg /= frames;
  // 1) おおよそのテンポ: 自己相関 (120BPM 付近を少し優先)
  const ac = lag => { let s = 0; if (lag >= frames) return 0; for (let i = 0; i + lag < frames; i += 2) s += o[i] * o[i + lag]; return s / (frames - lag); };
  let bestLag = Math.round(0.5 / dt), bestV = -1;
  for (let lag = Math.round(0.3 / dt); lag <= Math.round(1.0 / dt); lag++) {
    const w = Math.exp(-0.5 * Math.pow(Math.log2(lag * dt / 0.5) / 0.7, 2)), v = (ac(lag) + 0.5 * ac(lag * 2)) * w;
    if (v > bestV) { bestV = v; bestLag = lag; }
  }
  // 2) 曲全体でずれないよう、周期を細かく探し直す
  const NB = 40, acc = new Float32Array(NB);
  const comb = p => {
    acc.fill(0);
    for (let i = 0; i < frames; i++) acc[Math.min(NB - 1, ((i * dt) % p) / p * NB | 0)] += o[i];
    let m = -1, mi = 0;
    for (let b = 0; b < NB; b++) { const v = acc[b] + 0.5 * (acc[(b + 1) % NB] + acc[(b + NB - 1) % NB]); if (v > m) { m = v; mi = b; } }
    return [m, mi];
  };
  const p0 = bestLag * dt; let best = [-1, 0], bp = p0;
  for (let p = p0 * 0.96; p <= p0 * 1.04; p += p0 * 0.0004) { const r = comb(p); if (r[0] > best[0]) { best = r; bp = p; } }
  const c0 = bp;
  for (let p = c0 - p0 * 0.0005; p <= c0 + p0 * 0.0005; p += p0 * 0.00002) { const r = comb(p); if (r[0] > best[0]) { best = r; bp = p; } }
  // 3) 拍の頭の位置
  const at = x => { const i = Math.floor(x); return i < 0 || i + 1 >= frames ? 0 : o[i] + (o[i + 1] - o[i]) * (x - i); };
  const sumAt = (ph, p, arr) => { let s = 0; for (let t = ph; t < frames * dt; t += p) s += arr ? arr[clamp(Math.round(t / dt), 0, frames - 1)] : at(t / dt); return s; };
  let phi = (best[1] + 0.5) / NB * bp, bs = -1, bd = 0;
  for (let d = -bp / NB; d <= bp / NB; d += 0.002) { const s = sumAt(phi + d + bp, bp); if (s > bs) { bs = s; bd = d; } }
  phi += bd;
  let p = bp;
  while (p < 0.36) {                                   // 速すぎる → 2拍をまとめる (低音が鳴る方を拍の頭に)
    const a = sumAt(phi + p * 2, p * 2, feat.bands[0]), b = sumAt(phi + p + p * 2, p * 2, feat.bands[0]);
    if (b > a) phi += p; p *= 2;
  }
  while (p > 0.75) p /= 2;
  // 裏拍(ハイハットなど)を拍の頭と取り違えないよう、低音がはっきり強い方を選ぶ
  if (sumAt(phi + p / 2 + p, p, feat.bands[0]) > sumAt(phi + p, p, feat.bands[0]) * 1.3) phi += p / 2;
  phi = ((phi % p) + p) % p;
  // 4) 少しずつ音に寄せながら拍を並べる (テンポの揺れに追従)
  const beats = [];
  for (let t = phi; t < frames * dt;) {
    beats.push(t + T0);
    let pred = t + p, mi = -1, mv = avg * 2.5;
    for (let i = Math.max(0, Math.round((pred - 0.04) / dt)); i <= Math.min(frames - 1, Math.round((pred + 0.04) / dt)); i++) if (o[i] > mv) { mv = o[i]; mi = i; }
    if (mi >= 0) pred += 0.15 * (mi * dt - pred);
    t = pred;
  }
  return feat.beatInfo = { period: p, bpm: 60 / p, beats };
};

// 画面上を流れるようにつながる位置 (u, v: 0〜1) を各ノーツに割り当てる
RG.flow = function (notes, seed, P, aspect) {
  const rng = RG.rng(seed);
  let u = 0.5, v = 0.5, ang = rng() * TAU, prevType = -1;
  for (const n of notes) {
    if (n.gap > 1.6) { u = 0.1 + 0.8 * rng(); v = 0.1 + 0.8 * rng(); ang = rng() * TAU; }
    else {
      const d = Math.min(P.max, P.base + n.gap * P.per);
      ang += (rng() - 0.5) * 1.1 + (n.type !== prevType ? (rng() < 0.5 ? -1 : 1) * (0.5 + rng() * 0.9) : 0);
      for (let k = 0; k < 6; k++) {
        const nu = u + Math.cos(ang) * d, nv = v + Math.sin(ang) * d * aspect;
        if (nu < 0.03 || nu > 0.97) { ang = Math.PI - ang; continue; }
        if (nv < 0.03 || nv > 0.97) { ang = -ang; continue; }
        u = nu; v = nv; break;
      }
    }
    n.u = clamp(u, 0.03, 0.97); n.v = clamp(v, 0.03, 0.97); n.r1 = rng(); n.r2 = rng();
    prevType = n.type;
  }
  return notes;
};

/* ------------------------------------------------------------
 *  2. 音
 * ------------------------------------------------------------ */
const A = RG.audio = {
  ctx: null, analyser: null, spec: null, noise: null, bass: 0, level: 0, vol: 0.4,
  ensure() {
    if (!A.ctx) {
      A.ctx = new (window.AudioContext || window.webkitAudioContext)();
      A.analyser = A.ctx.createAnalyser(); A.analyser.fftSize = 256; A.analyser.smoothingTimeConstant = 0.75;
      A.analyser.connect(A.ctx.destination);
      A.spec = new Uint8Array(A.analyser.frequencyBinCount);
      A.noise = A.ctx.createBuffer(1, A.ctx.sampleRate, A.ctx.sampleRate);
      const d = A.noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return A.ctx;
  },
  update() {
    if (!A.analyser) return;
    A.analyser.getByteFrequencyData(A.spec);
    let b = 0, l = 0;
    for (let i = 1; i < 7; i++) b += A.spec[i];
    for (let i = 1; i < 60; i++) l += A.spec[i];
    A.bass += (b / 6 / 255 - A.bass) * 0.3; A.level += (l / 59 / 255 - A.level) * 0.3;
  },
  on() { return A.ctx && A.ctx.state === 'running' && A.vol > 0; },
};
const PENTA = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2, 9 / 4, 5 / 2];
RG.sfx = {
  tone(f, dur = 0.25, v = 0.15, type = 'triangle', to = 0, delay = 0) {
    if (!A.on()) return;
    const t = A.ctx.currentTime + delay, o = A.ctx.createOscillator(), g = A.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v * A.vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g); g.connect(A.ctx.destination); o.start(t); o.stop(t + dur + 0.02);
  },
  noise(f = 800, dur = 0.3, v = 0.4, type = 'lowpass', slide = 0.3) {
    if (!A.on()) return;
    const t = A.ctx.currentTime, src = A.ctx.createBufferSource(), fl = A.ctx.createBiquadFilter(), g = A.ctx.createGain();
    src.buffer = A.noise; fl.type = type;
    fl.frequency.setValueAtTime(f, t); fl.frequency.exponentialRampToValueAtTime(Math.max(40, f * slide), t + dur);
    g.gain.setValueAtTime(v * A.vol, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(fl); fl.connect(g); g.connect(A.ctx.destination);
    src.start(t, Math.random() * 0.5, dur + 0.05);
  },
  chime(combo, strong = true) {          // 続けるほど音階を駆け上がる
    const f = 659.25 * PENTA[(Math.max(1, combo) - 1) % 8] * (strong ? 1 : 0.5);
    RG.sfx.tone(f, 0.3, strong ? 0.2 : 0.11);
    if (strong) RG.sfx.tone(f * 2, 0.2, 0.08, 'sine');
  },
  rise(level = 2) { [1, 5 / 4, 3 / 2].forEach((r, i) => RG.sfx.tone(523.25 * r * (1 + (level - 2) * 0.25), 0.35, 0.2, 'triangle', 0, i * 0.07)); },
  cheer(amount = 1) {
    if (!A.on()) return;
    const t = A.ctx.currentTime, src = A.ctx.createBufferSource(), f = A.ctx.createBiquadFilter(), g = A.ctx.createGain();
    src.buffer = A.noise; src.loop = true; f.type = 'bandpass'; f.Q.value = 0.8;
    f.frequency.setValueAtTime(700, t); f.frequency.linearRampToValueAtTime(1500, t + 0.5); f.frequency.linearRampToValueAtTime(900, t + 2.2);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(A.vol * 0.42 * amount, t + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 2.4);
    src.connect(f); f.connect(g); g.connect(A.ctx.destination); src.start(t); src.stop(t + 2.5);
  },
};

/* ------------------------------------------------------------
 *  3. 火花と浮かぶ文字
 * ------------------------------------------------------------ */
RG.Fx = function () { this.p = []; this.t = []; this.shake = 0; this.flash = 0; this.flashColor = '255,255,255'; };
RG.Fx.prototype = {
  add(x, y, vx, vy, o) {
    if (this.p.length > 2600) return;
    this.p.push({ x, y, vx, vy, age: 0, life: o.life || 0.6, c: o.c || '#fff', s: o.s || 2, g: o.g || 0, d: o.d ?? 0.96, a: o.a ?? 1 });
  },
  burst(x, y, n, o = {}) {
    for (let i = 0; i < n; i++) {
      const a = o.ang !== undefined ? o.ang + (Math.random() - 0.5) * (o.spread || 1) : Math.random() * TAU, sp = RG.rand(o.v0 || 80, o.v1 || 340);
      this.add(x, y, Math.cos(a) * sp, Math.sin(a) * sp, { life: RG.rand(o.l0 || 0.3, o.l1 || 0.8), c: o.colors ? RG.pick(o.colors) : o.c, s: o.s, g: o.g, d: o.d, a: o.a });
    }
  },
  text(x, y, s, color = '#fff', size = 18) { this.t.push({ x, y, s, color, size, t0: performance.now() }); },
  clear() { this.p.length = 0; this.t.length = 0; this.shake = 0; this.flash = 0; },
  step(dt) {
    const d60 = dt * 60; let j = 0;
    for (let i = 0; i < this.p.length; i++) {
      const p = this.p[i]; p.age += dt;
      if (p.age >= p.life) continue;
      const d = Math.pow(p.d, d60);
      p.vx *= d; p.vy = p.vy * d + p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      this.p[j++] = p;
    }
    this.p.length = j;
    this.shake *= Math.pow(0.85, d60); if (this.shake < 0.2) this.shake = 0;
    this.flash *= Math.pow(0.82, d60); if (this.flash < 0.01) this.flash = 0;
  },
  draw(c) {
    c.save(); c.globalCompositeOperation = 'lighter'; c.lineCap = 'round';
    for (const p of this.p) {
      const f = p.age / p.life;
      c.globalAlpha = (1 - f) * p.a; c.strokeStyle = p.c; c.lineWidth = p.s * (1 - f * 0.5);
      c.beginPath(); c.moveTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035); c.lineTo(p.x, p.y); c.stroke();
    }
    c.restore();
  },
  drawTexts(c) {
    const now = performance.now();
    c.save(); c.textAlign = 'center'; c.textBaseline = 'alphabetic'; c.shadowColor = 'rgba(0,0,0,.75)'; c.shadowBlur = 6;
    for (let i = this.t.length - 1; i >= 0; i--) {
      const t = this.t[i], p = (now - t.t0) / 700;
      if (p >= 1) { this.t.splice(i, 1); continue; }
      c.globalAlpha = 1 - p * p; c.fillStyle = t.color;
      c.font = `800 ${Math.round(t.size * (1 + (1 - Math.min(1, p * 6)) * 0.35))}px ${FONT}`;
      c.fillText(t.s, t.x, t.y - p * 30);
    }
    c.restore();
  },
  drawFlash(c, W, H) { if (this.flash > 0) { c.fillStyle = `rgba(${this.flashColor},${Math.min(0.6, this.flash)})`; c.fillRect(0, 0, W, H); } },
};

/* ------------------------------------------------------------
 *  4. 得点・連続・倍率・フィーバー と、その表示
 * ------------------------------------------------------------ */
const MULT_AT = [0, 10, 25, 50], MULT_COLOR = ['#9fa4cf', '#9ff0c8', '#ffd98a', '#ff8fb0'];
RG.Juice = function (api, o) {
  this.api = api; this.o = Object.assign({ combo: 'COMBO', fever: 'FEVER', feverDesc: '得点2倍', feverLen: 8, lead: '' }, o);
  this.score = 0; this.shown = 0; this.combo = 0; this.maxCombo = 0; this.mult = 1; this.gauge = 0;
  this.feverOn = false; this.feverEnd = 0; this.fevers = 0; this.acc = 0; this.judged = 0; this.misses = 0;
  this.banner = null; this.pScore = 0; this.pCombo = 0; this.pMult = 0;
};
RG.Juice.prototype = {
  say(text, color = '#fff', size = 1) { this.banner = { text, color, size, t0: performance.now() }; },
  // w: 出来ばえ 0〜1。戻り値は入った得点
  hit(w, opt = {}) {
    const now = performance.now();
    this.combo++; if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    this.pCombo = now; this.acc += w; this.judged++;
    const m = this.combo >= 50 ? 4 : this.combo >= 25 ? 3 : this.combo >= 10 ? 2 : 1;
    if (m > this.mult) {
      this.mult = m; this.pMult = now;
      this.say('×' + m + '!', MULT_COLOR[m - 1]); RG.sfx.rise(m);
      if (m === 4) RG.sfx.cheer(0.6);
      this.o.onMult && this.o.onMult(m);
    }
    const gain = Math.round((opt.base || 1000) * w * (opt.mul || 1) * this.mult * (this.feverOn ? 2 : 1));
    this.score += gain; this.pScore = now;
    if (!this.feverOn) {
      this.gauge += opt.gauge ?? (0.018 + 0.032 * w);
      if (this.gauge >= 1) this.startFever();
    }
    return gain;
  },
  add(points) { const g = Math.round(points * this.mult * (this.feverOn ? 2 : 1)); this.score += g; this.pScore = performance.now(); return g; },
  miss(count = true) {
    this.combo = 0; this.mult = 1; this.misses++;
    if (count) this.judged++;
    if (!this.feverOn) this.gauge = Math.max(0, this.gauge - 0.07);
  },
  startFever() {
    this.feverOn = true; this.gauge = 1; this.fevers++; this.feverEnd = this.api.time() + this.o.feverLen;
    this.say(this.o.fever, '#fff3c4', 1.4); RG.sfx.cheer(1);
    this.o.onFever && this.o.onFever();
  },
  update() {
    if (this.feverOn) {
      this.gauge = (this.feverEnd - this.api.time()) / this.o.feverLen;
      if (this.gauge <= 0) { this.gauge = 0; this.feverOn = false; this.o.onFeverEnd && this.o.onFeverEnd(); }
    }
    this.shown += (this.score - this.shown) * 0.22;
    if (this.score - this.shown < 1) this.shown = this.score;
  },
  pct() { return this.judged ? this.acc / this.judged * 100 : 0; },
  draw(c) {
    const api = this.api, { W, H } = api, now = performance.now(), t = api.time();
    const punch = (t0, ms) => Math.max(0, 1 - (now - t0) / ms);
    c.save(); c.textBaseline = 'alphabetic';
    const sp = punch(this.pScore, 160);
    c.textAlign = 'left'; c.fillStyle = sp > 0 ? '#fff3cf' : '#f1f0ff'; c.font = `800 ${Math.round(26 + sp * 7)}px ${FONT}`;
    const txt = Math.round(this.shown).toLocaleString();
    c.fillText(txt, 18, 42);
    const sw = c.measureText(txt).width, mp = punch(this.pMult, 500);
    c.fillStyle = this.feverOn ? `hsl(${(now * 0.5) % 360} 100% 75%)` : MULT_COLOR[this.mult - 1];
    c.font = `800 ${Math.round(22 + mp * 22)}px ${FONT}`;
    if (mp > 0 || this.feverOn) { c.shadowColor = c.fillStyle; c.shadowBlur = 16; }
    c.fillText('×' + this.mult * (this.feverOn ? 2 : 1), 30 + sw, 42); c.shadowBlur = 0;
    if (this.o.sub) { c.font = `13px ${FONT}`; c.fillStyle = '#9fa4cf'; c.fillText(this.o.sub(), 18, 64); }
    if (this.combo >= 2) {
      const cp = punch(this.pCombo, 140);
      c.textAlign = 'center';
      c.fillStyle = this.mult === 1 ? '#f1f0ff' : MULT_COLOR[this.mult - 1];
      c.font = `800 italic ${Math.round(40 + cp * 14)}px ${FONT}`; c.fillText(this.combo, W / 2, 52);
      c.fillStyle = '#9fa4cf'; c.font = `600 11px ${FONT}`; c.fillText(this.o.combo, W / 2, 70);
      if (this.mult < 4) {
        const a = MULT_AT[this.mult - 1], b = MULT_AT[this.mult];
        c.fillStyle = 'rgba(160,175,255,.18)'; c.fillRect(W / 2 - 40, 77, 80, 3);
        c.fillStyle = MULT_COLOR[this.mult]; c.fillRect(W / 2 - 40, 77, 80 * (this.combo - a) / (b - a), 3);
      }
    }
    // フィーバーゲージ
    const gw = Math.min(460, W * 0.62), gx = (W - gw) / 2, gy = H - 22, v = clamp(this.gauge, 0, 1);
    c.fillStyle = 'rgba(160,175,255,.16)'; c.fillRect(gx, gy, gw, 8);
    const gg = c.createLinearGradient(gx, 0, gx + gw, 0);
    if (this.feverOn) for (let i = 0; i <= 4; i++) gg.addColorStop(i / 4, `hsl(${(now * 0.3 + i * 70) % 360} 100% 68%)`);
    else { const cs = getComputedStyle(document.documentElement); gg.addColorStop(0, cs.getPropertyValue('--a1')); gg.addColorStop(1, cs.getPropertyValue('--a3')); }
    c.fillStyle = gg;
    if (this.feverOn || v > 0.8) { c.shadowColor = '#fff'; c.shadowBlur = 12; }
    c.fillRect(gx, gy, gw * v, 8); c.shadowBlur = 0;
    c.textAlign = 'center'; c.font = `700 12px ${FONT}`; c.fillStyle = this.feverOn ? '#fff3c4' : '#9fa4cf';
    c.fillText(this.feverOn ? `${this.o.fever} ― ${this.o.feverDesc}` : this.o.fever + ' ゲージ', W / 2, gy - 7);
    // 進行
    c.fillStyle = 'rgba(160,175,255,.15)'; c.fillRect(0, 0, W, 3);
    c.fillStyle = '#fff'; c.fillRect(0, 0, W * clamp(t / api.duration, 0, 1), 3);
    // 開始前
    if (t < 0) {
      c.globalAlpha = clamp((t + api.lead) / 0.5, 0, 1) * clamp(-t / 0.4, 0, 1);
      c.fillStyle = '#f1f0ff'; c.font = `700 ${Math.round(clamp(W / 26, 20, 34))}px ${FONT}`;
      c.fillText('♪ ' + api.song.name, W / 2, H * 0.34, W * 0.86);
      c.fillStyle = '#9fa4cf'; c.font = `15px ${FONT}`; c.fillText(this.o.lead, W / 2, H * 0.34 + 32);
      c.globalAlpha = 1;
    }
    if (this.banner) {
      const p = (now - this.banner.t0) / 1100;
      if (p >= 1) this.banner = null;
      else {
        const sc = 1 + (1 - Math.min(1, p * 7)) * 0.9;
        c.globalAlpha = Math.min(1, p * 12) * (1 - Math.pow(p, 3));
        c.fillStyle = this.banner.color; c.font = `800 italic ${Math.round(clamp(W / 13, 34, 76) * this.banner.size * sc)}px ${FONT}`;
        c.shadowColor = this.banner.color; c.shadowBlur = 30; c.textBaseline = 'middle';
        c.fillText(this.banner.text, W / 2, H * 0.4);
      }
    }
    c.restore();
  },
};

/* ------------------------------------------------------------
 *  5. 曲の保存 (一度選んだ曲をほかのゲームでも使えるように)
 * ------------------------------------------------------------ */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('rg-songs', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('s');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
RG.saveSong = async (name, data) => { try { (await idb()).transaction('s', 'readwrite').objectStore('s').put({ name, data }, 'last'); } catch (e) {} };
RG.loadSong = async () => {
  try {
    const db = await idb();
    return await new Promise(res => { const q = db.transaction('s').objectStore('s').get('last'); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
  } catch (e) { return null; }
};

/* ------------------------------------------------------------
 *  6. 画面の骨組み (タイトル・ポーズ・リザルト・毎フレームの呼び出し)
 * ------------------------------------------------------------ */
const RANKS = [[95, 'S', '#ffe08a'], [88, 'A', '#ffb38a'], [75, 'B', '#9ff0c8'], [60, 'C', '#9cc4ff'], [-1e9, 'D', '#b0b4cc']];
RG.shell = function (cfg) {
  const root = document.documentElement.style;
  cfg.colors.forEach((c, i) => root.setProperty('--a' + (i + 1), c));
  const opts = (cfg.options || []).map(o => `<div class="row"><label for="o_${o.key}">${o.label}</label>
      <input type="range" id="o_${o.key}" min="${o.min}" max="${o.max}" step="${o.step || 1}"><span class="val" id="o_${o.key}V"></span></div>`).join('');
  document.body.insertAdjacentHTML('beforeend', `
<canvas id="cv"></canvas>
<button id="pauseBtn" title="ポーズ (Esc)">Ⅱ</button>
<div class="screen on" id="scTitle"><div class="card">
  <a class="back" href="index.html">← ゲーム一覧</a>
  <div class="brand"><h1>${cfg.title}</h1><small>${cfg.sub}</small></div>
  <p class="lead">${cfg.lead}</p>
  <div id="drop"><strong>🎵 曲を選ぶ / ここにドロップ</strong>mp3・wav・ogg・m4a・flac など
    <div id="fileName"></div><div class="bar" id="bar"><i></i></div></div>
  <input type="file" id="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac,.aac" hidden>
  <div class="err" id="err"></div>
  <div class="row"><span>難易度</span><div class="seg" id="diff">
    <button data-v="easy">かんたん</button><button data-v="normal">ふつう</button><button data-v="hard">むずかしい</button></div></div>
  ${opts}
  <div class="row"><label for="offset">タイミング</label><input type="range" id="offset" min="-200" max="200" step="5"><span class="val" id="offsetV"></span></div>
  <div class="row"><label for="sfx">効果音</label><input type="range" id="sfx" min="0" max="100" step="5"><span class="val" id="sfxV"></span></div>
  <div class="row"><label for="auto">お手本</label><input type="checkbox" id="auto"><span style="color:var(--sub);font-size:13px">自動プレイを眺める</span></div>
  <button class="btn primary" id="start" disabled>曲を選んでください</button>
  <div class="how">${cfg.how.map(h => `<div><b>${h[0]}</b>${h[1]}</div>`).join('')}</div>
  <div class="hint">${cfg.hint || ''} <kbd>Esc</kbd> でポーズ。曲はこの端末の中だけで処理され、どこにも送信されません。</div>
</div></div>
<div class="screen dim" id="scPause"><div class="card">
  <h2>ポーズ中</h2>
  <button class="btn primary" id="resume">続ける</button>
  <button class="btn" id="retryP">最初からやり直す</button>
  <button class="btn" id="quitP">曲選択に戻る</button>
</div></div>
<div class="screen dim" id="scResult"><div class="card">
  <div class="resHead"><div id="rank">S</div><div><div id="rankName"></div><div id="resSong"></div><div id="best"></div></div></div>
  <div id="rScore"></div>
  <div class="stats" id="stats"></div>
  <div class="btns"><button class="btn primary" id="retryR" style="margin-top:14px">もう一度</button>
    <button class="btn" id="quitR" style="margin-top:14px">曲選択へ</button></div>
</div></div>`);

  const cv = $('cv'), c = cv.getContext('2d');
  const api = { cfg, cv, c, state: 'title', W: 800, H: 600, S: 1, dpr: 1, song: null, lead: cfg.leadIn || 2.6, duration: 0, startAt: 0,
    diff: 'normal', auto: false, pointer: { x: -999, y: -999, down: false, touch: false }, keys: {} };
  const skey = 'rg_' + cfg.id;
  const settings = api.settings = Object.assign({ diff: 'normal', offset: 0, sfx: 40, auto: false }, cfg.defaults || {}, JSON.parse(localStorage.getItem(skey) || '{}'));
  const save = () => localStorage.setItem(skey, JSON.stringify(settings));

  function resize() {
    api.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    api.W = window.innerWidth || 800; api.H = window.innerHeight || 600;
    api.S = clamp(Math.min(api.W, api.H) / 720, 0.5, 1.5);
    cv.width = Math.round(api.W * api.dpr); cv.height = Math.round(api.H * api.dpr);
    c.setTransform(api.dpr, 0, 0, api.dpr, 0, 0);
    cfg.resize && cfg.resize(api);
  }
  window.addEventListener('resize', resize);

  const screens = ['scTitle', 'scPause', 'scResult'];
  function show(id) {
    screens.forEach(s => $(s).classList.toggle('on', s === id));
    $('pauseBtn').style.display = id === null ? 'block' : 'none';
    cv.classList.toggle('playing', id === null && !!cfg.hideCursor);
  }

  /* ---- 設定 ---- */
  function sync() {
    document.querySelectorAll('#diff button').forEach(b => b.classList.toggle('sel', b.dataset.v === settings.diff));
    $('offset').value = settings.offset; $('offsetV').textContent = (settings.offset > 0 ? '+' : '') + settings.offset + ' ms';
    $('sfx').value = settings.sfx; $('sfxV').textContent = settings.sfx + ' %';
    $('auto').checked = settings.auto; A.vol = settings.sfx / 100;
    (cfg.options || []).forEach(o => { $('o_' + o.key).value = settings[o.key]; $('o_' + o.key + 'V').textContent = o.fmt ? o.fmt(settings[o.key]) : settings[o.key]; });
  }
  $('diff').addEventListener('click', e => { if (e.target.dataset.v) { settings.diff = e.target.dataset.v; save(); sync(); startBtn(); } });
  for (const k of ['offset', 'sfx']) $(k).addEventListener('input', e => { settings[k] = +e.target.value; save(); sync(); });
  (cfg.options || []).forEach(o => $('o_' + o.key).addEventListener('input', e => { settings[o.key] = +e.target.value; save(); sync(); startBtn(); }));
  $('auto').addEventListener('change', e => { settings.auto = e.target.checked; save(); startBtn(); });
  sync();

  /* ---- 曲の読み込み ---- */
  let token = 0, src = null;
  const prog = p => { $('bar').style.display = p === null ? 'none' : 'block'; if (p !== null) $('bar').firstElementChild.style.width = (p * 100).toFixed(1) + '%'; };
  function startBtn() {
    const b = $('start');
    if (!api.song) { b.disabled = true; if (!b.dataset.busy) b.textContent = '曲を選んでください'; return; }
    const n = cfg.count(api.song.feat, settings.diff, api);
    b.disabled = n === 0;
    b.textContent = n ? `${settings.auto ? 'お手本を見る' : 'スタート'} ― ${cfg.countLabel(n, api)}` : '音の立ち上がりを検出できませんでした';
  }
  async function loadBuffer(buffer, name) {
    const tk = ++token;
    api.song = null; $('err').textContent = '';
    $('fileName').textContent = name + ' を解析中…';
    $('start').dataset.busy = '1'; $('start').disabled = true; $('start').textContent = '曲を解析しています…';
    prog(0);
    try {
      const feat = await RG.analyze(buffer, p => { if (tk === token) prog(p); });
      if (tk !== token) return;
      api.song = { name: name.replace(/\.[a-z0-9]{2,5}$/i, ''), buffer, feat };
      const m = Math.floor(buffer.duration / 60), s = Math.floor(buffer.duration % 60);
      $('fileName').textContent = `♪ ${api.song.name} (${m}:${String(s).padStart(2, '0')})`;
    } catch (e) {
      if (tk !== token) return;
      $('fileName').textContent = ''; $('err').textContent = '解析に失敗しました: ' + e.message;
    } finally {
      if (tk === token) { prog(null); delete $('start').dataset.busy; startBtn(); }
    }
  }
  async function loadData(data, name, remember) {
    $('err').textContent = ''; $('fileName').textContent = name + ' を読み込み中…';
    let buffer;
    try { buffer = await A.ensure().decodeAudioData(data.slice(0)); }
    catch (e) {
      $('fileName').textContent = '';
      $('err').textContent = 'この形式のファイルは再生できませんでした。mp3 / wav / ogg / m4a などを試してください。';
      return;
    }
    if (remember) RG.saveSong(name, data);
    await loadBuffer(buffer, name);
  }
  const loadFile = async f => { if (f) loadData(await f.arrayBuffer(), f.name, true); };
  const drop = $('drop');
  drop.addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', e => { loadFile(e.target.files[0]); e.target.value = ''; });
  window.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  window.addEventListener('dragleave', () => drop.classList.remove('over'));
  window.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); if (api.state === 'title') loadFile(e.dataTransfer.files[0]); });
  RG.loadSong().then(s => { if (s && !api.song && token === 0) loadData(s.data, s.name, false); });   // 前回の曲を復元

  /* ---- 進行 ---- */
  api.time = () => A.ctx.currentTime - api.startAt - (A.ctx.outputLatency || A.ctx.baseLatency || 0) - settings.offset / 1000;
  function stop() { if (src) { try { src.stop(); } catch (e) {} src.disconnect(); src = null; } }
  function start() {
    if (!api.song) return;
    stop();
    if (api.W !== (window.innerWidth || 800) || api.H !== (window.innerHeight || 600)) resize();
    const ctx = A.ensure(); ctx.resume();
    src = ctx.createBufferSource(); src.buffer = api.song.buffer; src.connect(A.analyser);
    api.startAt = ctx.currentTime + api.lead; src.start(api.startAt);
    api.duration = api.song.buffer.duration; api.diff = settings.diff; api.auto = settings.auto;
    api.state = 'play';
    cfg.start(api);
    show(null);
  }
  function setPaused(p) {
    if (p && api.state === 'play') { api.state = 'pause'; A.ctx.suspend(); show('scPause'); }
    else if (!p && api.state === 'pause') { api.state = 'play'; A.ctx.resume(); show(null); }
  }
  function quit() { stop(); if (A.ctx) A.ctx.resume(); api.state = 'title'; cfg.quit && cfg.quit(api); show('scTitle'); }
  // res = { score, pct(0〜100), names:[S..Dの称号], title, stats:[[ラベル, 値, 色]] }
  api.finish = function (res) {
    api.state = 'result';
    const [, rank, rc] = RANKS.find(r => res.pct >= r[0]);
    const names = res.names || ['神業', '達人', '上手', 'まずまず', '練習中'];
    $('rank').textContent = rank; $('rank').style.color = rc;
    $('rank').classList.remove('stamp'); void $('rank').offsetWidth; $('rank').classList.add('stamp');
    $('rankName').textContent = api.auto ? 'お手本プレイ' : names['SABCD'.indexOf(rank)] + (res.title ? ' ・ ' + res.title : '');
    $('resSong').textContent = '♪ ' + api.song.name;
    $('stats').innerHTML = res.stats.map(s => `<div${s[2] ? ` style="color:${s[2]}"` : ''}>${s[0]}<b>${s[1]}</b></div>`).join('');
    const t0 = performance.now(), el = $('rScore');
    (function roll() {
      const p = Math.min(1, (performance.now() - t0) / 1300);
      el.textContent = Math.round(res.score * (1 - Math.pow(1 - p, 3))).toLocaleString();
      if (p < 1 && api.state === 'result') requestAnimationFrame(roll);
    })();
    const be = $('best'); be.className = ''; be.textContent = '';
    if (!api.auto) {
      const all = JSON.parse(localStorage.getItem('rg_best') || '{}'), key = cfg.id + '|' + api.song.name + '|' + api.diff, prev = all[key] || 0;
      if (res.score > prev) {
        all[key] = res.score; localStorage.setItem('rg_best', JSON.stringify(all));
        be.textContent = prev ? `自己ベスト更新! (+${(res.score - prev).toLocaleString()})` : '自己ベスト更新!'; be.className = 'new';
      } else be.textContent = `自己ベスト ${prev.toLocaleString()}`;
    }
    if (rank === 'S' || rank === 'A') setTimeout(() => RG.sfx.cheer(1), 900);
    api.rank = rank;
    show('scResult');
  };

  /* ---- 入力 ---- */
  const ptr = (type, e) => {
    const P = api.pointer;
    P.x = e.clientX; P.y = e.clientY; P.touch = e.pointerType === 'touch';
    if (type === 'down') P.down = true; else if (type === 'up') P.down = false;
    cfg.pointer && cfg.pointer(api, type, e);
  };
  cv.addEventListener('pointerdown', e => { cv.setPointerCapture && cv.setPointerCapture(e.pointerId); ptr('down', e); });
  window.addEventListener('pointermove', e => ptr('move', e));
  window.addEventListener('pointerup', e => ptr('up', e));
  cv.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('keydown', e => {
    if (e.code === 'Escape') { if (api.state === 'play') setPaused(true); else if (api.state === 'pause') setPaused(false); return; }
    if (api.state !== 'play') return;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (!e.repeat) { api.keys[e.code] = true; cfg.key && cfg.key(api, e.code, true); }
  });
  window.addEventListener('keyup', e => { api.keys[e.code] = false; if (api.state === 'play') cfg.key && cfg.key(api, e.code, false); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) setPaused(true); });
  $('pauseBtn').onclick = () => setPaused(true);
  $('resume').onclick = () => setPaused(false);
  $('retryP').onclick = $('retryR').onclick = () => { A.ctx.resume(); start(); };
  $('quitP').onclick = $('quitR').onclick = quit;
  $('start').onclick = start;

  /* ---- 毎フレーム ---- */
  let lastTs = 0;
  function step(ts) {
    const dt = Math.min(0.05, (ts - lastTs) / 1000 || 0.016); lastTs = ts;
    A.update();
    if (api.state === 'play' && api.time() > api.duration + 1.2) { api.state = 'ending'; cfg.end(api); }
    // 毎フレーム描画状態を初期化し、1コマの失敗が次のコマに残らないようにする
    c.setTransform(api.dpr, 0, 0, api.dpr, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.shadowBlur = 0; c.setLineDash([]);
    try { cfg.frame(api, dt); } catch (e) { console.error(e); }
  }
  function loop(ts) { requestAnimationFrame(loop); step(ts); }
  // 画面が隠れて描画が間引かれても、曲に置いていかれないよう進行だけは続ける
  setInterval(() => { const n = performance.now(); if (!document.hidden && n - lastTs > 200) step(n); }, 33);
  resize();
  requestAnimationFrame(loop);
  api.loadBuffer = loadBuffer; api.start = start;       // 動作テスト用
  return api;
};
})();
