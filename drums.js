// drums.js — ドラムセットの音（依存なし）。v0.9.1 から録音素材（CC0）を優先し、合成音は読み込み前の代わり。v0.8 で声の録音とドラムの打ち込みを分離した。
// alignHits／cleanDrumBleed／maskDrumPitch は、v0.7 で「歌いながら叩いた」録音（source: 'rec'）を開くための互換処理。
//
// 設計（docs/03_設計書.md §5.8）
//  - 音はサンプルを使わず Web Audio で合成（外部ファイル・通信なし）
//  - 録音中に叩いたタイミングを {t, type} で記録し、再生時に合成音で鳴らし直す
//  - スピーカー → マイクの回り込みで録音側にもドラム音が入るため、
//    録音波形の立ち上がりに合わせてタイミングを補正する（alignHits）

/**
 * ドラムセットの構成（v0.8）。family は設定の適用先（drum: 大きさ・音の高さ／cymbal: 大きさ・ひびきの長さ）。
 * 配列の順はタイムラインの段の順（上から）。
 * 旧データの type 'drum' は kick、'cymbal' は v0.7 の乾いたシンバルとして鳴らす。
 */
export const KIT = [
  { type: 'crash', label: 'クラッシュ', family: 'cymbal', color: '#e9b949' },
  { type: 'ride', label: 'ライド', family: 'cymbal', color: '#d4a017' },
  { type: 'hihat', label: 'ハイハット', family: 'cymbal', color: '#c9b458' },
  { type: 'tomHigh', label: 'タム（たかい）', family: 'drum', color: '#e76f51' },
  { type: 'tomMid', label: 'タム（ひくい）', family: 'drum', color: '#d1495b' },
  { type: 'tomFloor', label: 'フロアタム', family: 'drum', color: '#9c3848' },
  { type: 'snare', label: 'スネア', family: 'drum', color: '#4a90e2' },
  { type: 'kick', label: 'バスドラム', family: 'drum', color: '#6b4226' },
];
const LEGACY = { drum: 'kick', cymbal: 'crash' };
/** type から KIT の定義を返す（旧 type も解決） */
export function kitOf(type) {
  return KIT.find((k) => k.type === type) || KIT.find((k) => k.type === LEGACY[type]) || KIT[KIT.length - 1];
}

let noiseCache = new WeakMap();
function noiseBuffer(ctx) {
  let b = noiseCache.get(ctx);
  if (!b) {
    const len = Math.floor(ctx.sampleRate * 3);
    b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, b);
  }
  return b;
}

// ---- 部品 ----
// 合成の方針（docs/03_設計書.md §5.11）：実機の録音（利用者提供の参考演奏）を計測し、
// 帯域ごとの強さ・減衰・音程が近くなるように合わせた。録音の音そのものは使っていない。

/** 白色雑音のソース（ループ再生、開始位置はランダム） */
function noise(ctx, when, len) {
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(ctx);
  n.loop = true;
  n.start(when, Math.random() * 2.5);
  n.stop(when + len + 0.05);
  return n;
}
function biquad(ctx, type, freq, q = 0.707, gain = 0) {
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = q; f.gain.value = gain;
  return f;
}
/** 減衰エンベロープ：アタック atk 秒でピーク peak、len 秒で −60 dB */
function env(ctx, when, peak, len, atk = 0.002) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(peak, when + atk);
  g.gain.exponentialRampToValueAtTime(peak * 0.001, when + atk + len);
  return g;
}
function chain(...nodes) { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; }

/** 音程のある膜の振動（周波数 f1 → f2 へ glide 秒で下がる） */
function membrane(ctx, dest, when, { f1, f2, glide, peak, len, type = 'sine' }) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f1, when);
  o.frequency.exponentialRampToValueAtTime(f2, when + glide);
  chain(o, env(ctx, when, peak, len), dest);
  o.start(when); o.stop(when + len + 0.05);
}

// ---- 太鼓類 ----

