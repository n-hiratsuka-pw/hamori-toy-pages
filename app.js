// app.js — はもり（hamori-toy）メイン
// 録音 → ピッチ解析（pitch.js） → ハモリ生成（psola.js） → 重ね再生
// すべて端末内で完結し、外部へは何も送信しない。

import { detectPitch } from './pitch.js';
import { pitchShiftPSOLA, buildPitchMarks, matchLoudness, HARMONY_PRESETS, DEFAULT_PRESET_IDS } from './psola.js';

const MAX_SECONDS = 20;
const MIN_SECONDS = 0.5;
const SETTINGS_KEY = 'hamori.settings.v1';

// 設定の既定値（保護者用パネルで変更。端末内 localStorage に保存）
const DEFAULT_SETTINGS = {
  levelOriginal: 0.7,  // 原音の再生レベル
  levelHarmony: 0.9,   // ハモリ各本の再生レベル（ハモリが少し目立つ既定）
  presetIds: DEFAULT_PRESET_IDS.slice(),
};

const PRESET_BY_ID = Object.fromEntries(HARMONY_PRESETS.map((p) => [p.id, p]));

const $ = (id) => document.getElementById(id);
const el = {
  screenRecord: $('screen-record'),
  screenPlay: $('screen-play'),
  btnRecord: $('btn-record'),
  btnPlay: $('btn-play'),
  btnBack: $('btn-back'),
  btnSettings: $('btn-settings'),
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
  originalBuffer: null,
  harmonyBuffers: {},   // id → AudioBuffer（生成済みキャッシュ）
  enabled: {},          // id → bool（スイッチ状態）
  // 再生
  playing: false,
  sources: [],
  gains: {},
  playStart: 0,
  rafId: 0,
};

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
      presetIds: presetIds.length ? presetIds : DEFAULT_SETTINGS.presetIds.slice(),
    };
  } catch (_) {
    return structuredClone(DEFAULT_SETTINGS);
  }
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
  el.screenRecord.classList.toggle('active', name === 'record');
  el.screenPlay.classList.toggle('active', name === 'play');
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
    node.port.onmessage = (e) => { if (state.recording) state.chunks.push(e.data); };
    state.srcNode.connect(node);
    node.connect(silent);
    state.recNode = node;
  } else {
    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => { if (state.recording) state.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
    state.srcNode.connect(node);
    node.connect(silent);
    state.recNode = node;
  }

  state.recording = true;
  state.recStart = performance.now();
  el.btnRecord.classList.add('recording');
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
  if (sec >= MAX_SECONDS) { stopRecording(); return; }
  state.timerId = requestAnimationFrame(tickRecording);
}

async function stopRecording() {
  if (!state.recording) return;
  state.recording = false;
  cancelAnimationFrame(state.timerId);
  el.btnRecord.classList.remove('recording');
  el.meter.style.width = '0%';
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
    return;
  }
  const fade = Math.min(Math.round(0.01 * state.sampleRate), Math.floor(pcm.length / 4));
  for (let i = 0; i < fade; i++) { pcm[i] *= i / fade; pcm[pcm.length - 1 - i] *= i / fade; }

  state.pcm = pcm;
  state.duration = pcm.length / state.sampleRate;
  await processRecording();
}

// ---------- 解析・生成 ----------
async function processRecording() {
  setBusy(true, 'こえを しらべているよ…');
  await yieldToUI();
  const { pcm, sampleRate, ctx } = state;
  const t0 = performance.now();
  state.track = detectPitch(pcm, sampleRate);
  state.marks = buildPitchMarks(pcm, sampleRate, state.track);
  state.harmonyBuffers = {};
  state.originalBuffer = toAudioBuffer(ctx, pcm, sampleRate);
  await yieldToUI();

  setBusy(true, 'はもりを つくっているよ…');
  await ensureHarmonies();
  console.log(`processing: ${(performance.now() - t0).toFixed(0)} ms for ${state.duration.toFixed(1)} s`);

  setBusy(false);
  buildSwitches();
  showScreen('play');
  drawCanvas();
}

