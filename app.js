// app.js — はもり（hamori-toy）メイン
// 録音 → ピッチ解析（pitch.js） → ハモリ生成（psola.js） → 重ね再生
// すべて端末内で完結し、外部へは何も送信しない。

import { detectPitch } from './pitch.js';
import { pitchShiftPSOLA, buildPitchMarks, matchLoudness, HARMONY_PRESETS, DEFAULT_PRESET_IDS } from './psola.js';
import { APP_VERSION } from './version.js';
import { playHit, maskDrumPitch, cleanDrumBleed, KIT, kitOf } from './drums.js';
import { listTakes, getTake, saveTake, setFavorite, updateEnabled, updateDrums, deleteTake, FAVORITE_MAX } from './store.js';

const MAX_SECONDS = 30;
const MIN_SECONDS = 0.5;
const SETTINGS_KEY = 'hamori.settings.v1';
const ENABLED_KEY = 'hamori.enabled.v1';

// 設定の既定値（保護者用パネルで変更。端末内 localStorage に保存）
const DEFAULT_SETTINGS = {
  levelOriginal: 0.7,  // 原音の再生レベル
  levelHarmony: 0.9,   // ハモリ各本の再生レベル（ハモリが少し目立つ既定）
  drumLevel: 0.8,      // ドラムの音量
  drumTune: 1,         // ドラムの高さ倍率（0.6〜1.6）
  cymbalLevel: 0.8,    // シンバルの音量
  cymbalDecay: 1,      // シンバルの余韻倍率（0.4〜2.5）
  presetIds: DEFAULT_PRESET_IDS.slice(),
};

const PRESET_BY_ID = Object.fromEntries(HARMONY_PRESETS.map((p) => [p.id, p]));

const $ = (id) => document.getElementById(id);
const el = {
  screenMain: $('screen-main'),
  btnRecord: $('btn-record'),
  btnPlay: $('btn-play'),
  btnSettings: $('btn-settings'),
  btnLibrary: $('btn-library'),
  btnLibraryBack: $('btn-library-back'),
  btnFavorite: $('btn-favorite'),
  screenLibrary: $('screen-library'),
  libraryList: $('library-list'),
  speeds: $('speeds'),
  meter: $('meter-bar'),
  timer: $('timer'),
  hint: $('record-hint'),
  canvas: $('pitch-canvas'),
  switches: $('switches'),
  busy: $('busy'),
  busyText: $('busy-text'),
  error: $('error'),
  settings: $('settings'),
  settingsClose: $('settings-close'),
  settingsReset: $('settings-reset'),
  levelOriginal: $('level-original'),
  levelHarmony: $('level-harmony'),
  levelOriginalValue: $('level-original-value'),
  levelHarmonyValue: $('level-harmony-value'),
  presetList: $('preset-list'),
  btnDrums: $('btn-drums'),
  screenDrums: $('screen-drums'),
  drumsHint: $('drums-hint'),
  drumTimeline: $('drum-timeline'),
  kit: $('kit'),
  btnDrumsDone: $('btn-drums-done'),
  btnDrumsRec: $('btn-drums-rec'),
  btnDrumsPlay: $('btn-drums-play'),
  btnDrumsUndo: $('btn-drums-undo'),
  btnDrumsClear: $('btn-drums-clear'),
};

const state = {
  ctx: null,
  workletReady: false,
  settings: loadSettings(),
  // 録音
  recording: false,
  stream: null,
  recNode: null,
  srcNode: null,
  analyser: null,
  chunks: [],
  recStart: 0,
  timerId: 0,
  // 解析結果
  pcm: null,
  sampleRate: 0,
  track: null,
  marks: null,
  duration: 0,
  takeId: null,          // 保存済みテイクの id（保存失敗時は null）
  takeFavorite: false,
  speed: 1,              // 再生スピード（音程は変えない時間伸縮）
  buffers: {},           // speedKey → { original: AudioBuffer, harmonies: { id → AudioBuffer } }
  enabled: loadEnabled(), // id → bool（スイッチ状態。端末に保存し、録音をまたいで保持）
  // 再生
  playing: false,
  sources: [],
  gains: {},
  playStart: 0,      // ctx.currentTime 基準の開始時刻
  playOffset: 0,     // 開始位置（伸縮後の秒）
  live: [],          // 録音中のリアルタイムピッチ [{t, f}]
  liveRange: null,
  drumEvents: [],    // 打ち込んだドラム {t: 元の録音上の秒, type: KIT の type, source, pass}
  recStartCtx: 0,
  liveDrumBus: null,
  playDrumBus: null,
  overdub: false,    // ドラム画面で録音（打ち込み）中
  drumScreen: false, // ドラム画面を開いている
  drumPass: 0,       // 何回目の打ち込みか（「もどす」の単位）
  harmonySrc: null,  // ドラムの回り込みを除いた、解析・ハモリ用の信号
  viewTime: 0,       // 停止中に表示している「いま」の時刻
  liveTail: new Float32Array(0),
  rafId: 0,
};

const SPEEDS = [
  { value: 0.6, label: '🐢 ゆっくり' },
  { value: 1, label: 'ふつう' },
  { value: 1.5, label: '🐇 はやい' },
];
const speedKey = (v) => String(v);
const playDuration = () => state.duration / state.speed;