/** バスドラム：54 Hz 付近まで素早く下がり 43 Hz へ落ちる低音＋ビーターのアタック */
function playKick(ctx, dest, when, tune = 1) {
  const k = tune;
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(150 * k, when);
  o.frequency.exponentialRampToValueAtTime(56 * k, when + 0.03);
  o.frequency.exponentialRampToValueAtTime(43 * k, when + 0.12);
  chain(o, env(ctx, when, 0.72, 0.26, 0.002), dest);
  o.start(when); o.stop(when + 0.4);
  // ビーターのアタック（中〜高域、ごく短く）
  chain(noise(ctx, when, 0.03), biquad(ctx, 'bandpass', 2800, 0.6), env(ctx, when, 0.6, 0.025, 0.0005), dest);
  chain(noise(ctx, when, 0.04), biquad(ctx, 'bandpass', 1100, 0.7), env(ctx, when, 0.4, 0.035, 0.0005), dest);
  // 胴の短い響き
  chain(noise(ctx, when, 0.2), biquad(ctx, 'bandpass', 380, 0.6), env(ctx, when, 0.05, 0.18, 0.003), dest);
  chain(noise(ctx, when, 0.3), biquad(ctx, 'bandpass', 1500, 0.4), env(ctx, when, 0.02, 0.26, 0.003), dest);
  membrane(ctx, dest, when, { f1: 380 * k, f2: 250 * k, glide: 0.02, peak: 0.1, len: 0.05 });
}

/** スネア：183 Hz の胴鳴り＋2 次モード、響き線（1〜8 kHz のノイズ、胴鳴りより長く残る） */
function playSnare(ctx, dest, when, tune = 1) {
  const k = tune;
  membrane(ctx, dest, when, { f1: 195 * k, f2: 178 * k, glide: 0.08, peak: 0.62, len: 0.22 });
  membrane(ctx, dest, when, { f1: 345 * k, f2: 330 * k, glide: 0.05, peak: 0.16, len: 0.2 });
  membrane(ctx, dest, when, { f1: 90 * k, f2: 80 * k, glide: 0.05, peak: 0.14, len: 0.08 });
  // 響き線（立ち上がりを少し遅らせ、長めに残す）
  chain(noise(ctx, when, 0.4), biquad(ctx, 'highpass', 900, 0.6), biquad(ctx, 'peaking', 4500, 0.6, 3),
    biquad(ctx, 'lowpass', 6500, 0.7), env(ctx, when, 0.12, 0.4, 0.012), dest);
  // スティックのアタック
  chain(noise(ctx, when, 0.02), biquad(ctx, 'bandpass', 1200, 0.8), env(ctx, when, 0.14, 0.015, 0.0005), dest);
}

/** タム：ほぼ一定の音程で長く鳴る基音＋倍音（2.25 倍）＋胴の響き＋スティックのアタック */
function playTom(ctx, dest, when, f0, len, tune = 1, over = 0.3, body = 900, stick = 0.55) {
  const f = f0 * tune;
  membrane(ctx, dest, when, { f1: f * 1.07, f2: f, glide: 0.18, peak: 0.46, len });
  membrane(ctx, dest, when, { f1: f * 2.35, f2: f * 2.25, glide: 0.1, peak: 0.46 * over, len: len * 0.6 });
  membrane(ctx, dest, when, { f1: f * 3.6, f2: f * 3.5, glide: 0.05, peak: 0.06, len: len * 0.25 });
  // 胴とヘッドの響き（広い帯域の短めの余韻）
  chain(noise(ctx, when, len * 0.7), biquad(ctx, 'bandpass', body, 0.35), env(ctx, when, 0.1, len * 0.6, 0.004), dest);
  chain(noise(ctx, when, 0.05), biquad(ctx, 'bandpass', 2500, 0.3), env(ctx, when, stick, 0.04, 0.0005), dest);
}

// ---- シンバル類 ----