/** 設定で選ばれているハモリのうち未生成のものを生成する */
async function ensureHarmonies() {
  const { pcm, sampleRate, ctx } = state;
  for (const p of activePresets()) {
    if (state.harmonyBuffers[p.id]) continue;
    const y = pitchShiftPSOLA(pcm, sampleRate, state.track, p.semitones, state.marks);
    matchLoudness(pcm, y);
    state.harmonyBuffers[p.id] = toAudioBuffer(ctx, y, sampleRate);
    await yieldToUI();
  }
}

function toAudioBuffer(ctx, data, sampleRate) {
  const buf = ctx.createBuffer(1, data.length, sampleRate);
  buf.copyToChannel(data, 0);
  return buf;
}

// ---------- 再生 ----------
function startPlayback() {
  const ctx = state.ctx;
  if (!state.originalBuffer) return;
  stopPlayback();
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
    src.start(when);
    state.sources.push(src);
    state.gains[id] = g;
    return src;
  };
  const main = addVoice('original', state.originalBuffer, state.settings.levelOriginal);
  for (const p of activePresets()) {
    const buf = state.harmonyBuffers[p.id];
    if (buf) addVoice(p.id, buf, state.enabled[p.id] ? state.settings.levelHarmony : 0);
  }
  main.onended = () => { if (state.playing) stopPlayback(); };

  state.playing = true;
  state.playStart = when;
  el.btnPlay.classList.add('playing');
  el.btnPlay.querySelector('span').textContent = '■';
  animatePlayhead();
}

function stopPlayback() {
  if (!state.playing) return;
  state.playing = false;
  cancelAnimationFrame(state.rafId);
  for (const s of state.sources) { try { s.stop(); } catch (_) { /* already stopped */ } }
  state.sources = [];
  state.gains = {};
  el.btnPlay.classList.remove('playing');
  el.btnPlay.querySelector('span').textContent = '▶';
  drawCanvas();
}

function animatePlayhead() {
  if (!state.playing) return;
  drawCanvas(state.ctx.currentTime - state.playStart);
  state.rafId = requestAnimationFrame(animatePlayhead);
}

function toggleHarmony(id) {
  state.enabled[id] = !state.enabled[id];
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

// ---------- 可視化 ----------
const F_LO = 80, F_HI = 1600;
function yOf(f, h) {
  const r = (Math.log2(f) - Math.log2(F_LO)) / (Math.log2(F_HI) - Math.log2(F_LO));
  return h - r * h;
}

function drawCanvas(playhead = -1) {
  const cv = el.canvas;
  const g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);

  for (let f = 100; f < F_HI; f *= 2) {
    const y1 = yOf(f, H), y2 = yOf(f * 2, H);
    g.fillStyle = 'rgba(0,0,0,0.03)';
    g.fillRect(0, y2, W, y1 - y2);
  }

  const tr = state.track;
  if (!tr || tr.f0.length === 0) return;
  const dur = state.duration;
  const xOf = (t) => (t / dur) * W;

  const drawTrack = (semitones, color, width) => {
    const k = Math.pow(2, semitones / 12);
    g.strokeStyle = color;
    g.lineWidth = width;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    let pen = false;
    for (let i = 0; i < tr.f0.length; i++) {
      const f = tr.f0[i];
      if (f <= 0) { pen = false; continue; }
      const x = xOf(tr.times[i]), y = yOf(f * k, H);
      if (!pen) { g.moveTo(x, y); pen = true; } else g.lineTo(x, y);
    }
    g.stroke();
  };

  for (const p of activePresets()) if (state.enabled[p.id]) drawTrack(p.semitones, p.color, 6);
  drawTrack(0, '#3a2e1f', 8);

  if (playhead >= 0) {
    const x = xOf(Math.min(dur, Math.max(0, playhead)));
    g.strokeStyle = 'rgba(255,107,107,0.9)';
    g.lineWidth = 4;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  }
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
    const missing = activePresets().some((p) => !state.harmonyBuffers[p.id]);
    if (missing) { setBusy(true, 'はもりを つくっているよ…'); await yieldToUI(); await ensureHarmonies(); setBusy(false); }
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
el.btnPlay.addEventListener('click', () => { state.playing ? stopPlayback() : startPlayback(); });
el.btnBack.addEventListener('click', () => {
  stopPlayback();
  el.hint.textContent = 'まるいボタンをおして、うたってね';
  el.timer.textContent = '0';
  showScreen('record');
});
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopPlayback(); if (state.recording) stopRecording(); } });

buildSwitches();
showScreen('record');
