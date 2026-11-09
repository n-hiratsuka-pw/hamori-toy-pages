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

/** バスドラム風：ピッチが下がるサイン波＋アタックのクリック */
function playDrum(ctx, dest, when) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(160, when);
  o.frequency.exponentialRampToValueAtTime(48, when + 0.14);
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(0.7, when + 0.004);
  g.gain.exponentialRampToValueAtTime(0.001, when + 0.45);
  o.connect(g); g.connect(dest);
  o.start(when); o.stop(when + 0.5);

  // スマホのスピーカーでも聞こえるよう、中域のアタック成分を足す
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(ctx);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.8;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.35, when);
  ng.gain.exponentialRampToValueAtTime(0.001, when + 0.035);
  n.connect(f); f.connect(ng); ng.connect(dest);
  n.start(when); n.stop(when + 0.05);

  // 胴鳴り（120 Hz 前後）を少し
  const o2 = ctx.createOscillator();
  const g2 = ctx.createGain();
  o2.type = 'triangle';
  o2.frequency.setValueAtTime(220, when);
  o2.frequency.exponentialRampToValueAtTime(110, when + 0.1);
  g2.gain.setValueAtTime(0.25, when);
  g2.gain.exponentialRampToValueAtTime(0.001, when + 0.18);
  o2.connect(g2); g2.connect(dest);
  o2.start(when); o2.stop(when + 0.2);
}

/** シンバル風：高域ノイズ＋非整数倍の矩形波（金属的な響き）、長い減衰 */
function playCymbal(ctx, dest, when) {
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(ctx);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 5500;
  const pk = ctx.createBiquadFilter();
  pk.type = 'peaking'; pk.frequency.value = 9000; pk.gain.value = 6; pk.Q.value = 1;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(0.35, when + 0.004);
  g.gain.exponentialRampToValueAtTime(0.06, when + 0.25);
  g.gain.exponentialRampToValueAtTime(0.001, when + 1.8);
  n.connect(hp); hp.connect(pk); pk.connect(g); g.connect(dest);
  n.start(when); n.stop(when + 1.9);

  const mhp = ctx.createBiquadFilter();
  mhp.type = 'highpass'; mhp.frequency.value = 6500;
  const mg = ctx.createGain();
  mg.gain.setValueAtTime(0.0001, when);
  mg.gain.exponentialRampToValueAtTime(0.08, when + 0.004);
  mg.gain.exponentialRampToValueAtTime(0.001, when + 1.2);
  mhp.connect(mg); mg.connect(dest);
  for (const r of [2, 3, 4.16, 5.43, 6.79, 8.21]) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = 205 * r;
    o.connect(mhp);
    o.start(when); o.stop(when + 1.3);
  }
}

export function playHit(ctx, dest, type, when = ctx.currentTime) {
  if (type === 'cymbal') playCymbal(ctx, dest, when);
  else playDrum(ctx, dest, when);
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
 *  - シンバル：叩いてから 1.6 秒間、3.8 kHz 以下だけを通す（シンバルは高域、声の主成分は低〜中域）
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
      const end = s + Math.round(1.6 * sr);
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