// 金属らしさを出す非整数倍の部分音。数十本を密に重ねた波形を 1 回だけ計算してバッファにする
// （1 打ごとに発振器を数十個作るとスマホで重いため）。高い部分音ほど早く減衰させる。
const partialCache = new WeakMap();
function partialBuffer(ctx, key, { lo, hi, n, seed, len, peaks = [] }) {
  let m = partialCache.get(ctx);
  if (!m) { m = new Map(); partialCache.set(ctx, m); }
  if (m.has(key)) return m.get(key);
  const sr = ctx.sampleRate, N = Math.floor(sr * len);
  const buf = ctx.createBuffer(1, N, sr);
  const d = buf.getChannelData(0);
  let r = seed;
  const rnd = () => { r = (r * 1664525 + 1013904223) >>> 0; return r / 4294967296; };
  const lr = Math.log(hi / lo);
  for (let i = 0; i < n; i++) {
    const f = lo * Math.exp(lr * ((i + rnd()) / n));
    let amp = 0.4 + 0.6 * rnd();
    for (const p of peaks) amp *= 1 + p.gain * Math.exp(-((Math.log(f / p.f) / 0.18) ** 2));
    const tau = len * 0.45 * Math.pow(1000 / f, 0.55) * (0.7 + 0.6 * rnd());   // 高い音ほど短い
    const w = (2 * Math.PI * f) / sr, ph = rnd() * 2 * Math.PI, k = Math.exp(-1 / (tau * sr));
    let e = amp;
    for (let j = 0; j < N; j++) { d[j] += e * Math.sin(w * j + ph); e *= k; }
  }
  let pk = 0;
  for (let j = 0; j < N; j++) pk = Math.max(pk, Math.abs(d[j]));
  for (let j = 0; j < N; j++) d[j] /= pk || 1;
  m.set(key, buf);
  return buf;
}
const PARTIAL_SETS = {
  crash: { lo: 420, hi: 7800, n: 72, seed: 11, len: 3.5, peaks: [{ f: 1800, gain: 0.8 }, { f: 3100, gain: 1.2 }] },
  ride: { lo: 700, hi: 7000, n: 54, seed: 29, len: 2.5, peaks: [{ f: 3100, gain: 2.0 }, { f: 5000, gain: 1.0 }] },
  hihat: { lo: 2600, hi: 12500, n: 40, seed: 47, len: 0.6 },
};
function shimmer(ctx, dest, when, set, { peak, len }) {
  const src = ctx.createBufferSource();
  src.buffer = partialBuffer(ctx, set, PARTIAL_SETS[set]);
  src.connect(env(ctx, when, peak, len, 0.002)).connect(dest);
  src.start(when);
  src.stop(when + Math.min(len + 0.05, src.buffer.duration));
}

/**
 * 帯域ごとに減衰時間の違うノイズで「シャーン」を作る（低めの帯域ほど長く残る）。
 * bands: [{type, f, q, peak, len}]
 */
function wash(ctx, dest, when, bands, atk = 0.003) {
  const maxLen = Math.max(...bands.map((b) => b.len));
  const src = noise(ctx, when, maxLen + atk);
  for (const b of bands) chain(src, biquad(ctx, b.type, b.f, b.q), env(ctx, when, b.peak, b.len, atk), dest);
}
/**
 * クラッシュ：叩いた瞬間は広い帯域のノイズ（1 秒前後で引く）、その後は金属の部分音が 3 秒ほど残る。
 * 10 kHz 以上は約 0.3 秒、5〜10 kHz は約 0.7 秒で消える
 */
function playCrash(ctx, dest, when, decay = 1) {
  const d = decay;
  wash(ctx, dest, when, [
    { type: 'bandpass', f: 550, q: 0.8, peak: 0.12, len: 1.3 * d },
    { type: 'bandpass', f: 1400, q: 0.8, peak: 0.18, len: 1.4 * d },
    { type: 'bandpass', f: 3300, q: 0.8, peak: 0.28, len: 1.3 * d },
    { type: 'bandpass', f: 7000, q: 1.2, peak: 0.26, len: 0.7 * d },
    { type: 'highpass', f: 10500, q: 0.7, peak: 0.1, len: 0.3 * d },
  ]);
  shimmer(ctx, dest, when, 'crash', { peak: 0.34, len: 3.2 * d });
}