// ---------- 設定 ----------
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const s = JSON.parse(raw);
    const presetIds = Array.isArray(s.presetIds) ? s.presetIds.filter((id) => PRESET_BY_ID[id]) : DEFAULT_SETTINGS.presetIds.slice();
    return {
      levelOriginal: clamp01(s.levelOriginal, DEFAULT_SETTINGS.levelOriginal),
      levelHarmony: clamp01(s.levelHarmony, DEFAULT_SETTINGS.levelHarmony),
      // v0.7.0 の levelDrums（共通音量）があれば両方の初期値に引き継ぐ
      drumLevel: clamp01(s.drumLevel ?? s.levelDrums, DEFAULT_SETTINGS.drumLevel),
      drumTune: clampRange(s.drumTune, 0.6, 1.6, DEFAULT_SETTINGS.drumTune),
      cymbalLevel: clamp01(s.cymbalLevel ?? s.levelDrums, DEFAULT_SETTINGS.cymbalLevel),
      cymbalDecay: clampRange(s.cymbalDecay, 0.4, 2.5, DEFAULT_SETTINGS.cymbalDecay),
      presetIds: presetIds.length ? presetIds : DEFAULT_SETTINGS.presetIds.slice(),
    };
  } catch (_) {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function loadEnabled() {
  try {
    const raw = localStorage.getItem(ENABLED_KEY);
    const o = raw ? JSON.parse(raw) : {};
    return o && typeof o === 'object' ? o : {};
  } catch (_) { return {}; }
}
function saveEnabled() {
  try { localStorage.setItem(ENABLED_KEY, JSON.stringify(state.enabled)); } catch (_) { /* noop */ }
}

function clampRange(v, lo, hi, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

function clamp01(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1.5, Math.max(0, n)) : fallback;
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)); } catch (_) { /* 保存不可でも動作は続ける */ }
}

function activePresets() {
  return state.settings.presetIds.map((id) => PRESET_BY_ID[id]).filter(Boolean);
}

// ---------- 共通 ----------
function showError(msg) {
  el.error.textContent = msg;
  el.error.hidden = false;
  clearTimeout(showError._t);
  showError._t = setTimeout(() => { el.error.hidden = true; }, 6000);
}

function setBusy(on, text) {
  if (text) el.busyText.textContent = text;
  el.busy.hidden = !on;
}

const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

function showScreen(name) {
  // メインは常時表示。きろくはシートとして重ねる
  el.screenLibrary.hidden = name !== 'library';
}

async function ensureContext() {
  if (!state.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    state.ctx = new AC();
  }
  if (state.ctx.state !== 'running') await state.ctx.resume();
  if (!state.workletReady && state.ctx.audioWorklet) {
    try {
      await state.ctx.audioWorklet.addModule('./recorder-worklet.js');
      state.workletReady = true;
    } catch (e) {
      console.warn('AudioWorklet unavailable, fallback to ScriptProcessor', e);
    }
  }
  return state.ctx;
}

// ---------- 録音 ----------
async function startRecording() {
  if (state.recording) return;
  stopPlayback();
  let ctx;
  try {
    ctx = await ensureContext();
  } catch (e) {
    showError('おとの じゅんびが できませんでした');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      video: false,
    });
  } catch (e) {
    showError('マイクが つかえません。設定で マイクを ゆるしてね');
    return;
  }
  state.stream = stream;
  state.chunks = [];
  state.sampleRate = ctx.sampleRate;
  state.srcNode = ctx.createMediaStreamSource(stream);
  state.analyser = ctx.createAnalyser();
  state.analyser.fftSize = 1024;
  state.srcNode.connect(state.analyser);

  const silent = ctx.createGain();
  silent.gain.value = 0;
  silent.connect(ctx.destination);

  if (state.workletReady) {
    const node = new AudioWorkletNode(ctx, 'recorder-processor', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    node.port.onmessage = (e) => { if (state.recording) { state.chunks.push(e.data); pushLiveTail(e.data); } };
    state.srcNode.connect(node);
    node.connect(silent);
    state.recNode = node;
  } else {
    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => { if (state.recording) { const c = new Float32Array(e.inputBuffer.getChannelData(0)); state.chunks.push(c); pushLiveTail(c); } };
    state.srcNode.connect(node);
    node.connect(silent);
    state.recNode = node;
  }

  state.recording = true;
  state.recStart = performance.now();
  state.recStartCtx = ctx.currentTime;
  state.drumEvents = [];
  state.live = [];
  state.liveRange = null;
  state.liveTail = new Float32Array(0);
  el.btnRecord.classList.add('recording');
  el.btnPlay.disabled = true;
  el.btnDrums.disabled = true;
  el.hint.textContent = 'うたったら もういちど おしてね';
  tickRecording();
}

function tickRecording() {
  if (!state.recording) return;
  const sec = (performance.now() - state.recStart) / 1000;
  el.timer.textContent = Math.floor(sec);
  const buf = new Uint8Array(state.analyser.fftSize);
  state.analyser.getByteTimeDomainData(buf);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
  el.meter.style.width = `${Math.min(100, peak * 160)}%`;
  // リアルタイムのピッチ（直近 50 ms 分だけ解析して 1 点追加）
  if (state.liveTail.length >= LIVE_WINDOW) {
    const slice = state.liveTail.subarray(state.liveTail.length - LIVE_WINDOW);
    const r = detectPitch(slice, state.sampleRate);
    const f = r.f0.length ? r.f0[r.f0.length - 1] : 0;
    state.live.push({ t: sec, f });
    drawCanvas();
  }
  if (sec >= MAX_SECONDS) { stopRecording(); return; }
  state.timerId = requestAnimationFrame(tickRecording);
}

const LIVE_WINDOW = 4096;  // 48 kHz で約 85 ms（解析用 16 kHz に間引いて 1 フレーム分）
function pushLiveTail(chunk) {
  const keep = LIVE_WINDOW * 2;
  const merged = new Float32Array(Math.min(keep, state.liveTail.length + chunk.length));
  const fromTail = Math.max(0, merged.length - chunk.length);
  merged.set(state.liveTail.subarray(state.liveTail.length - fromTail), 0);
  merged.set(chunk.subarray(Math.max(0, chunk.length - merged.length)), fromTail);
  state.liveTail = merged;
}

