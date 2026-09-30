import type { Artist, HiddenEntry, HistoryEntry, Playlist, RepeatMode, Track } from './types';

/**
 * Merging two copies of a library (this device and the server) after a save conflict.
 * No runtime import on purpose: tested directly by `node --test` (merge.test.ts).
 */

/** Artist key used for following (case and spacing insensitive). */
export const artistKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

export interface SyncData {
  library: {
    playlists: Playlist[];
    deletedPlaylists: Record<string, number>;
    liked: Track[];
    unliked?: Record<string, number>;
    followedArtists?: Artist[];
    unfollowed?: Record<string, number>;
    hiddenTracks?: Record<string, HiddenEntry>;
    hiddenArtists?: Record<string, HiddenEntry>;
    history: HistoryEntry[];
    playCounts: Record<string, number>;
  };
  settings: Record<string, unknown>;
  player: {
    queue: Track[];
    index: number;
    shuffle: boolean;
    repeat: RepeatMode;
    volume: number;
    rate: number;
    position: number;
  } | null;
}

/** Combine two copies after a conflict: newest playlist wins, deletions are kept, lists are unioned. */
export function merge(local: SyncData, server: SyncData): SyncData {
  const tomb: Record<string, number> = { ...server.library.deletedPlaylists };
  for (const [id, at] of Object.entries(local.library.deletedPlaylists || {})) tomb[id] = Math.max(tomb[id] || 0, at);
  const byId = new Map<string, Playlist>();
  for (const p of [...(server.library.playlists || []), ...(local.library.playlists || [])]) {
    const have = byId.get(p.id);
    if (!have || p.updatedAt >= have.updatedAt) byId.set(p.id, p);
  }
  const playlists = [...byId.values()].filter((p) => !(tomb[p.id] && tomb[p.id] >= p.updatedAt)).sort((a, b) => b.createdAt - a.createdAt);

  // Likes and followed artists: union of both copies, minus what either side removed after it was added.
  const unliked = maxTimes(local.library.unliked, server.library.unliked);
  const liked = unionKept(local.library.liked, server.library.liked || [], (t) => t.url, (t) => t.addedAt || 0, unliked)
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  const unfollowed = maxTimes(local.library.unfollowed, server.library.unfollowed);
  const followedArtists = unionKept(local.library.followedArtists || [], server.library.followedArtists || [], (a) => artistKey(a.name), (a) => a.at, unfollowed)
    .sort((a, b) => b.at - a.at);

  const seen = new Set<string>();
  const history = [...local.library.history, ...server.library.history]
    .filter((h) => { const k = `${h.track.url}|${h.at}`; return !seen.has(k) && !!seen.add(k); })
    .sort((a, b) => b.at - a.at)
    .slice(0, 1000);

  const playCounts: Record<string, number> = { ...server.library.playCounts };
  for (const [u, n] of Object.entries(local.library.playCounts)) playCounts[u] = Math.max(playCounts[u] || 0, n);

  const hiddenTracks = latestChoice(local.library.hiddenTracks, server.library.hiddenTracks);
  const hiddenArtists = latestChoice(local.library.hiddenArtists, server.library.hiddenArtists);

  return { library: { playlists, deletedPlaylists: tomb, liked, unliked, followedArtists, unfollowed, hiddenTracks, hiddenArtists, history, playCounts }, settings: local.settings, player: local.player };
}

/** Hidden / shown again: the most recent choice wins (|at| is the time of the choice). */
export function latestChoice(a: Record<string, HiddenEntry> = {}, b: Record<string, HiddenEntry> = {}) {
  const out = { ...b };
  for (const [k, v] of Object.entries(a)) if (!out[k] || Math.abs(v.at) >= Math.abs(out[k].at)) out[k] = v;
  return out;
}

export function maxTimes(a: Record<string, number> = {}, b: Record<string, number> = {}) {
  const out = { ...b };
  for (const [k, t] of Object.entries(a)) out[k] = Math.max(out[k] || 0, t);
  return out;
}

/** Items of both lists (local first), once per key, dropping those removed (tombstone) at or after they were added. */
export function unionKept<T>(local: T[], server: T[], key: (x: T) => string, addedAt: (x: T) => number, removed: Record<string, number>) {
  const seen = new Set<string>();
  return [...local, ...server].filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return !(removed[k] && removed[k] >= addedAt(x));
  });
}

