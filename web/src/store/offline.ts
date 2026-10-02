import { create } from 'zustand';
import { api } from '../lib/api';
import { engine } from '../audio/engine';
import { planOffline, offlineEligible, formatBytes, type OfflineRec } from '../lib/offline-plan';
import type { Playback, Track } from '../lib/types';
import { useLibrary, slimTrack } from './library';
import { useUi } from './ui';

/**
 * « Disponible hors ligne »: audio, cover and loudness of chosen titles, kept in this device's
 * IndexedDB (never on the server, never shared between accounts: wiped at logout).
 *
 * The audio comes from the usual /api/stream relay, fetched by 1 MiB HTTP ranges like the player
 * does (the server forwards each one to the source, which refuses bigger requests). A downloaded
 * title is then always read from here, online too (no data used). Choices (liked tracks, playlists,
 * size limit) are per device, in localStorage.
 */

const CHUNK = 1024 * 1024;
const MAX_BYTES = 300 * CHUNK;
const PREFS = 'forge.offline';
// 500 Mo to 1 To; 20 Go by default (the device's free space is the real ceiling, shown in « Hors ligne »).
export const LIMITS_MB = [512, 1024, 2048, 5120, 10240, 20480, 51200, 102400, 204800, 512000, 1048576];
const DEFAULT_LIMIT_MB = 20480;

export interface OfflineItem { url: string; track: Track; pins: string[]; size: number; mime: string; lufs: number | null; at: number; thumb: string | null }
interface Stored extends Omit<OfflineItem, 'thumb'> { audio: Blob; cover: Blob | null }
interface Job { track: Track; pins: string[] }

interface OfflineState {
  /** Server reachable. False at startup without network: the app then only offers downloaded titles. */
  online: boolean;
  ready: boolean;
  items: Record<string, OfflineItem>;
  /** Cover object URLs by original thumbnail URL (components/Cover.tsx uses them first). */
  covers: Record<string, string>;
  /** Collections kept offline: 'liked', 'pl:<playlist id>'. */
  sets: string[];
  limitMb: number;
  queue: Job[];
  active: { url: string; title: string; loaded: number; total: number | null } | null;
  /** The next title does not fit under the limit: downloads wait for a bigger limit or free space. */
  full: boolean;
}

const readPrefs = (): { sets: string[]; limitMb: number } => {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) || '{}');
    // Prefs without `v` were saved when the default was 2 Go: that untouched default becomes the new one.
    const limitMb = !LIMITS_MB.includes(p.limitMb) || (!p.v && p.limitMb === 2048) ? DEFAULT_LIMIT_MB : p.limitMb;
    return { sets: Array.isArray(p.sets) ? p.sets.filter((s: unknown) => typeof s === 'string') : [], limitMb };
  } catch { return { sets: [], limitMb: DEFAULT_LIMIT_MB }; }
};

export const useOffline = create<OfflineState>(() => ({
  online: typeof navigator === 'undefined' || navigator.onLine,
  ready: false,
  items: {},
  covers: {},
  ...readPrefs(),
  queue: [],
  active: null,
  full: false,
}));

const savePrefs = () => {
  const { sets, limitMb } = useOffline.getState();
  try { localStorage.setItem(PREFS, JSON.stringify({ v: 2, sets, limitMb })); } catch { /* quota */ }
};