async function stopRecording() {
  if (!state.recording) return;
  state.recording = false;
  cancelAnimationFrame(state.timerId);
  el.btnRecord.classList.remove('recording');
  el.meter.style.width = '0%';
  el.btnPlay.disabled = !currentSet();
  el.btnDrums.disabled = !currentSet();
  try { state.recNode.port?.postMessage('stop'); } catch (_) { /* ScriptProcessor */ }
  try { state.srcNode.disconnect(); state.recNode.disconnect(); state.analyser.disconnect(); } catch (_) { /* noop */ }
  state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;

  const total = state.chunks.reduce((s, c) => s + c.length, 0);
  const pcm = new Float32Array(total);
  let o = 0;
  for (const c of state.chunks) { pcm.set(c, o); o += c.length; }
  state.chunks = [];

  if (pcm.length < MIN_SECONDS * state.sampleRate) {
    el.hint.textContent = 'もうすこし ながく うたってみてね';
    el.timer.textContent = '0';
    state.live = [];
    drawCanvas();
    return;
  }
  const fade = Math.min(Math.round(0.01 * state.sampleRate), Math.floor(pcm.length / 4));
  for (let i = 0; i < fade; i++) { pcm[i] *= i / fade; pcm[pcm.length - 1 - i] *= i / fade; }

  state.pcm = pcm;
  state.duration = pcm.length / state.sampleRate;
  // スイッチ状態は引き継ぐ（録音のたびにリセットしない）
  state.takeId = null;
  state.takeFavorite = false;
  try {
    state.takeId = await saveTake({ pcm, sampleRate: state.sampleRate, duration: state.duration, enabled: state.enabled, drums: state.drumEvents });
  } catch (e) {
    console.warn('save failed', e);
  }
  await processRecording();
}

// ---------- 解析・生成 ----------
async function processRecording(autoplay = false) {
  setBusy(true, 'こえを しらべているよ…');
  await yieldToUI();
  const { pcm, sampleRate, ctx } = state;
  const t0 = performance.now();
  // 同時録音で入ったドラム・シンバルの音を除いてから解析・ハモリ生成する（原音の再生には元の録音を使う）
  state.harmonySrc = cleanDrumBleed(pcm, sampleRate, state.drumEvents);
  state.track = maskDrumPitch(detectPitch(state.harmonySrc, sampleRate), state.drumEvents);
  state.marks = buildPitchMarks(state.harmonySrc, sampleRate, state.track);
  state.buffers = {};
  state.speed = 1;
  await yieldToUI();

  setBusy(true, 'はもりを つくっているよ…');
  await ensureBuffers();
  console.log(`processing: ${(performance.now() - t0).toFixed(0)} ms for ${state.duration.toFixed(1)} s`);

  setBusy(false);
  buildSwitches();
  buildSpeeds();
  updateFavoriteButton();
  el.btnPlay.disabled = false;
  el.btnDrums.disabled = false;
  el.hint.textContent = 'スイッチを おして、▶ で きいてね';
  state.live = [];
  showScreen('main');
  drawCanvas();
  if (autoplay) startPlayback(0);
}

/** 現在のスピードについて、原音と設定で選ばれているハモリのうち未生成のものを生成する */
async function ensureBuffers() {
  const { pcm, sampleRate, ctx } = state;
  const stretch = 1 / state.speed;
  const key = speedKey(state.speed);
  if (!state.buffers[key]) state.buffers[key] = { original: null, harmonies: {} };
  const set = state.buffers[key];
  if (!set.original) {
    // ふつう（1.0）は原音そのまま。それ以外は音程を変えずに時間伸縮
    const y = stretch === 1 ? pcm : pitchShiftPSOLA(pcm, sampleRate, state.track, 0, state.marks, stretch);
    set.original = toAudioBuffer(ctx, y, sampleRate);
    await yieldToUI();
  }
  for (const p of activePresets()) {
    if (set.harmonies[p.id]) continue;
    const y = pitchShiftPSOLA(state.harmonySrc || pcm, sampleRate, state.track, p.semitones, state.marks, stretch);
    matchLoudness(pcm, y);
    set.harmonies[p.id] = toAudioBuffer(ctx, y, sampleRate);
    await yieldToUI();
  }
}

function currentSet() { return state.buffers[speedKey(state.speed)]; }

function toAudioBuffer(ctx, data, sampleRate) {
  const buf = ctx.createBuffer(1, data.length, sampleRate);
  buf.copyToChannel(data, 0);
  return buf;
}

// ---------- 再生 ----------
function startPlayback(offset = 0) {
  const ctx = state.ctx;
  const set = currentSet();
  if (!set || !set.original) return;
  stopPlayback(true);
  const dur = playDuration();
  offset = Math.max(0, Math.min(dur - 0.05, offset));
  const master = ctx.createGain();
  master.gain.value = 1;
  // 最終段はリミッター相当（重ね合わせ時の音割れ防止。通常の音量では動作しない）
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -3;
  comp.knee.value = 2;
  comp.ratio.value = 12;
  comp.attack.value = 0.003;
  comp.release.value = 0.15;
  master.connect(comp);
  comp.connect(ctx.destination);

  const when = ctx.currentTime + 0.08;
  state.gains = {};
  state.sources = [];
  const addVoice = (id, buffer, level) => {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = level;
    src.connect(g);
    g.connect(master);
    src.start(when, offset);
    state.sources.push(src);
    state.gains[id] = g;
    return src;
  };
  const main = addVoice('original', set.original, state.settings.levelOriginal);
  for (const p of activePresets()) {
    const buf = set.harmonies[p.id];
    if (buf) addVoice(p.id, buf, state.enabled[p.id] ? state.settings.levelHarmony : 0);
  }
  main.onended = () => { if (state.playing && state.sources.includes(main)) stopPlayback(); };

  // 打ち込んだドラムを、合成音で同じタイミングに鳴らす
  const dbus = ctx.createGain();
  dbus.gain.value = 1;
  dbus.connect(master);
  state.playDrumBus = dbus;
  for (const ev of state.drumEvents) {
    const tt = ev.t / state.speed;
    if (tt >= offset - 0.001 && tt < dur) playHit(ctx, dbus, ev.type, when + (tt - offset), hitOpts(ev.type));
  }

  state.playing = true;
  state.playStart = when;
  state.playOffset = offset;
  el.btnPlay.classList.add('playing');
  el.btnPlay.querySelector('span').textContent = '■';
  updateDrumButtons();
  animatePlayhead();
}

