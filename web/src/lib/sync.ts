import { create } from 'zustand';
import { api, ApiError, type User } from './api';
import type { Track } from './types';
import { merge, type SyncData } from './merge';
import { useLibrary, slimTrack } from '../store/library';
import { usePlayer, restorePosition } from '../store/player';
import { clearResume, readResume, saveResume } from './resume';
import { useSettings } from '../store/ui';
import { engine } from '../audio/engine';
import { clearDeviceKeys } from './e2e';
import { flushStorage } from './storage';

/**
 * Keeps the signed-in user's library on the server: playlists (Spotify / Deezer / YouTube imports
 * included), liked tracks, history, play counts, settings and the play queue.
 *
 * Changes are pushed 2 s after they happen (and when the page closes); the server copy is pulled
 * at login and whenever the tab comes back to the foreground. Tracks read from local files are
 * never sent: they only exist in this browser for the session.
 */

export type { SyncData } from './merge';

type Status = 'off' | 'loading' | 'saved' | 'saving' | 'pending' | 'offline' | 'error';

export const useSync = create<{ user: User | null; status: Status; savedAt: number | null }>(() => ({ user: null, status: 'off', savedAt: null }));

const SETTING_KEYS = ['accent', 'defaultSource', 'visualizer', 'dynamicColors', 'eqEnabled', 'eqPreset', 'eqGains', 'autoplay', 'crossfade', 'gapless', 'normalize', 'shareActivity'] as const;
const OWNER_KEY = 'forge.owner';
const DEBOUNCE = 2000;

let rev = 0;
let dirty = false;
let saving = false;
let applying = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;

const remote = (t: Track | undefined): t is Track => !!t && /^https?:\/\//i.test(t.url) && t.source !== 'local';

/** Snapshot of everything that is saved (local-file tracks removed). */
export function collect(): SyncData {
  const lib = useLibrary.getState();
  const st = useSettings.getState();
  const pl = usePlayer.getState();
  const current = pl.queue[pl.index];
  const queue = pl.queue.filter(remote).map(slimTrack);
  const saved = readResume();
  return {
    library: {
      playlists: lib.playlists.map((p) => ({ ...p, tracks: p.tracks.filter(remote) })),
      deletedPlaylists: lib.deletedPlaylists,
      liked: lib.liked.filter(remote),
      unliked: lib.unliked,
      followedArtists: lib.followedArtists,
      unfollowed: lib.unfollowed,
      hiddenTracks: lib.hiddenTracks,
      hiddenArtists: lib.hiddenArtists,
      radioFavorites: lib.radioFavorites,
      radioUnfavorited: lib.radioUnfavorited,
      radioRecent: lib.radioRecent,
      history: lib.history.filter((h) => remote(h.track)),
      playCounts: lib.playCounts,
    },
    settings: Object.fromEntries(SETTING_KEYS.map((k) => [k, st[k]])),
    player: {
      queue,
      index: current && remote(current) ? queue.findIndex((t) => t.url === current.url) : Math.min(pl.index, queue.length - 1),
      shuffle: pl.shuffle,
      repeat: pl.repeat,
      volume: pl.volume,
      rate: pl.rate,
      position: engine.currentTrack ? Math.floor(engine.currentTime) : current && saved?.url === current.url ? saved.t : 0,
      positionAt: engine.currentTrack && !engine.paused ? Date.now() : saved?.at || 0,
    },
  };
}

/** Load a server copy into the stores. */
function apply(data: SyncData) {
  applying = true;
  try {
    const lib = data.library;
    useLibrary.setState({
      playlists: lib.playlists || [],
      deletedPlaylists: lib.deletedPlaylists || {},
      liked: lib.liked || [],
      unliked: lib.unliked || {},
      followedArtists: lib.followedArtists || [],
      unfollowed: lib.unfollowed || {},
      hiddenTracks: lib.hiddenTracks || {},
      hiddenArtists: lib.hiddenArtists || {},
      radioFavorites: lib.radioFavorites || [],
      radioUnfavorited: lib.radioUnfavorited || {},
      radioRecent: lib.radioRecent || [],
      history: lib.history || [],
      playCounts: lib.playCounts || {},
    });
    const settings: Record<string, unknown> = {};
    for (const k of SETTING_KEYS) if (data.settings?.[k] !== undefined) settings[k] = data.settings[k];
    useSettings.setState(settings);
    // Never swap the queue under a track that is playing on this device.
    if (data.player && !engine.currentTrack) {
      const p = data.player;
      const cur = usePlayer.getState();
      // Same queue as here: keep its order from before shuffling (not saved on the server).
      const same = cur.queue.length === p.queue.length && cur.queue.every((t, i) => t.url === p.queue[i]?.url);
      usePlayer.setState({ queue: p.queue, index: p.index, shuffle: p.shuffle, unshuffled: same ? cur.unshuffled : null, repeat: p.repeat, rate: p.rate });
      usePlayer.getState().setVolume(p.volume);
      // Resume point: the server's when it is about another track or newer (played on another device).
      const track = p.queue[p.index];
      const local = readResume();
      if (track && (local?.url !== track.url || (p.positionAt || 0) > local.at)) saveResume(track.url, p.position || 0, p.positionAt || 0);
      restorePosition();
    }
  } finally {
    applying = false;
  }
}