/** ライド：スティックの「チン」、3 kHz・5 kHz 付近の部分音が中心。ノイズは控えめ */
function playRide(ctx, dest, when, decay = 1) {
  const d = decay;
  const dark = biquad(ctx, 'lowpass', 7000, 0.6);
  dark.connect(dest);
  wash(ctx, dark, when, [
    { type: 'bandpass', f: 450, q: 1.0, peak: 0.12, len: 0.9 * d },
    { type: 'bandpass', f: 1500, q: 1.0, peak: 0.08, len: 1.0 * d },
    { type: 'bandpass', f: 3400, q: 1.1, peak: 0.16, len: 1.1 * d },
    { type: 'bandpass', f: 6800, q: 1.4, peak: 0.04, len: 0.6 * d },
  ], 0.002);
  shimmer(ctx, dark, when, 'ride', { peak: 0.36, len: 2.2 * d });
  // チップのアタック
  chain(noise(ctx, when, 0.02), biquad(ctx, 'bandpass', 4200, 1.2), env(ctx, when, 0.3, 0.02, 0.0005), dark);
}

/** ハイハット（クローズ）：ほぼ全帯域のノイズを 1 kHz 付近だけ少し下げ、約 0.1 秒で止める */
function playHat(ctx, dest, when, decay = 1) {
  const len = 0.24 * Math.min(2, Math.max(0.6, decay));
  chain(noise(ctx, when, len), biquad(ctx, 'highpass', 120, 0.7), biquad(ctx, 'peaking', 1100, 0.8, -6),
    biquad(ctx, 'highshelf', 6000, 0.7, 3), env(ctx, when, 0.3, len, 0.001), dest);
  shimmer(ctx, dest, when, 'hihat', { peak: 0.08, len: len * 0.8 });
}

// ---- 録音素材（v0.9.1） ----
// 本物のドラムの録音（CC0 の Virtuosity Drums。samples/CREDITS.md）を優先して鳴らす。
// 読み込み前・読み込み失敗時は上の合成音で鳴らす。
// rate は再生速度（＝音程の倍率）。タム（ひくい）は高いタムを約 4 半音下げて使う。
const SAMPLE_MAP = {
  kick: { files: ['kick_1', 'kick_2'], rate: 1, gain: 0.95, family: 'drum' },
  snare: { files: ['snare_1', 'snare_2'], rate: 1, gain: 1.0, family: 'drum' },
  tomHigh: { files: ['htom_1', 'htom_2'], rate: 1, gain: 0.72, family: 'drum' },
  tomMid: { files: ['htom_1', 'htom_2'], rate: 0.8, gain: 0.75, family: 'drum' },
  tomFloor: { files: ['ltom_1', 'ltom_2'], rate: 1, gain: 0.75, family: 'drum' },
  hihat: { files: ['hihat_1', 'hihat_2'], rate: 1, gain: 0.85, family: 'cymbal' },
  crash: { files: ['crash_1'], rate: 1, gain: 0.62, family: 'cymbal' },
  ride: { files: ['ride_1'], rate: 1, gain: 0.95, family: 'cymbal' },
};
SAMPLE_MAP.drum = SAMPLE_MAP.kick;      // 旧データ
SAMPLE_MAP.cymbal = SAMPLE_MAP.crash;   // 旧データ

const sampleStore = new WeakMap();      // ctx → { buffers: Map(name → AudioBuffer), loading: Promise }
const rrIndex = {};

/** 録音素材を読み込む（何度呼んでも 1 回だけ）。失敗しても例外は投げない */
export function loadDrumSamples(ctx, base = './samples/') {
  let st = sampleStore.get(ctx);
  if (st) return st.loading;
  st = { buffers: new Map(), loading: null };
  sampleStore.set(ctx, st);
  const names = [...new Set(Object.values(SAMPLE_MAP).flatMap((m) => m.files))];
  st.loading = Promise.all(names.map(async (name) => {
    try {
      const res = await fetch(`${base}${name}.wav`);
      if (!res.ok) throw new Error(res.status);
      const arr = await res.arrayBuffer();
      const buf = await new Promise((resolve, reject) => {
        // 古い Safari はコールバック形式のみのため両対応
        const p = ctx.decodeAudioData(arr, resolve, reject);
        if (p && p.then) p.then(resolve, reject);
      });
      st.buffers.set(name, buf);
    } catch (e) {
      console.warn('drum sample load failed', name, e);
    }
  })).then(() => st.buffers.size);
  return st.loading;
}