function stopPlayback(silent = false) {
  if (!state.playing) return;
  state.playing = false;
  cancelAnimationFrame(state.rafId);
  for (const s of state.sources) { try { s.onended = null; s.stop(); } catch (_) { /* already stopped */ } }
  state.sources = [];
  state.gains = {};
  if (state.playDrumBus) { try { state.playDrumBus.disconnect(); } catch (_) { /* noop */ } state.playDrumBus = null; }
  el.btnPlay.classList.remove('playing');
  el.btnPlay.querySelector('span').textContent = '▶';
  state.viewTime = 0;
  if (!silent) { drawCanvas(); if (state.overdub) finishOverdub(); updateDrumButtons(); drawDrumTimeline(); }
}

function playheadTime() {
  return state.playOffset + (state.ctx.currentTime - state.playStart);
}

function animatePlayhead() {
  if (!state.playing) return;
  if (state.drumScreen) drawDrumTimeline(); else drawCanvas();
  state.rafId = requestAnimationFrame(animatePlayhead);
}

/** 曲線をドラッグすると時間が動き（指で曲線を送る）、タップするとカーソル位置から再生 */
let scrub = null;
el.canvas.addEventListener('pointerdown', (e) => {
  if (!currentSet() || state.recording) return;
  e.preventDefault();
  el.canvas.setPointerCapture(e.pointerId);
  const wasPlaying = state.playing;
  const t0 = wasPlaying ? playheadTime() : state.viewTime;
  if (wasPlaying) stopPlayback(true);
  scrub = { x0: e.clientX, t0, moved: false, wasPlaying, last: 0 };
  state.viewTime = t0;
  drawCanvas();
});
el.canvas.addEventListener('pointermove', (e) => {
  if (!scrub) return;
  const rect = el.canvas.getBoundingClientRect();
  const dx = e.clientX - scrub.x0;
  if (Math.abs(dx) > 6) scrub.moved = true;
  if (!scrub.moved) return;
  const t = Math.max(0, Math.min(playDuration() - 0.05, scrub.t0 - (dx / rect.width) * VIEW_SECONDS));
  state.viewTime = t;
  drawCanvas();
  // 送りながら音も鳴らす（120 ms 間隔で短く）
  const now = performance.now();
  if (now - scrub.last > 120) { scrub.last = now; startPlayback(t); state.playing && stopPlaybackSoon(); }
});
function stopPlaybackSoon() {
  clearTimeout(stopPlaybackSoon._t);
  stopPlaybackSoon._t = setTimeout(() => { if (scrub && state.playing) { const t = playheadTime(); stopPlayback(true); state.viewTime = t; drawCanvas(); } }, 140);
}
const endScrub = () => {
  if (!scrub) return;
  const s = scrub; scrub = null;
  clearTimeout(stopPlaybackSoon._t);
  if (state.playing) stopPlayback(true);
  if (!s.moved) startPlayback(s.t0);          // タップ: カーソル位置から再生
  else if (s.wasPlaying) startPlayback(state.viewTime); // 再生中に送った: その位置から再開
  else drawCanvas();
};
el.canvas.addEventListener('pointerup', endScrub);
el.canvas.addEventListener('pointercancel', endScrub);

// ---------- スピード ----------
function buildSpeeds() {
  el.speeds.innerHTML = '';
  for (const sp of SPEEDS) {
    const b = document.createElement('button');
    b.className = 'speed' + (sp.value === state.speed ? ' on' : '');
    b.textContent = sp.label;
    b.addEventListener('click', () => setSpeed(sp.value));
    el.speeds.appendChild(b);
  }
}

async function setSpeed(value) {
  if (value === state.speed) return;
  // 再生中なら同じ位置（元の録音上の位置）から続ける
  const wasPlaying = state.playing;
  const posOriginal = wasPlaying ? playheadTime() * state.speed : 0;
  if (wasPlaying) stopPlayback(true);
  state.speed = value;
  buildSpeeds();
  if (!currentSet() || !currentSet().original) {
    setBusy(true, 'スピードを かえているよ…');
    await yieldToUI();
    await ensureBuffers();
    setBusy(false);
  }
  state.viewTime = 0;
  drawCanvas();
  if (wasPlaying) startPlayback(posOriginal / state.speed);
}

function toggleHarmony(id) {
  state.enabled[id] = !state.enabled[id];
  saveEnabled();
  if (state.takeId) updateEnabled(state.takeId, state.enabled).catch(() => {});
  const btn = el.switches.querySelector(`[data-id="${id}"]`);
  if (btn) btn.classList.toggle('on', state.enabled[id]);
  if (state.playing && state.gains[id]) {
    state.gains[id].gain.setTargetAtTime(state.enabled[id] ? state.settings.levelHarmony : 0, state.ctx.currentTime, 0.02);
  }
  if (!state.playing) drawCanvas();
}

