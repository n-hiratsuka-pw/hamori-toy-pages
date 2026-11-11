// store.js — 録音（テイク）の端末内保存（IndexedDB、依存なし）
//
// 設計（docs/03_設計書.md §7）
//  - 録音のたびに自動保存（「さいきん」）。favorite=false の件数が RECENT_MAX を超えたら古い順に削除
//  - ⭐ で favorite=true にすると自動削除の対象外。favorite は FAVORITE_MAX まで
//  - PCM は Int16 で保存（30 秒・48 kHz で約 2.9 MB／件）
//  - 端末の外へは出ない。ブラウザのサイトデータ消去で消える

const DB_NAME = 'hamori';
const DB_VERSION = 1;
const STORE = 'takes';
export const RECENT_MAX = 10;
export const FAVORITE_MAX = 30;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
        s.createIndex('favorite', 'favorite');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    let result;
    try { result = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    out[i] = v < 0 ? v * 32768 : v * 32767;
  }
  return out;
}

function toFloat32(i16) {
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / (i16[i] < 0 ? 32768 : 32767);
  return out;
}

/** 一覧用メタ情報（PCM を含まない）。新しい順 */
export async function listTakes() {
  const db = await openDb();
  const all = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  return all
    .map(({ pcm, ...meta }) => meta)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getTake(id) {
  const db = await openDb();
  const rec = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  if (!rec) return null;
  return { ...rec, pcm: toFloat32(new Int16Array(rec.pcm)) };
}

/**
 * 新しいテイクを保存し、「さいきん」の上限を超えた古い非お気に入りを削除する。
 * @returns {Promise<string>} id
 */
export async function saveTake({ pcm, sampleRate, duration, enabled, drums = [] }) {
  const db = await openDb();
  const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const rec = {
    id,
    createdAt: Date.now(),
    favorite: false,
    sampleRate,
    duration,
    enabled: { ...enabled },
    drums: drums.map((d) => ({ t: d.t, type: d.type, source: d.source || 'rec', ...(d.decay ? { decay: d.decay } : {}), ...(d.pass ? { pass: d.pass } : {}) })),
    pcm: toInt16(pcm).buffer,
  };
  await tx(db, 'readwrite', (s) => s.put(rec));
  await pruneRecent(db);
  return id;
}

async function pruneRecent(db) {
  const metas = await listTakes();
  const recent = metas.filter((m) => !m.favorite);
  const excess = recent.slice(RECENT_MAX);
  if (excess.length === 0) return;
  await tx(db, 'readwrite', (s) => { for (const m of excess) s.delete(m.id); });
}

/** お気に入りの ON/OFF。上限超過時は false を返し変更しない */
export async function setFavorite(id, favorite) {
  const db = await openDb();
  if (favorite) {
    const metas = await listTakes();
    if (metas.filter((m) => m.favorite && m.id !== id).length >= FAVORITE_MAX) return false;
  }
  const rec = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  if (!rec) return false;
  rec.favorite = favorite;
  await tx(db, 'readwrite', (s) => s.put(rec));
  if (!favorite) await pruneRecent(db);
  return true;
}

export async function updateEnabled(id, enabled) {
  const db = await openDb();
  const rec = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  if (!rec) return;
  rec.enabled = { ...enabled };
  await tx(db, 'readwrite', (s) => s.put(rec));
}

export async function updateDrums(id, drums) {
  const db = await openDb();
  const rec = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  if (!rec) return;
  rec.drums = drums.map((d) => ({ t: d.t, type: d.type, source: d.source || 'rec', ...(d.decay ? { decay: d.decay } : {}), ...(d.pass ? { pass: d.pass } : {}) }));
  await tx(db, 'readwrite', (s) => s.put(rec));
}

export async function deleteTake(id) {
  const db = await openDb();
  await tx(db, 'readwrite', (s) => s.delete(id));
}