// ---------------------------------------------------------------- IndexedDB
let dbp: Promise<IDBDatabase> | null = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('forge-offline', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('tracks', { keyPath: 'url' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
async function store<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('tracks', mode);
    const req = fn(tx.objectStore('tracks'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------- reading
const audioUrls = new Map<string, string>();

export const usedBytes = () => Object.values(useOffline.getState().items).reduce((a, i) => a + i.size, 0);

/** How the engine plays a downloaded title (null = not downloaded / unreadable: play it online). */
async function localPlayback(track: Track): Promise<Playback | null> {
  const item = useOffline.getState().items[track.url];
  if (!item) return null;
  let src = audioUrls.get(track.url);
  if (!src) {
    const rec = await store<Stored | undefined>('readonly', (s) => s.get(track.url)).catch(() => undefined);
    if (!rec?.audio) return null;
    src = URL.createObjectURL(rec.audio);
    audioUrls.set(track.url, src);
  }
  return { src, seekable: true, duration: track.duration ?? item.track.duration, isLive: false, mime: item.mime };
}

engine.localSource = (track) => (useOffline.getState().items[track.url] ? localPlayback(track) : null);
engine.localLufs = (url) => useOffline.getState().items[url]?.lufs;
engine.isOffline = () => !useOffline.getState().online;

const coverOf = (s: Stored) => (s.cover && s.track.thumbnail ? URL.createObjectURL(s.cover) : null);

export async function initOffline() {
  if (typeof indexedDB === 'undefined') { useOffline.setState({ ready: true }); return; }
  try {
    const all = await store<Stored[]>('readonly', (s) => s.getAll());
    const items: Record<string, OfflineItem> = {};
    const covers: Record<string, string> = {};
    for (const s of all) {
      const thumb = coverOf(s);
      if (thumb) covers[s.track.thumbnail!] = thumb;
      items[s.url] = { url: s.url, track: s.track, pins: s.pins, size: s.size, mime: s.mime, lufs: s.lufs, at: s.at, thumb };
    }
    useOffline.setState({ items, covers, ready: true });
  } catch {
    useOffline.setState({ ready: true });
  }
  reconcile();
  useLibrary.subscribe((s, prev) => { if (s.liked !== prev.liked || s.playlists !== prev.playlists) scheduleReconcile(); });
}

// ---------------------------------------------------------------- network state
let probing = false;
/** Ask the server whether it is reachable (public route, no session needed). */
export async function probeNetwork() {
  if (probing) return useOffline.getState().online;
  probing = true;
  try {
    const res = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(8000) });
    setOnline(res.status < 500);
  } catch {
    setOnline(false);
  } finally {
    probing = false;
  }
  return useOffline.getState().online;
}

export function setOnline(online: boolean) {
  if (useOffline.getState().online === online) return;
  useOffline.setState({ online });
  if (online) reconcile();
}

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => setOnline(false));
  window.addEventListener('online', () => { probeNetwork(); });
  setInterval(() => { if (!useOffline.getState().online && navigator.onLine) probeNetwork(); }, 15_000);
}

// ---------------------------------------------------------------- choosing what is kept
const collections = () => {
  const lib = useLibrary.getState();
  const out: Record<string, Track[]> = { liked: lib.liked };
  for (const p of lib.playlists) out[`pl:${p.id}`] = p.tracks;
  return out;
};

let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
const scheduleReconcile = () => { clearTimeout(reconcileTimer); reconcileTimer = setTimeout(reconcile, 1500); };

/** Bring the stored titles in line with the choices: queue what is missing, delete what nothing keeps. */
function reconcile() {
  const st = useOffline.getState();
  if (!st.ready) return;
  const recs: OfflineRec[] = [
    ...Object.values(st.items).map((i) => ({ url: i.url, track: i.track, pins: i.pins, stored: true })),
    ...st.queue.filter((j) => !st.items[j.track.url]).map((j) => ({ url: j.track.url, track: j.track, pins: j.pins, stored: false })),
    ...(activeJob && !st.items[activeJob.track.url] ? [{ url: activeJob.track.url, track: activeJob.track, pins: activeJob.pins, stored: false }] : []),
  ];
  const plan = planOffline(st.sets, collections(), recs);
  if (plan.sets.length !== st.sets.length) { useOffline.setState({ sets: plan.sets }); savePrefs(); }
  for (const u of plan.update) {
    const item = useOffline.getState().items[u.url];
    if (!item) continue;
    useOffline.setState((s) => ({ items: { ...s.items, [u.url]: { ...item, pins: u.pins } } }));
    store<Stored | undefined>('readonly', (s) => s.get(u.url)).then((rec) => rec && store('readwrite', (s) => s.put({ ...rec, pins: u.pins }))).catch(() => {});
  }
  for (const url of plan.remove) void removeStored(url);
  const active = activeJob;
  const again = active && plan.download.find((d) => d.track.url === active.track.url);
  if (active && !again) controller?.abort();
  else if (active && again) active.pins = again.pins;
  useOffline.setState({ queue: plan.download.filter((d) => d.track.url !== active?.track.url) });
  pump();
}

async function removeStored(url: string) {
  const item = useOffline.getState().items[url];
  if (!item) return;
  await store('readwrite', (s) => s.delete(url)).catch(() => {});
  const src = audioUrls.get(url);
  // Never revoke the URL the player is reading right now: it keeps working until the next track.
  if (src && engine.currentTrack?.url !== url) { URL.revokeObjectURL(src); audioUrls.delete(url); }
  useOffline.setState((s) => {
    const items = { ...s.items };
    delete items[url];
    const covers = { ...s.covers };
    if (item.thumb && item.track.thumbnail) { URL.revokeObjectURL(item.thumb); delete covers[item.track.thumbnail]; }
    return { items, covers, full: false };
  });
}

/** Whether the title itself (not only one of its playlists) is kept offline. */
export function trackPinned(url: string) {
  const st = useOffline.getState();
  const pins = st.items[url]?.pins ?? (activeJob?.track.url === url ? activeJob.pins : st.queue.find((j) => j.track.url === url)?.pins);
  return !!pins?.includes('track');
}

export function toggleTrack(track: Track) {
  const st = useOffline.getState();
  const url = track.url;
  const on = !trackPinned(url);
  if (on && !offlineEligible(track)) return false;
  const pins = (p: string[]) => (on ? [...p, 'track'] : p.filter((x) => x !== 'track'));
  const item = st.items[url];
  if (item) useOffline.setState({ items: { ...st.items, [url]: { ...item, pins: pins(item.pins) } } });
  else if (activeJob?.track.url === url) activeJob.pins = pins(activeJob.pins);
  else if (on) useOffline.setState({ queue: [{ track: slimTrack(track), pins: ['track'] }, ...st.queue.filter((j) => j.track.url !== url)] });
  else useOffline.setState({ queue: st.queue.filter((j) => j.track.url !== url) });
  if (on) void navigator.storage?.persist?.()?.catch(() => false);
  reconcile();
  return on;
}

export function toggleSet(set: string, on: boolean) {
  // Ask the browser not to evict the downloaded titles when the device runs short of space.
  if (on) navigator.storage?.persist?.().catch(() => {});
  const sets = useOffline.getState().sets.filter((s) => s !== set);
  useOffline.setState({ sets: on ? [...sets, set] : sets });
  savePrefs();
  if (on) void navigator.storage?.persist?.()?.catch(() => false);
  reconcile();
}

export function setLimit(limitMb: number) {
  useOffline.setState({ limitMb, full: false });
  savePrefs();
  pump();
}

/** Stop every pending download; collections not complete are no longer kept offline. */
export function cancelAll() {
  const st = useOffline.getState();
  const cols = collections();
  const sets = st.sets.filter((s) => (cols[s] || []).filter(offlineEligible).every((t) => st.items[t.url]));
  useOffline.setState({ queue: [], sets });
  savePrefs();
  if (activeJob) activeJob.pins = [];
  controller?.abort();
}

/** Delete everything kept offline on this device (logout, account change, « Tout supprimer »). */
export async function clearOffline() {
  if (activeJob) activeJob.pins = [];
  controller?.abort();
  const st = useOffline.getState();
  for (const u of audioUrls.values()) URL.revokeObjectURL(u);
  audioUrls.clear();
  for (const u of Object.values(st.covers)) URL.revokeObjectURL(u);
  useOffline.setState({ items: {}, covers: {}, sets: [], queue: [], full: false });
  try { localStorage.removeItem(PREFS); } catch { /* private mode */ }
  if (typeof indexedDB !== 'undefined') await store('readwrite', (s) => s.clear()).catch(() => {});
}

// ---------------------------------------------------------------- downloading
let activeJob: Job | null = null;
let controller: AbortController | null = null;

class Full extends Error {}

async function fetchAudio(track: Track, signal: AbortSignal, room: number, progress: (loaded: number, total: number | null) => void) {
  const pb = await api.playback(track.url, 'audio', signal, engine.quality, track);
  if (pb.isLive) throw new Error('un direct ne se télécharge pas');
  const parts: Blob[] = [];
  let loaded = 0;
  let total: number | null = null;
  let mime = pb.mime;
  const add = (b: Blob) => {
    parts.push(b);
    loaded += b.size;
    if (loaded > room || loaded > MAX_BYTES) throw new Full();
    progress(loaded, total);
  };
  for (let tries = 0; ;) {
    let res: Response;
    try {
      res = await fetch(pb.src, { signal, credentials: 'same-origin', headers: pb.seekable ? { range: `bytes=${loaded}-${loaded + CHUNK - 1}` } : {} });
      if (!res.ok) throw new Error(`le serveur a répondu ${res.status}`);
    } catch (err) {
      if (signal.aborted || ++tries > 2) throw err;
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    mime = (res.headers.get('content-type') || mime).split(';')[0];
    if (res.status === 200) {
      // Whole file in one response (transcoded stream, or a source without ranges): read it as it comes.
      if (loaded) throw new Error('le serveur a ignoré la plage demandée');
      total = Number(res.headers.get('content-length')) || null;
      const reader = res.body!.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          add(new Blob([value]));
        }
      } catch (err) { reader.cancel().catch(() => {}); throw err; }
      break;
    }
    const blob = await res.blob();
    const m = (res.headers.get('content-range') || '').match(/\/(\d+)\s*$/);
    if (m) total = Number(m[1]);
    add(blob);
    if (!blob.size || (total !== null ? loaded >= total : blob.size < CHUNK)) break;
  }
  if (!loaded) throw new Error('fichier vide');
  return { audio: new Blob(parts, { type: mime }), mime };
}

