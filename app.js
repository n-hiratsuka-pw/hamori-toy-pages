// app.js — はもり（hamori-toy）メイン
// 録音 → ピッチ解析（pitch.js） → ハモリ生成（psola.js） → 重ね再生
// すべて端末内で完結し、外部へは何も送信しない。

import { detectPitch } from './pitch.js';
import { pitchShiftPSOLA, buildPitchMarks, HARMONY_PRESETS } from './psola.js';

const MAX_SECONDS = 20;
const MIN_SECONDS = 0.5;
const LEVEL_ORIGINAL = 0.9;
const LEVEL_HARMONY = 0.55;

const PRESET_UI = {
  up8: { icon: '🐤', color: '#ffb703' },
  up5: { icon: '🐥', color: '#fb8500' },
  down5: { icon: '🐻', color: '#8ecae6' },
  down8: { icon: '🐘', color: '#219ebc' },
};

const $ = (id) => document.getElementById(id);
const el = {
  screenRecord: $('screen-record'),
  screenPlay: $('screen-play'),
  btnRecord: $('btn-record'),
  btnPlay: $('btn-play'),
  btnBack: $('btn-back'),
  meter: $('meter-bar'),
  timer: $('timer'),
  hint: $('record-hint'),
  canvas: $('pitch-canvas'),
  switches: $('switches'),
  busy: $('busy'),
  busyText: $('busy-text'),
  error: $('error'),
};

const state = {
  ctx: null,
  workletReady: false,
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
  duration: 0,
  buffers: { original: null, harmonies: {} },
  enabled: {},
  // 再生
  playing: false,
  sources: [],
  gains: {},
  playStart: 0,
  rafId: 0,
};

for (const p of HARMONY_PRESETS) state.enabled[p.id] = false;

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
  // 先頭・末尾の短いフェード（クリック音防止）
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
  await yieldToUI();

  setBusy(true, 'はもりを つくっているよ…');
  await yieldToUI();
  const marks = buildPitchMarks(pcm, sampleRate, state.track);
  state.buffers.harmonies = {};
  for (const p of HARMONY_PRESETS) {
    const y = pitchShiftPSOLA(pcm, sampleRate, state.track, p.semitones, marks);
    state.buffers.harmonies[p.id] = toAudioBuffer(ctx, y, sampleRate);
    await yieldToUI();
  }
  state.buffers.original = toAudioBuffer(ctx, pcm, sampleRate);
  console.log(`processing: ${(performance.now() - t0).toFixed(0)} ms for ${state.duration.toFixed(1)} s`);

  setBusy(false);
  showScreen('play');
  drawCanvas();
}

function toAudioBuffer(ctx, data, sampleRate) {
  const buf = ctx.createBuffer(1, data.length, sampleRate);
  buf.copyToChannel(data, 0);
  return buf;
}

// ---------- 再生 ----------
function startPlayback() {
  const ctx = state.ctx;
  if (!state.buffers.original) return;
  stopPlayback();
  const master = ctx.createGain();
  master.gain.value = 1;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.ratio.value = 4;
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
  const main = addVoice('original', state.buffers.original, LEVEL_ORIGINAL);
  for (const p of HARMONY_PRESETS) addVoice(p.id, state.buffers.harmonies[p.id], state.enabled[p.id] ? LEVEL_HARMONY : 0);
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
  btn.classList.toggle('on', state.enabled[id]);
  if (state.playing && state.gains[id]) {
    const g = state.gains[id].gain;
    g.setTargetAtTime(state.enabled[id] ? LEVEL_HARMONY : 0, state.ctx.currentTime, 0.02);
  }
  if (!state.playing) drawCanvas();
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

  // オクターブごとの薄い帯
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

  for (const p of HARMONY_PRESETS) if (state.enabled[p.id]) drawTrack(p.semitones, PRESET_UI[p.id].color, 6);
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
  for (const p of HARMONY_PRESETS) {
    const ui = PRESET_UI[p.id];
    const btn = document.createElement('button');
    btn.className = 'switch';
    btn.dataset.id = p.id;
    btn.style.setProperty('--lamp', ui.color);
    btn.innerHTML = `<span class="icon">${ui.icon}</span><span class="label">${p.label}</span><span class="lamp"></span>`;
    btn.addEventListener('click', () => toggleHarmony(p.id));
    el.switches.appendChild(btn);
  }
}

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
