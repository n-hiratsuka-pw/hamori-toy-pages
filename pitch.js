// pitch.js — YIN ベースのピッチ検出（依存なし・純 JS）
//
// 入力: Float32Array PCM（モノラル）, sampleRate
// 出力: { hop: 秒, times: Float32Array, f0: Float32Array(Hz, 0=無声/無音), conf: Float32Array(0..1) }
//
// 方針（docs/03_設計書.md §3.1）
//  - 解析専用に 16 kHz へ間引き、窓 512 サンプル（32 ms）、ホップ 160 サンプル（10 ms）
//  - YIN の累積平均正規化差分関数（CMND）で周期を推定し、放物線補間で精度を上げる
//  - 無音ゲート（RMS）＋ 信頼度しきい値 ＋ メディアン平滑 ＋ 孤立区間除去

const ANALYSIS_RATE = 16000;
const FRAME = 512;
const HOP = 160;
const F_MIN = 70;    // Hz
const F_MAX = 1000;  // Hz
const YIN_THRESHOLD = 0.15;
const CONF_MIN = 0.70;        // 1 - d'min がこれ未満なら無声扱い
const SILENCE_REL = 0.03;     // 最大 RMS に対する相対しきい値
const SILENCE_ABS = 5e-4;     // 絶対しきい値
const MIN_VOICED_FRAMES = 3;  // これより短い有声区間は除去

/** 整数比の間引き（移動平均で簡易ローパスしてから抽出） */
function decimate(pcm, sampleRate, targetRate) {
  const ratio = Math.max(1, Math.round(sampleRate / targetRate));
  if (ratio === 1) return { data: pcm, rate: sampleRate };
  const n = Math.floor(pcm.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const base = i * ratio;
    for (let k = 0; k < ratio; k++) s += pcm[base + k];
    out[i] = s / ratio;
  }
  return { data: out, rate: sampleRate / ratio };
}

function frameRms(x, start, len) {
  let s = 0;
  for (let i = 0; i < len; i++) { const v = x[start + i]; s += v * v; }
  return Math.sqrt(s / len);
}

/** 1 フレームの YIN。戻り値 { f0, conf }（f0=0 は無声） */
function yinFrame(x, start, rate, tauMin, tauMax) {
  const d = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let j = 0; j < FRAME; j++) {
      const diff = x[start + j] - x[start + j + tau];
      s += diff * diff;
    }
    d[tau] = s;
  }
  // 累積平均正規化差分関数
  const cmnd = new Float32Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau];
    cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }
  // しきい値を下回る最初の谷を探す
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (cmnd[t] < YIN_THRESHOLD) {
      while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    // しきい値を下回らない場合は範囲内の最小値
    let best = tauMin, bestV = cmnd[tauMin];
    for (let t = tauMin + 1; t <= tauMax; t++) if (cmnd[t] < bestV) { bestV = cmnd[t]; best = t; }
    tau = best;
  }
  // 放物線補間
  let refined = tau;
  if (tau > 1 && tau < tauMax) {
    const a = cmnd[tau - 1], b = cmnd[tau], c = cmnd[tau + 1];
    const denom = a - 2 * b + c;
    if (Math.abs(denom) > 1e-12) refined = tau + 0.5 * (a - c) / denom;
  }
  const conf = 1 - cmnd[tau];
  return { f0: rate / refined, conf };
}

function median5(arr, i) {
  const v = [];
  for (let k = -2; k <= 2; k++) {
    const j = i + k;
    if (j >= 0 && j < arr.length && arr[j] > 0) v.push(arr[j]);
  }
  if (v.length === 0) return 0;
  v.sort((p, q) => p - q);
  return v[Math.floor(v.length / 2)];
}

/**
 * ピッチ列を推定する。
 * @param {Float32Array} pcm
 * @param {number} sampleRate
 */
export function detectPitch(pcm, sampleRate) {
  const { data: x, rate } = decimate(pcm, sampleRate, ANALYSIS_RATE);
  const tauMin = Math.max(2, Math.floor(rate / F_MAX));
  const tauMax = Math.min(Math.ceil(rate / F_MIN), FRAME - 1);
  const need = FRAME + tauMax;
  const nFrames = x.length >= need ? Math.floor((x.length - need) / HOP) + 1 : 0;

  const times = new Float32Array(nFrames);
  const f0 = new Float32Array(nFrames);
  const conf = new Float32Array(nFrames);
  const rms = new Float32Array(nFrames);

  let maxRms = 0;
  for (let i = 0; i < nFrames; i++) {
    const start = i * HOP;
    rms[i] = frameRms(x, start, FRAME);
    if (rms[i] > maxRms) maxRms = rms[i];
    times[i] = (start + FRAME / 2) / rate;
  }
  const gate = Math.max(SILENCE_ABS, maxRms * SILENCE_REL);

  for (let i = 0; i < nFrames; i++) {
    if (rms[i] < gate) { f0[i] = 0; conf[i] = 0; continue; }
    const r = yinFrame(x, i * HOP, rate, tauMin, tauMax);
    if (r.conf >= CONF_MIN && r.f0 >= F_MIN && r.f0 <= F_MAX) { f0[i] = r.f0; conf[i] = r.conf; }
    else { f0[i] = 0; conf[i] = r.conf; }
  }

  // メディアン平滑（有声区間のみ）
  const smooth = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) smooth[i] = f0[i] > 0 ? median5(f0, i) : 0;

  // 孤立した短い有声区間を除去
  let i = 0;
  while (i < nFrames) {
    if (smooth[i] > 0) {
      let j = i;
      while (j < nFrames && smooth[j] > 0) j++;
      if (j - i < MIN_VOICED_FRAMES) for (let k = i; k < j; k++) smooth[k] = 0;
      i = j;
    } else i++;
  }

  return { hop: HOP / rate, times, f0: smooth, conf };
}

/**
 * ピッチ列から任意時刻の f0 を返す補助（無声は 0）。
 */
export function f0At(track, t) {
  const idx = Math.round((t - track.times[0]) / track.hop);
  if (idx < 0 || idx >= track.f0.length) return 0;
  return track.f0[idx];
}