async function fetchCover(thumb: string | null, signal: AbortSignal) {
  if (!thumb || !/^https?:\/\//.test(thumb)) return null;
  try {
    const res = await fetch(api.imageUrl(thumb), { signal, credentials: 'same-origin' });
    const blob = res.ok ? await res.blob() : null;
    return blob && blob.type.startsWith('image/') && blob.size < 2 * CHUNK ? blob : null;
  } catch { return null; }
}

function tellFull() {
  const { limitMb } = useOffline.getState();
  useOffline.setState({ full: true });
  useUi.getState().toast(`Espace hors ligne plein (${formatBytes(limitMb * CHUNK)}) : augmentez la limite dans « Hors ligne »`, 'error');
}

async function pump() {
  const st = useOffline.getState();
  if (activeJob || !st.online || !st.queue.length || !st.ready || st.full) return;
  const room = st.limitMb * CHUNK - usedBytes();
  if (room < CHUNK) { tellFull(); return; }
  const job = st.queue[0];
  const mine: Job = { track: job.track, pins: [...job.pins] };
  activeJob = mine;
  controller = new AbortController();
  const { signal } = controller;
  const url = job.track.url;
  useOffline.setState({ queue: st.queue.slice(1), active: { url, title: job.track.title, loaded: 0, total: null } });
  let stop = false;
  try {
    const lufs = api.loudness(url).then((r) => r.lufs, () => null);
    const [{ audio, mime }, cover] = await Promise.all([
      fetchAudio(job.track, signal, room, (loaded, total) => useOffline.setState({ active: { url, title: job.track.title, loaded, total } })),
      fetchCover(job.track.thumbnail, signal),
    ]);
    const measured = await Promise.race([lufs, new Promise<null>((r) => setTimeout(() => r(null), 15_000))]);
    if (signal.aborted || !mine.pins.length) throw new DOMException('aborted', 'AbortError');
    const rec: Stored = { url, track: slimTrack(job.track), pins: mine.pins, size: audio.size + (cover?.size || 0), mime, lufs: measured, at: Date.now(), audio, cover };
    await store('readwrite', (s) => s.put(rec));
    const thumb = coverOf(rec);
    useOffline.setState((s) => ({
      items: { ...s.items, [url]: { url, track: rec.track, pins: rec.pins, size: rec.size, mime, lufs: rec.lufs, at: rec.at, thumb } },
      covers: thumb ? { ...s.covers, [rec.track.thumbnail!]: thumb } : s.covers,
    }));
  } catch (err) {
    const requeue = () => { if (mine.pins.length) useOffline.setState((s) => ({ queue: [mine, ...s.queue] })); };
    if (err instanceof Full) { requeue(); tellFull(); stop = true; }
    else if (!signal.aborted) {
      if (!navigator.onLine || err instanceof TypeError) { requeue(); stop = true; void probeNetwork().then((on) => { if (on) setTimeout(pump, 10_000); }); }
      else useUi.getState().toast(`« ${job.track.title} » non téléchargé : ${(err as Error).message}`, 'error');
    }
  } finally {
    activeJob = null;
    controller = null;
    useOffline.setState({ active: null });
  }
  if (!stop) setTimeout(pump, 0);
}