function playSample(ctx, dest, type, when, opts) {
  const st = sampleStore.get(ctx);
  const m = SAMPLE_MAP[type];
  if (!st || !m) return false;
  const k = (rrIndex[type] = ((rrIndex[type] ?? -1) + 1) % m.files.length);
  const buf = st.buffers.get(m.files[k]);
  if (!buf) return false;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  // 毎回少しだけ揺らす（機械的な同じ音の連続を避ける）
  const human = 1 + (Math.random() - 0.5) * 0.02;
  src.playbackRate.value = m.rate * (m.family === 'drum' ? (opts.tune ?? 1) : 1) * human;
  const g = ctx.createGain();
  const level = (opts.level ?? 1) * m.gain * (0.92 + Math.random() * 0.08);
  const dur = buf.duration / src.playbackRate.value;
  const decay = m.family === 'cymbal' ? (opts.decay ?? 1) : 1;
  g.gain.setValueAtTime(level, when);
  if (decay < 0.999) {
    // ひびきを短くする：途中から早めに消す
    const end = Math.max(0.08, dur * decay);
    g.gain.setValueAtTime(level, when + end * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, when + end);
  }
  src.connect(g); g.connect(dest);
  if (type === 'kick' || type === 'drum') {
    // スマホのスピーカーでも聞こえるよう、ビーターのアタック帯域を少し持ち上げる
    const eq = ctx.createBiquadFilter();
    eq.type = 'peaking'; eq.frequency.value = 3200; eq.Q.value = 0.9; eq.gain.value = 5;
    src.disconnect(); src.connect(eq); eq.connect(g);
  }
  src.start(when);
  src.stop(when + Math.min(dur, decay < 0.999 ? Math.max(0.08, dur * decay) : dur) + 0.02);
  return true;
}

/**
 * 1 打を鳴らす。
 * @param {string} type KIT の type（旧 'drum'／'cymbal' も可）
 * @param {{level?:number, tune?:number, decay?:number}} [opts]
 *   level 音量（0〜1.2）、tune 太鼓類の高さ倍率、decay シンバル類の余韻倍率
 */
export function playHit(ctx, dest, type, when = ctx.currentTime, opts = {}) {
  if (playSample(ctx, dest, type, when, opts)) return;
  // 録音素材がまだ無いときは合成音
  const lv = ctx.createGain();
  lv.gain.value = opts.level ?? 1;
  lv.connect(dest);
  const tune = opts.tune ?? 1, decay = opts.decay ?? 1;
  switch (type) {
    case 'crash': case 'cymbal': playCrash(ctx, lv, when, decay); break;   // 'cymbal' は旧データ
    case 'ride': playRide(ctx, lv, when, decay); break;
    case 'hihat': playHat(ctx, lv, when, decay); break;
    case 'snare': playSnare(ctx, lv, when, tune); break;
    case 'tomHigh': playTom(ctx, lv, when, 116, 0.6, tune, 0.3, 900, 0.7); break;
    case 'tomMid': playTom(ctx, lv, when, 86, 0.75, tune, 0.5, 650, 0.75); break;
    case 'tomFloor': lv.gain.value *= 0.85; playTom(ctx, lv, when, 65, 0.95, tune, 0.6, 420, 0.9); break;
    default: playKick(ctx, lv, when, tune);                                // kick・旧 'drum'
  }
}

/**
 * 録音波形の立ち上がりに合わせて、叩いたタイミングを補正する（純関数・Node でテスト可能）。
 * 叩いた時刻 t に推定遅延 fallbackSec を足した位置の前後（-60 〜 +120 ms）だけを探し、
 * 高域（2 次差分）のエネルギーが急増した位置に合わせる。見つからなければ t + fallbackSec。
 * 探索範囲を狭くしているのは、声の歌い出しに誤って吸着しないため（最大誤差を約 120 ms に抑える）。
 * @param {Float32Array} pcm
 * @param {number} sampleRate
 * @param {{t:number,type:string}[]} events 録音開始からの秒
 * @param {number} fallbackSec 回り込みの推定遅延（出力＋入力）
 */