/** 設定の音量変更を再生中にも反映する */
function applyLevelsLive() {
  if (!state.playing) return;
  const now = state.ctx.currentTime;
  if (state.gains.original) state.gains.original.gain.setTargetAtTime(state.settings.levelOriginal, now, 0.02);
  for (const p of activePresets()) {
    const g = state.gains[p.id];
    if (g) g.gain.setTargetAtTime(state.enabled[p.id] ? state.settings.levelHarmony : 0, now, 0.02);
  }
}

// ---------- 可視化（横に流れるピッチ曲線） ----------
const VIEW_SECONDS = 4;      // 画面に見える時間幅
const CURSOR_RATIO = 0.35;   // 「いま」の位置（左から 35%）
const F_LO_DEFAULT = 150, F_HI_DEFAULT = 800;

/** 表示する周波数レンジ（対数）。曲線が画面いっぱいに大きく見えるように絞る */
function computeRange() {
  let vals = [];
  if (state.recording) vals = state.live.filter((p) => p.f > 0).map((p) => p.f);
  else if (state.track) vals = Array.from(state.track.f0).filter((f) => f > 0);
  if (vals.length < 5) return { lo: F_LO_DEFAULT, hi: F_HI_DEFAULT };
  vals.sort((x, y) => x - y);
  let lo = vals[Math.floor(vals.length * 0.05)];
  let hi = vals[Math.floor(vals.length * 0.95)];
  // ON のハモリの分だけ広げる
  if (!state.recording) {
    let minShift = 0, maxShift = 0;
    for (const p of activePresets()) if (state.enabled[p.id]) { minShift = Math.min(minShift, p.semitones); maxShift = Math.max(maxShift, p.semitones); }
    lo *= Math.pow(2, minShift / 12);
    hi *= Math.pow(2, maxShift / 12);
  }
  // 余白 2 半音、最小幅 12 半音
  lo *= Math.pow(2, -2 / 12); hi *= Math.pow(2, 2 / 12);
  const span = Math.log2(hi / lo);
  if (span < 1) { const c = Math.sqrt(lo * hi); lo = c / Math.SQRT2; hi = c * Math.SQRT2; }
  // 録音中はレンジが縮まないようにする（線が揺れないため）
  if (state.recording && state.liveRange) {
    lo = Math.min(lo, state.liveRange.lo); hi = Math.max(hi, state.liveRange.hi);
    state.liveRange = { lo, hi };
  } else if (state.recording) state.liveRange = { lo, hi };
  return { lo, hi };
}

function makeYOf(range, H) {
  const l = Math.log2(range.lo), h = Math.log2(range.hi);
  return (f) => H - ((Math.log2(f) - l) / (h - l)) * H;
}

/** 現在の「いま」の時刻（表示用）。録音中は経過秒、再生中は再生位置、停止中は viewTime */
function nowTime() {
  if (state.recording) return (performance.now() - state.recStart) / 1000;
  if (state.playing) return playheadTime();
  return state.viewTime;
}

function drawCanvas() {
  const cv = el.canvas;
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);

  const range = computeRange();
  const yOf = makeYOf(range, H);
  const now = nowTime();
  const t0 = now - VIEW_SECONDS * CURSOR_RATIO;
  const xOf = (t) => ((t - t0) / VIEW_SECONDS) * W;

  // 半音ごとの薄い横線、オクターブ（C 相当）は少し濃く
  const semLo = Math.ceil(12 * Math.log2(range.lo / 16.3516)), semHi = Math.floor(12 * Math.log2(range.hi / 16.3516));
  for (let s = semLo; s <= semHi; s++) {
    const f = 16.3516 * Math.pow(2, s / 12);
    g.strokeStyle = s % 12 === 0 ? 'rgba(0,0,0,0.12)' : 'rgba(0,0,0,0.04)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, yOf(f)); g.lineTo(W, yOf(f)); g.stroke();
  }
  // 過去側をうっすら
  g.fillStyle = 'rgba(0,0,0,0.025)';
  g.fillRect(0, 0, W * CURSOR_RATIO, H);

  const drawPolyline = (points, color, width) => {
    g.strokeStyle = color; g.lineWidth = width; g.lineCap = 'round'; g.lineJoin = 'round';
    g.beginPath();
    let pen = false;
    for (const pt of points) {
      if (pt.f <= 0) { pen = false; continue; }
      const x = xOf(pt.t);
      if (x < -20 || x > W + 20) { pen = false; continue; }
      const y = yOf(pt.f);
      if (!pen) { g.moveTo(x, y); pen = true; } else g.lineTo(x, y);
    }
    g.stroke();
  };

  if (state.recording) {
    drawPolyline(state.live, '#ff6b6b', 14);
  } else if (state.track && state.track.f0.length) {
    const tr = state.track;
    const stretch = 1 / state.speed;
    const pts = (k) => {
      const arr = [];
      for (let i = 0; i < tr.f0.length; i++) arr.push({ t: tr.times[i] * stretch, f: tr.f0[i] * k });
      return arr;
    };
    for (const p of activePresets()) if (state.enabled[p.id]) drawPolyline(pts(Math.pow(2, p.semitones / 12)), p.color, 9);
    drawPolyline(pts(1), '#3a2e1f', 14);
  }

  // ドラムの印（シンバル類は上、太鼓類は下。色は楽器ごと）
  if (!state.recording) {
    for (const ev of state.drumEvents) {
      const x = xOf(ev.t / state.speed);
      if (x < -20 || x > W + 20) continue;
      const k = kitOf(ev.type);
      g.fillStyle = k.color;
      g.beginPath(); g.arc(x, k.family === 'cymbal' ? 22 : H - 22, 12, 0, Math.PI * 2); g.fill();
    }
  }

  // 「いま」のカーソル
  const cx = W * CURSOR_RATIO;
  g.strokeStyle = state.recording ? 'rgba(255,59,59,0.9)' : 'rgba(78,205,196,0.95)';
  g.lineWidth = 5;
  g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, H); g.stroke();
}

