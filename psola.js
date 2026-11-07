// psola.js — TD-PSOLA による声質（フォルマント）保持ピッチシフト（依存なし・純 JS）
//
// 単声の歌声を前提とする。ピッチ列（pitch.js）に基づいてピッチマークを打ち、
// マークを中心とした 2 周期長の Hann 窓グレインを、目標周期の間隔で重ね合わせる。
// 波形の形（スペクトル包絡 = 声質）はそのまま、繰り返し周期だけを変えるので
// フォルマントが保たれる。
//
// 方針（docs/03_設計書.md §3.2）
//  - 時間方向は 1:1（長さを変えない）
//  - 無声・無音区間は周期を固定（10 ms）してそのまま重ね合わせる（音程変更なし）
//  - 上方向シフトでは重なりが増えるので窓の和で正規化、下方向は正規化しない
//    （パルス間隔が広がるのが自然な低音化であるため）

import { f0At } from './pitch.js';

const UNVOICED_PERIOD_SEC = 0.010;

/** 入力ピッチマーク列を作る。各マーク { pos, T, voiced } */
export function buildPitchMarks(pcm, sampleRate, track) {
  const marks = [];
  const n = pcm.length;
  const Tu = Math.round(UNVOICED_PERIOD_SEC * sampleRate);
  let t = 0;
  while (t < n) {
    const f = f0At(track, t / sampleRate);
    if (f > 0) {
      const T = sampleRate / f;
      // 近傍 ±T/3 で振幅最大の点に吸着させる（声門閉鎖付近の主ピーク）
      const w = Math.floor(T / 3);
      let best = Math.round(t), bestV = -Infinity;
      const lo = Math.max(0, Math.round(t) - w), hi = Math.min(n - 1, Math.round(t) + w);
      for (let i = lo; i <= hi; i++) if (pcm[i] > bestV) { bestV = pcm[i]; best = i; }
      marks.push({ pos: best, T, voiced: true });
      t = best + T;
    } else {
      marks.push({ pos: Math.round(t), T: Tu, voiced: false });
      t += Tu;
    }
  }
  return marks;
}

function hann(len) {
  const w = new Float32Array(len);
  for (let i = 0; i < len; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1));
  return w;
}

const windowCache = new Map();
function getWindow(len) {
  let w = windowCache.get(len);
  if (!w) { w = hann(len); windowCache.set(len, w); }
  return w;
}

/**
 * ピッチシフトした PCM を返す。
 * @param {Float32Array} pcm 入力（モノラル）
 * @param {number} sampleRate
 * @param {object} track detectPitch の戻り値
 * @param {number} semitones 半音数（+12 = 1 オクターブ上）
 * @param {Array} [marks] buildPitchMarks の結果（省略時は内部で生成）
 */
export function pitchShiftPSOLA(pcm, sampleRate, track, semitones, marks) {
  const n = pcm.length;
  const alpha = Math.pow(2, semitones / 12);
  const inMarks = marks || buildPitchMarks(pcm, sampleRate, track);
  const acc = new Float32Array(n);
  const norm = new Float32Array(n);
  if (inMarks.length === 0) return new Float32Array(pcm);

  let tOut = inMarks[0].pos;
  let mi = 0;
  while (tOut < n) {
    // tOut に最も近い入力マークを探す（単調に進むのでポインタを進める）
    while (mi + 1 < inMarks.length && Math.abs(inMarks[mi + 1].pos - tOut) <= Math.abs(inMarks[mi].pos - tOut)) mi++;
    const m = inMarks[mi];
    const Tin = Math.max(2, Math.round(m.T));
    const len = 2 * Tin + 1;
    const win = getWindow(len);
    const center = Math.round(tOut);
    for (let k = 0; k < len; k++) {
      const src = m.pos - Tin + k;
      const dst = center - Tin + k;
      if (src < 0 || src >= n || dst < 0 || dst >= n) continue;
      acc[dst] += pcm[src] * win[k];
      norm[dst] += win[k];
    }
    tOut += m.voiced ? m.T / alpha : m.T;
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = norm[i] > 1 ? acc[i] / norm[i] : acc[i];
  return out;
}

/**
 * ハモリの音量を原音に揃える（RMS 一致、ピークは 0.98 以下に制限）。
 * 下方向シフトはグレインの間隔が広がって RMS が下がるため、生成後に補正する。
 * @returns {{gain:number}} 適用したゲイン
 */
export function matchLoudness(ref, y) {
  const rms = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, a.length)); };
  const peak = (a) => { let p = 0; for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i])); return p; };
  const rRef = rms(ref), rY = rms(y);
  if (rY < 1e-6) return { gain: 1 };
  let gain = Math.min(4, Math.max(0.5, rRef / rY));
  const p = peak(y) * gain;
  if (p > 0.98) gain *= 0.98 / p;
  for (let i = 0; i < y.length; i++) y[i] *= gain;
  return { gain };
}

/**
 * ハモリのカタログ（半音・固定間隔）。
 * 3度は曲のキーで長・短が入れ替わるため、固定の 3 度は音によって濁る。
 * キー推定による自動切替は Phase 2（要件 F2-1）。ここでは長・短を両方用意して選べるようにする。
 * 画面に並べる既定セットは DEFAULT_PRESET_IDS（設定画面で変更可）。
 */
export const HARMONY_PRESETS = [
  { id: 'up3m', semitones: 3, label: '短3度上', icon: '🐥', color: '#ffb703' },
  { id: 'up3M', semitones: 4, label: '長3度上', icon: '🐤', color: '#fb8500' },
  { id: 'up4', semitones: 5, label: '4度上', icon: '🐦', color: '#f94144' },
  { id: 'up5', semitones: 7, label: '5度上', icon: '🦜', color: '#f3722c' },
  { id: 'up6', semitones: 9, label: '6度上', icon: '🦋', color: '#f8961e' },
  { id: 'up8', semitones: 12, label: 'オクターブ上', icon: '🐝', color: '#f9c74f' },
  { id: 'down3m', semitones: -3, label: '短3度下', icon: '🐨', color: '#90be6d' },
  { id: 'down3M', semitones: -4, label: '長3度下', icon: '🐻', color: '#43aa8b' },
  { id: 'down4', semitones: -5, label: '4度下', icon: '🐼', color: '#4d908e' },
  { id: 'down5', semitones: -7, label: '5度下', icon: '🦁', color: '#577590' },
  { id: 'down8', semitones: -12, label: 'オクターブ下', icon: '🐘', color: '#277da1' },
];

/** 画面に並べる既定のハモリ（2026-11-07 実機フィードバック：オクターブは外し、種類を増やす） */
export const DEFAULT_PRESET_IDS = ['up3m', 'up3M', 'up4', 'up5', 'down3M', 'down5'];