export function alignHits(pcm, sampleRate, events, fallbackSec = 0.05) {
  const hop = Math.max(1, Math.round(sampleRate * 0.005)); // 5 ms
  const nHop = Math.floor(pcm.length / hop);
  const e = new Float32Array(nHop);
  for (let h = 0; h < nHop; h++) {
    let s = 0;
    const base = h * hop;
    for (let i = 2; i < hop; i++) { const d = pcm[base + i] - 2 * pcm[base + i - 1] + pcm[base + i - 2]; s += d * d; }
    e[h] = s / hop;
  }
  const dur = pcm.length / sampleRate;
  return events.map((ev) => {
    const center = ev.t + fallbackSec;
    const lo = Math.max(4, Math.floor((center - 0.06) * sampleRate / hop));
    const hi = Math.min(nHop - 1, Math.ceil((center + 0.12) * sampleRate / hop));
    let best = -1, bestRatio = 0;
    for (let h = lo; h <= hi; h++) {
      const prev = (e[h - 1] + e[h - 2] + e[h - 3] + e[h - 4]) / 4 + 1e-12;
      const ratio = e[h] / prev;
      if (ratio > bestRatio) { bestRatio = ratio; best = h; }
    }
    const t = bestRatio >= 6 && best >= 0 ? (best * hop) / sampleRate : center;
    return { ...ev, t: Math.max(0, Math.min(dur, t)) };
  });
}

/**
 * ドラム音が回り込んだ区間のピッチを消す（ドラムの低い音を声と誤認しないため）。
 * 子どもの声より明らかに低い f0（< 200 Hz）だけを、叩いた直後 150 ms の範囲で無声にする。
 */
export function maskDrumPitch(track, events) {
  for (const ev of events) {
    if (ev.type !== 'drum' || ev.source === 'overdub') continue;
    for (let i = 0; i < track.times.length; i++) {
      const dt = track.times[i] - ev.t;
      if (dt >= -0.01 && dt <= 0.15 && track.f0[i] > 0 && track.f0[i] < 200) track.f0[i] = 0;
    }
  }
  return track;
}

function lowpass(x, sr, fc) {
  // RBJ biquad lowpass（Q = 0.707）
  const w = 2 * Math.PI * fc / sr, cw = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2);
  const b0 = (1 - cw) / 2, b1 = 1 - cw, b2 = (1 - cw) / 2, a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/**
 * 同時録音でマイクに入ったドラム・シンバルの音を、ハモリ生成・ピッチ解析用の信号から取り除く。
 *  - シンバル：叩いてから 0.7 秒 × 余韻倍率（イベントの decay）の間、3.8 kHz 以下だけを通す（シンバルは高域、声の主成分は低〜中域）
 *  - ドラム：叩いた直後 130 ms を 1/10 に下げる
 * 「あとから重ねた」ドラム（source: 'overdub'）はマイクに入っていないので対象外。
 * 戻り値は新しい配列（元の録音は変更しない）。
 */
export function cleanDrumBleed(pcm, sampleRate, events) {
  const rec = events.filter((e) => e.source !== 'overdub');
  if (rec.length === 0) return pcm;
  const n = pcm.length, sr = sampleRate;
  const lp = lowpass(lowpass(pcm, sr, 3800), sr, 3800);
  const mix = new Float32Array(n);          // 0 = 原音, 1 = ローパス
  const duck = new Float32Array(n).fill(1);
  const fade = Math.round(0.015 * sr);
  for (const e of rec) {
    const s = Math.round(e.t * sr);
    if (e.type === 'cymbal') {
      const end = s + Math.round(0.7 * (e.decay || 1) * sr);
      for (let i = Math.max(0, s - fade); i < Math.min(n, end + fade); i++) {
        let m = 1;
        if (i < s) m = (i - (s - fade)) / fade;
        else if (i >= end) m = 1 - (i - end) / fade;
        if (m > mix[i]) mix[i] = m;
      }
    } else {
      const a = s - Math.round(0.005 * sr), b = s + Math.round(0.13 * sr), fi = Math.round(0.005 * sr), fo = Math.round(0.02 * sr);
      for (let i = Math.max(0, a - fi); i < Math.min(n, b + fo); i++) {
        let g = 0.1;
        if (i < a) g = 1 - 0.9 * (i - (a - fi)) / fi;
        else if (i >= b) g = 0.1 + 0.9 * (i - b) / fo;
        if (g < duck[i]) duck[i] = g;
      }
    }
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ((1 - mix[i]) * pcm[i] + mix[i] * lp[i]) * duck[i];
  return out;
}