// ---------- UI 組み立て ----------
function buildSwitches() {
  el.switches.innerHTML = '';
  for (const p of activePresets()) {
    const btn = document.createElement('button');
    btn.className = 'switch' + (state.enabled[p.id] ? ' on' : '');
    btn.dataset.id = p.id;
    btn.style.setProperty('--lamp', p.color);
    btn.innerHTML = `<span class="icon">${p.icon}</span><span class="label">${p.label}</span><span class="lamp"></span>`;
    btn.addEventListener('click', () => toggleHarmony(p.id));
    el.switches.appendChild(btn);
  }
}

// ---------- 設定パネル ----------
function openSettings() {
  el.levelOriginal.value = Math.round(state.settings.levelOriginal * 100);
  el.levelHarmony.value = Math.round(state.settings.levelHarmony * 100);
  for (const s of DRUM_SLIDERS) { s.el.value = Math.round(state.settings[s.key] * 100); s.out.textContent = s.el.value; }
  el.levelOriginalValue.textContent = el.levelOriginal.value;
  el.levelHarmonyValue.textContent = el.levelHarmony.value;
  el.presetList.innerHTML = '';
  for (const p of HARMONY_PRESETS) {
    const label = document.createElement('label');
    label.className = 'preset-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = p.id;
    cb.checked = state.settings.presetIds.includes(p.id);
    cb.addEventListener('change', onPresetChange);
    label.appendChild(cb);
    label.insertAdjacentHTML('beforeend', ` <span class="icon">${p.icon}</span> ${p.label} <small>(${p.semitones > 0 ? '+' : ''}${p.semitones} 半音)</small>`);
    el.presetList.appendChild(label);
  }
  el.settings.hidden = false;
}

function onPresetChange() {
  const ids = Array.from(el.presetList.querySelectorAll('input:checked')).map((c) => c.value);
  // カタログ順を保つ
  state.settings.presetIds = HARMONY_PRESETS.map((p) => p.id).filter((id) => ids.includes(id));
  saveSettings();
}

async function closeSettings() {
  el.settings.hidden = true;
  if (state.settings.presetIds.length === 0) {
    state.settings.presetIds = DEFAULT_SETTINGS.presetIds.slice();
    saveSettings();
  }
  if (state.pcm) {
    const wasPlaying = state.playing;
    if (wasPlaying) stopPlayback();
    const set = currentSet();
    const missing = !set || activePresets().some((p) => !set.harmonies[p.id]);
    if (missing) { setBusy(true, 'はもりを つくっているよ…'); await yieldToUI(); await ensureBuffers(); setBusy(false); }
    buildSwitches();
    drawCanvas();
    if (wasPlaying) startPlayback();
  }
}

el.levelOriginal.addEventListener('input', () => {
  state.settings.levelOriginal = Number(el.levelOriginal.value) / 100;
  el.levelOriginalValue.textContent = el.levelOriginal.value;
  saveSettings();
  applyLevelsLive();
});
// ドラム・シンバルの設定（大きさ・音色）。指を離したときに試し打ちする
const DRUM_SLIDERS = [
  { key: 'drumLevel', id: 'drum-level', type: 'snare' },
  { key: 'drumTune', id: 'drum-tune', type: 'tomMid' },
  { key: 'cymbalLevel', id: 'cymbal-level', type: 'crash' },
  { key: 'cymbalDecay', id: 'cymbal-decay', type: 'crash' },
].map((s) => ({ ...s, el: $(s.id), out: $(s.id + '-value') }));
for (const s of DRUM_SLIDERS) {
  s.el.addEventListener('input', () => {
    state.settings[s.key] = Number(s.el.value) / 100;
    s.out.textContent = s.el.value;
    saveSettings();
  });
  s.el.addEventListener('change', async () => {
    try { const ctx = await ensureContext(); playHit(ctx, liveDrumBus(ctx), s.type, ctx.currentTime, hitOpts(s.type)); } catch (_) { /* noop */ }
  });
}

el.levelHarmony.addEventListener('input', () => {
  state.settings.levelHarmony = Number(el.levelHarmony.value) / 100;
  el.levelHarmonyValue.textContent = el.levelHarmony.value;
  saveSettings();
  applyLevelsLive();
});
el.settingsReset.addEventListener('click', () => {
  state.settings = structuredClone(DEFAULT_SETTINGS);
  saveSettings();
  applyLevelsLive();
  openSettings();
});
el.settingsClose.addEventListener('click', closeSettings);
el.btnSettings.addEventListener('click', openSettings);

el.btnRecord.addEventListener('click', () => { state.recording ? stopRecording() : startRecording(); });
el.btnPlay.addEventListener('click', () => { state.playing ? stopPlayback() : startPlayback(0); });

document.addEventListener('visibilitychange', () => { if (document.hidden) { stopPlayback(); if (state.recording) stopRecording(); } });

// ---------- きろく（保存・一覧） ----------
function updateFavoriteButton() {
  el.btnFavorite.textContent = state.takeFavorite ? '★' : '☆';
  el.btnFavorite.classList.toggle('on', state.takeFavorite);
  el.btnFavorite.disabled = !state.takeId;
}