function hasContent(d: SyncData) {
  const l = d.library;
  return l.playlists.length > 0 || l.liked.length > 0 || l.history.length > 0;
}

async function push() {
  if (saving) return;
  clearTimeout(timer);
  saving = true;
  dirty = false;
  useSync.setState({ status: 'saving' });
  try {
    const data = collect();
    pushedPos = posKey(data);
    const res = await api.putData(rev, data);
    rev = res.rev;
    useSync.setState({ status: dirty ? 'pending' : 'saved', savedAt: res.updatedAt });
  } catch (err) {
    const e = err as ApiError & { current?: { rev: number; data: SyncData } };
    if (e.status === 409 && e.current?.data) {
      // Another device saved in the meantime: merge both copies, then save the result.
      apply(merge(collect(), e.current.data));
      rev = e.current.rev;
      dirty = true;
    } else if (e.status === 401) {
      useSync.setState({ status: 'error' });
      return;
    } else {
      dirty = true;
      useSync.setState({ status: navigator.onLine ? 'error' : 'offline' });
    }
  } finally {
    saving = false;
  }
  if (dirty) timer = setTimeout(push, e409Delay());
}

const e409Delay = () => (navigator.onLine ? 1500 : 10_000);

function markDirty() {
  if (applying || !started) return;
  dirty = true;
  useSync.setState({ status: 'pending' });
  clearTimeout(timer);
  timer = setTimeout(push, DEBOUNCE);
}

/** Pull the server copy if this device has no unsaved change. */
async function pull() {
  if (dirty || saving) return;
  try {
    const doc = await api.getData<SyncData>();
    if (doc.rev > rev && doc.data) {
      apply(doc.data);
      rev = doc.rev;
      useSync.setState({ status: 'saved', savedAt: doc.updatedAt });
    }
  } catch { /* offline: try again later */ }
}

/** Library changed elsewhere (❤ from the Discord bot, live event): fetch it now. */
export const pullNow = () => pull();

/** Track and second last sent: closing the app after playing on sends the new position too. */
let pushedPos = '';
const posKey = (d: SyncData) => `${d.player?.queue[d.player.index]?.url}@${d.player?.position}`;

function beacon() {
  if (!started) return;
  const data = collect();
  if (!dirty && posKey(data) === pushedPos) return;
  pushedPos = posKey(data);
  const body = new Blob([JSON.stringify({ baseRev: rev, data })], { type: 'application/json' });
  // sendBeacon survives the page closing; fall back to a keepalive fetch for small payloads.
  if (!navigator.sendBeacon?.('/api/me/data', body) && body.size < 60_000) {
    fetch('/api/me/data', { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } }).catch(() => {});
  }
}

function resetLocal() {
  applying = true;
  useLibrary.setState({ playlists: [], deletedPlaylists: {}, liked: [], unliked: {}, followedArtists: [], unfollowed: {}, hiddenTracks: {}, hiddenArtists: {}, history: [], playCounts: {} });
  usePlayer.setState({ queue: [], index: -1, unshuffled: null, position: 0 });
  clearResume();
  applying = false;
}

/** Start syncing for a signed-in user (call once after login / session check). */
export async function startSync(user: User) {
  useSync.setState({ user, status: 'loading' });
  // Another account used this browser before: do not leak its library into this one.
  const owner = localStorage.getItem(OWNER_KEY);
  if (owner && owner !== user.username) resetLocal();

  const doc = await api.getData<SyncData>();
  rev = doc.rev;
  if (doc.data) apply(doc.data);
  try { localStorage.setItem(OWNER_KEY, user.username); } catch { /* quota */ }
  started = true;
  // First login on a server with nothing saved yet: upload what this browser already had.
  if (!doc.data && hasContent(collect())) markDirty();
  else useSync.setState({ status: 'saved', savedAt: doc.updatedAt });

  if (!bound) {
    bound = true;
    useLibrary.subscribe(markDirty);
    useSettings.subscribe((s, prev) => { if (SETTING_KEYS.some((k) => s[k] !== prev[k])) markDirty(); });
    usePlayer.subscribe((s, prev) => {
      if (s.queue !== prev.queue || s.index !== prev.index || s.shuffle !== prev.shuffle || s.repeat !== prev.repeat || s.volume !== prev.volume || s.rate !== prev.rate) markDirty();
    });
    engine.on('pause', markDirty);
    window.addEventListener('pagehide', beacon);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') beacon();
      else pull();
    });
    window.addEventListener('online', () => { if (dirty) push(); });
    setInterval(pull, 60_000);
  }
}
let bound = false;

/** Save pending changes, end the session and wipe this browser's copy. */
export async function logout() {
  if (dirty) await push().catch(() => {});
  started = false;
  engine.stop();
  resetLocal();
  localStorage.removeItem(OWNER_KEY);
  flushStorage();
  await clearDeviceKeys(); // the message key leaves this device with the session
  await api.logout().catch(() => {});
  location.reload();
}
