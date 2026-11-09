// drums.js — ドラム・シンバルの合成音と、叩いたタイミングの記録・整列（依存なし）
//
// 設計（docs/03_設計書.md §5.8）
//  - 音はサンプルを使わず Web Audio で合成（外部ファイル・通信なし）
//  - 録音中に叩いたタイミングを {t, type} で記録し、再生時に合成音で鳴らし直す
//  - スピーカー → マイクの回り込みで録音側にもドラム音が入るため、
//    録音波形の立ち上がりに合わせてタイミングを補正する（alignHits）

export const DRUM_TYPES = ['drum', 'cymbal'];

let noiseCache = new WeakMap();
function noiseBuffer(ctx) {
  let b = noiseCache.get(ctx);
  if (!b) {
    const len = Math.floor(ctx.sampleRate * 2);
    b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, b);
  }
  return b;
}

/**
 * バスドラム風：ピッチが下がるサイン波＋アタックのクリック＋胴鳴り
 * @param {number} tune 音の高さの倍率（0.6〜1.6、1 = 標準）
 */
function playDrum(ctx, dest, when, tune = 1) {
  const k = tune;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(160 * k, when);
  o.frequency.exponentialRampToValueAtTime(48 * k, when + 0.14);
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(0.7, when + 0.004);
  g.gain.exponentialRampToValueAtTime(0.001, when + 0.45);
  o.connect(g); g.connect(dest);
  o.start(when); o.stop(when + 0.5);

  // スマホのスピーカーでも聞こえるよう、中域のアタック成分を足す
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(ctx);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass'; f.frequency.value = 1800 * Math.sqrt(k); f.Q.value = 0.8;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.35, when);
  ng.gain.exponentialRampToValueAtTime(0.001, when + 0.035);
  n.connect(f); f.connect(ng); ng.connect(dest);
  n.start(when, Math.random()); n.stop(when + 0.05);

  // 胴鳴り
  const o2 = ctx.createOscillator();
  const g2 = ctx.createGain();
  o2.type = 'triangle';
  o2.frequency.setValueAtTime(220 * k, when);
  o2.frequency.exponentialRampToValueAtTime(110 * k, when + 0.1);
  g2.gain.setValueAtTime(0.25, when);
  g2.gain.exponentialRampToValueAtTime(0.001, when + 0.18);
  o2.connect(g2); g2.connect(dest);
  o2.start(when); o2.stop(when + 0.2);
}

/**
 * シンバル風（乾いた音）：高域ノイズだけで作る。音程のある成分は入れない（入れると銅鑼のように鳴る）。
 *  - 本体：7 kHz 以上（2 段ハイパス）＋ 10 kHz 付近を強調。標準で 0.1 秒で 1/4 まで落ち、0.6 秒で消える
 *  - 打撃音：3 kHz 付近の短いノイズ（スティックが当たる「チッ」）
 * v0.7.1 で変更（v0.7.0 は 400〜1700 Hz の矩形波と 1.8 秒の余韻で、銅鑼のように聞こえた）
 * @param {number} decay 余韻の長さの倍率（0.4〜2.5、1 = 標準 0.6 秒）
 */
function playCymbal(ctx, dest, when, decay = 1) {
  const d = decay;
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(ctx);
  const hp1 = ctx.createBiquadFilter(); hp1.type = 'highpass'; hp1.frequency.value = 7000;
  const hp2 = ctx.createBiquadFilter(); hp2.type = 'highpass'; hp2.frequency.value = 7000;
  const pk = ctx.createBiquadFilter(); pk.type = 'peaking'; pk.frequency.value = 10000; pk.gain.value = 5; pk.Q.value = 0.9;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(0.32, when + 0.002);
  g.gain.exponentialRampToValueAtTime(0.08, when + 0.1 * d);
  g.gain.exponentialRampToValueAtTime(0.001, when + 0.6 * d);
  n.connect(hp1); hp1.connect(hp2); hp2.connect(pk); pk.connect(g); g.connect(dest);
  n.start(when, Math.random() * 0.5); n.stop(when + 0.65 * d);

  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(ctx);
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 1.2;
  const sg = ctx.createGain();
  sg.gain.setValueAtTime(0.25, when);
  sg.gain.exponentialRampToValueAtTime(0.001, when + 0.02);
  s.connect(bp); bp.connect(sg); sg.connect(dest);
  s.start(when, Math.random()); s.stop(when + 0.03);
}

/**
 * 1 打を鳴らす。
 * @param {{level?:number, tune?:number, decay?:number}} [opts]
 *   level 音量（0〜1.2）、tune ドラムの高さ倍率、decay シンバルの余韻倍率
 */
export function playHit(ctx, dest, type, when = ctx.currentTime, opts = {}) {
  const lv = ctx.createGain();
  lv.gain.value = opts.level ?? 1;
  lv.connect(dest);
  if (type === 'cymbal') playCymbal(ctx, lv, when, opts.decay ?? 1);
  else playDrum(ctx, lv, when, opts.tune ?? 1);
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