async function toggleFavorite() {
  if (!state.takeId) return;
  const next = !state.takeFavorite;
  try {
    const ok = await setFavorite(state.takeId, next);
    if (!ok && next) { showError(`おきにいりは ${FAVORITE_MAX} こまで。どれか ★ を はずしてね`); return; }
    state.takeFavorite = next;
    updateFavoriteButton();
  } catch (e) {
    showError('ほぞんが できませんでした');
  }
}

function formatDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function openLibrary() {
  stopPlayback();
  showScreen('library');
  el.libraryList.innerHTML = '';
  let takes = [];
  try { takes = await listTakes(); } catch (e) { showError('きろくを ひらけませんでした'); }
  if (takes.length === 0) {
    el.libraryList.innerHTML = '<div class="library-empty">まだ きろくが ないよ。うたってみよう！</div>';
    return;
  }
  const favs = takes.filter((t) => t.favorite);
  const recents = takes.filter((t) => !t.favorite);
  const addSection = (title, items) => {
    if (items.length === 0) return;
    const h = document.createElement('div');
    h.className = 'library-section';
    h.textContent = title;
    el.libraryList.appendChild(h);
    for (const t of items) el.libraryList.appendChild(renderTake(t));
  };
  addSection('★ おきにいり', favs);
  addSection('さいきん', recents);
}

function renderTake(t) {
  const row = document.createElement('div');
  row.className = 'take';
  row.dataset.id = t.id;
  const on = Object.values(t.enabled || {}).filter(Boolean).length;
  row.innerHTML = `
    <button class="play-small" aria-label="きく">▶</button>
    <div class="meta"><span>${formatDate(t.createdAt)}</span><small>${Math.round(t.duration)} びょう ・ ハモリ ${on} こ</small></div>
    <button class="fav" aria-label="おきにいり">${t.favorite ? '★' : '☆'}</button>
    <button class="del" aria-label="けす">🗑</button>`;
  // 行のどこを押しても即再生（★・🗑 は除く）
  row.addEventListener('click', (e) => { if (e.target.closest('.fav, .del')) return; loadTake(t.id); });
  row.querySelector('.fav').addEventListener('click', async (e) => {
    const next = !t.favorite;
    const ok = await setFavorite(t.id, next).catch(() => false);
    if (!ok && next) { showError(`おきにいりは ${FAVORITE_MAX} こまで`); return; }
    if (state.takeId === t.id) { state.takeFavorite = next; updateFavoriteButton(); }
    openLibrary();
  });
  row.querySelector('.del').addEventListener('click', async () => {
    // 削除は保護者の操作を想定（確認ダイアログ）
    if (!window.confirm('この きろくを けしますか？（もとに もどせません）')) return;
    await deleteTake(t.id).catch(() => {});
    if (state.takeId === t.id) { state.takeId = null; state.takeFavorite = false; }
    openLibrary();
  });
  return row;
}

async function loadTake(id) {
  let take;
  try { take = await getTake(id); } catch (e) { take = null; }
  if (!take) { showError('この きろくは ひらけませんでした'); return; }
  try { await ensureContext(); } catch (_) { showError('おとの じゅんびが できませんでした'); return; }
  state.pcm = take.pcm;
  state.sampleRate = take.sampleRate;
  state.duration = take.duration;
  const saved = take.enabled || {};
  if (Object.values(saved).some(Boolean)) state.enabled = { ...saved };
  saveEnabled();
  state.takeId = take.id;
  state.takeFavorite = !!take.favorite;
  state.drumEvents = Array.isArray(take.drums) ? take.drums : [];
  await processRecording(true);
}

el.btnFavorite.addEventListener('click', toggleFavorite);
el.btnLibrary.addEventListener('click', openLibrary);
el.btnLibraryBack.addEventListener('click', () => showScreen('main'));

// ---------- ドラム（声の録音のあとで、ドラム画面で打ち込む） ----------
/** 設定から 1 打分の音量・音色を作る */
function hitOpts(type) {
  const s = state.settings;
  return kitOf(type).family === 'cymbal' ? { level: s.cymbalLevel, decay: s.cymbalDecay } : { level: s.drumLevel, tune: s.drumTune };
}
/** ドラムセット・試し打ち用の出力（リミッター付き） */
function liveDrumBus(ctx) {
  if (!state.liveDrumBus) {
    state.liveDrumBus = ctx.createGain();
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 2; lim.ratio.value = 12; lim.attack.value = 0.002; lim.release.value = 0.1;
    state.liveDrumBus.connect(lim);
    lim.connect(ctx.destination);
  }
  return state.liveDrumBus;
}
/** ドラムセットの 1 か所を叩く。いつでも音が鳴り、録音中だけ記録する */
async function hitKit(type, node) {
  node.classList.add('hit');
  setTimeout(() => node.classList.remove('hit'), 90);
  let ctx;
  try { ctx = await ensureContext(); } catch (_) { return; }
  playHit(ctx, liveDrumBus(ctx), type, ctx.currentTime, hitOpts(type));
  if (state.overdub && state.playing) {
    // 聞こえている音に合わせて叩くので、出力の遅れ分を差し引く。t は元の録音上の秒
    const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    const t = Math.max(0, (playheadTime() - lat) * state.speed);
    if (t <= state.duration) state.drumEvents.push({ t, type, source: 'overdub', pass: state.drumPass });
  }
}

const hasOwnDrums = () => state.drumEvents.some((e) => e.source === 'overdub');

function openDrums() {
  if (!currentSet() || state.recording) return;
  stopPlayback();
  state.drumScreen = true;
  el.screenDrums.hidden = false;
  updateDrumButtons();
  drawDrumTimeline();
}

function closeDrums() {
  stopPlayback();            // 録音中なら finishOverdub まで行う
  state.drumScreen = false;
  el.screenDrums.hidden = true;
  drawCanvas();
}

/** ● ろくおん：歌を頭から流し、叩いた音を記録する。前に入れたドラムも一緒に鳴る（重ねられる） */
function startDrumRec() {
  if (!currentSet() || state.recording) return;
  if (state.playing) stopPlayback();
  state.drumPass = state.drumEvents.reduce((m, e) => Math.max(m, e.pass || 0), 0) + 1;
  state.overdub = true;
  startPlayback(0);
}

function finishOverdub() {
  if (!state.overdub) return;
  state.overdub = false;
  state.drumEvents.sort((a, b) => a.t - b.t);
  saveDrums();
}

function saveDrums() {
  if (state.takeId) updateDrums(state.takeId, state.drumEvents).catch(() => {});
}

function updateDrumButtons() {
  const rec = state.overdub;
  el.btnDrumsRec.classList.toggle('recording', rec);
  el.btnDrumsRec.querySelector('span').textContent = rec ? '■' : '●';
  const listening = state.playing && !rec;
  el.btnDrumsPlay.classList.toggle('playing', listening);
  el.btnDrumsPlay.querySelector('span').textContent = listening ? '■' : '▶';
  el.btnDrumsPlay.disabled = rec;
  el.btnDrumsUndo.disabled = rec || !hasOwnDrums();
  el.btnDrumsClear.disabled = rec || !hasOwnDrums();
  el.drumsHint.textContent = rec ? 'うたに あわせて たたこう！' : (hasOwnDrums() ? '● で もっと かさねる' : '● を おして たたこう');
}

/** ドラム画面のタイムライン：曲全体を横幅に収め、楽器ごとの段に叩いた位置を出す */
function drawDrumTimeline() {
  if (!state.drumScreen) return;
  const cv = el.drumTimeline;
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  const dur = state.duration || 1;
  const xOf = (t) => 10 + (t / dur) * (W - 20);

  // 声の高さ（うすく。どこで歌っているかの目安）
  const tr = state.track;
  if (tr && tr.f0.length) {
    let lo = Infinity, hi = 0;
    for (const f of tr.f0) if (f > 0) { lo = Math.min(lo, f); hi = Math.max(hi, f); }
    if (hi > 0) {
      const l = Math.log2(lo) - 0.1, h = Math.log2(hi) + 0.1;
      g.strokeStyle = 'rgba(58,46,31,0.18)'; g.lineWidth = 5; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath();
      let pen = false;
      for (let i = 0; i < tr.f0.length; i++) {
        const f = tr.f0[i];
        if (f <= 0) { pen = false; continue; }
        const x = xOf(tr.times[i]), y = H - 12 - ((Math.log2(f) - l) / (h - l)) * (H - 24);
        if (!pen) { g.moveTo(x, y); pen = true; } else g.lineTo(x, y);
      }
      g.stroke();
    }
  }

  // 楽器ごとの段
  const laneY = (i) => 14 + (i * (H - 28)) / (KIT.length - 1);
  for (const ev of state.drumEvents) {
    const k = kitOf(ev.type);
    g.fillStyle = k.color;
    g.beginPath(); g.arc(xOf(ev.t), laneY(KIT.indexOf(k)), 8, 0, Math.PI * 2); g.fill();
  }

  // 再生位置
  if (state.playing) {
    const x = xOf(Math.max(0, Math.min(dur, playheadTime() * state.speed)));
    g.strokeStyle = state.overdub ? 'rgba(255,59,59,0.9)' : 'rgba(78,205,196,0.95)';
    g.lineWidth = 5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  }
}

el.btnDrums.addEventListener('click', openDrums);
el.btnDrumsDone.addEventListener('click', closeDrums);
el.btnDrumsRec.addEventListener('click', () => { if (state.overdub) stopPlayback(); else startDrumRec(); });
el.btnDrumsPlay.addEventListener('click', () => { if (state.playing) stopPlayback(); else startPlayback(0); });
el.btnDrumsUndo.addEventListener('click', () => {
  // さいごの 1 回分（● から ■ まで）だけを取り消す
  const last = state.drumEvents.reduce((m, e) => (e.source === 'overdub' ? Math.max(m, e.pass || 0) : m), -1);
  if (last < 0) return;
  if (state.playing) stopPlayback();
  state.drumEvents = state.drumEvents.filter((e) => !(e.source === 'overdub' && (e.pass || 0) === last));
  saveDrums();
  updateDrumButtons();
  drawDrumTimeline();
});
el.btnDrumsClear.addEventListener('click', () => {
  if (!window.confirm('ドラムを ぜんぶ けしますか？（うたは のこります）')) return;
  if (state.playing) stopPlayback();
  state.drumEvents = state.drumEvents.filter((e) => e.source !== 'overdub');
  saveDrums();
  updateDrumButtons();
  drawDrumTimeline();
});
for (const node of el.kit.querySelectorAll('.kit-piece')) {
  node.addEventListener('pointerdown', (e) => { e.preventDefault(); hitKit(node.dataset.type, node); });
}

// ---------- バージョン表示 ----------
async function showVersion() {
  let text = `v${APP_VERSION}`;
  try {
    // 配信時に workflow が書き出す同一オリジンのファイル（ローカル実行時は無い）
    const res = await fetch('./build.json', { cache: 'no-store' });
    if (res.ok) {
      const b = await res.json();
      if (b.date) text += ` · ${b.date}`;
      if (b.sha) text += ` · ${String(b.sha).slice(0, 7)}`;
    }
  } catch (_) { /* ローカル実行など */ }
  $('version').textContent = text;
  $('version-settings').textContent = text;
}

buildSwitches();
showScreen('main');
showVersion();
