import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './util.js';
import { readJson, writeJsonAtomic, isValidUsername } from './accounts.js';

/**
 * Per-user library saved on the server: playlists (including imported Spotify / Deezer / YouTube
 * playlists), liked tracks, history, play counts, settings and the play queue.
 *
 * Only metadata is stored. Tracks played from local files (blob: URLs) never reach the server:
 * they are stripped here as well as in the client.
 */

export const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TRACKS_PER_LIST = 5000;
const MAX_HISTORY = 1000;

const TRACK_KEYS = ['id', 'title', 'url', 'duration', 'thumbnail', 'author', 'album', 'source', 'isLive', 'addedAt'];

function isRemoteTrack(t) {
  return t && typeof t === 'object' && typeof t.url === 'string' && /^https?:\/\//i.test(t.url) && t.source !== 'local' && typeof t.title === 'string';
}

function cleanTrack(t) {
  const out = {};
  for (const k of TRACK_KEYS) if (t[k] !== undefined) out[k] = t[k];
  out.title = String(out.title).slice(0, 300);
  if (out.addedAt !== undefined && !(Number(out.addedAt) > 0)) delete out.addedAt;
  else if (out.addedAt !== undefined) out.addedAt = Math.floor(Number(out.addedAt));
  return out;
}

const tracks = (list, max = MAX_TRACKS_PER_LIST) => (Array.isArray(list) ? list.filter(isRemoteTrack).slice(0, max).map(cleanTrack) : []);
/** Remote tracks only, known fields only (shared playlists and Jam queues use it too). */
export const cleanTracks = tracks;

/** { key: time } maps (deleted playlists, un-liked tracks, unfollowed artists): positive times only, capped. */
const tombstones = (obj) => Object.fromEntries(Object.entries(obj && typeof obj === 'object' ? obj : {})
  .filter(([k, v]) => k.length <= 2000 && Number(v) > 0).slice(0, 5000).map(([k, v]) => [k, Math.floor(Number(v))]));

/** Cover of a playlist: a public image URL or an image uploaded to this server (covers.js). */
export const COVER_PATH = /^\/api\/covers\/[a-z0-9][a-z0-9._-]{1,31}\/[A-Za-z0-9_-]{8,40}\.(jpg|png|webp)$/;
export const cleanCover = (c) => (typeof c === 'string' && (/^https?:\/\//.test(c) || COVER_PATH.test(c)) ? c.slice(0, 2000) : null);

/**
 * Hidden tracks / artists (« masquer », « ne plus recommander »): key -> { at, label }. A negative
 * `at` means shown again at that time, so the choice made last wins when two devices merge.
 */
const hiddenMap = (obj) => Object.fromEntries(Object.entries(obj && typeof obj === 'object' ? obj : {})
  .filter(([k, v]) => k.length <= 2000 && v && Number.isFinite(Number(v.at)) && Number(v.at) !== 0).slice(0, 5000)
  .map(([k, v]) => [k, { at: Math.trunc(Number(v.at)), label: String(v.label || '').slice(0, 300) }]));

const artists = (list) => (Array.isArray(list) ? list : [])
  .filter((a) => a && typeof a.name === 'string' && a.name.trim())
  .slice(0, 2000)
  .map((a) => ({
    name: a.name.trim().slice(0, 200),
    thumbnail: typeof a.thumbnail === 'string' && /^https?:\/\//.test(a.thumbnail) ? a.thumbnail : null,
    at: Number(a.at) || Date.now(),
  }));

/** Radio station kept in the library (favourites, recently played): a snapshot of its card (radio.js). */
const STATION_ID = /^(fr-[a-z0-9]{2,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
const stations = (list, max) => (Array.isArray(list) ? list : [])
  .filter((s) => s && typeof s.id === 'string' && STATION_ID.test(s.id) && typeof s.name === 'string' && s.name.trim())
  .slice(0, max)
  .map((s) => ({
    id: s.id, name: s.name.trim().slice(0, 120), country: str(s.country, 60), countryCode: /^[A-Z]{2}$/.test(s.countryCode) ? s.countryCode : null,
    group: str(s.group, 60), tags: (Array.isArray(s.tags) ? s.tags : []).filter((t) => typeof t === 'string').slice(0, 6).map((t) => t.slice(0, 30)),
    codec: str(s.codec, 12), bitrate: Number(s.bitrate) > 0 ? Math.min(9999, Math.floor(Number(s.bitrate))) : null,
    homepage: typeof s.homepage === 'string' && /^https?:\/\//.test(s.homepage) ? s.homepage.slice(0, 500) : null,
    logo: s.logo === `/api/radio/logo/${s.id}` ? s.logo : null, color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : null,
    at: Number(s.at) > 0 ? Math.floor(Number(s.at)) : Date.now(),
  }));

/** Validate and strip a library document sent by a client. */
export function sanitizeData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError('Données invalides');
  const lib = data.library && typeof data.library === 'object' ? data.library : {};
  const out = {
    library: {
      playlists: (Array.isArray(lib.playlists) ? lib.playlists : []).filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string').slice(0, 1000).map((p) => ({
        id: p.id.slice(0, 64),
        name: p.name.slice(0, 200),
        description: String(p.description || '').slice(0, 2000),
        cover: cleanCover(p.cover),
        folder: typeof p.folder === 'string' && p.folder.trim() ? p.folder.trim().slice(0, 60) : null,
        pinned: !!p.pinned,
        // « Afficher sur mon profil » (friends only, see profiles.js); off unless chosen.
        onProfile: p.onProfile === true,
        sourceUrl: typeof p.sourceUrl === 'string' && /^https?:\/\//.test(p.sourceUrl) ? p.sourceUrl : null,
        tracks: tracks(p.tracks),
        createdAt: Number(p.createdAt) || Date.now(),
        updatedAt: Number(p.updatedAt) || Date.now(),
      })),
      deletedPlaylists: tombstones(lib.deletedPlaylists),
      liked: tracks(lib.liked),
      unliked: tombstones(lib.unliked),
      followedArtists: artists(lib.followedArtists),
      unfollowed: tombstones(lib.unfollowed),
      hiddenTracks: hiddenMap(lib.hiddenTracks),
      hiddenArtists: hiddenMap(lib.hiddenArtists),
      history: (Array.isArray(lib.history) ? lib.history : []).filter((h) => h && isRemoteTrack(h.track)).slice(0, MAX_HISTORY).map((h) => ({ track: cleanTrack(h.track), at: Number(h.at) || 0 })),
      radioFavorites: stations(lib.radioFavorites, 500),
      radioUnfavorited: tombstones(lib.radioUnfavorited),
      radioRecent: stations(lib.radioRecent, 50),
      playCounts: Object.fromEntries(Object.entries(lib.playCounts || {}).filter(([k, v]) => /^https?:\/\//.test(k) && Number(v) > 0).slice(0, 20000).map(([k, v]) => [k, Math.floor(Number(v))])),
    },
    settings: data.settings && typeof data.settings === 'object' ? data.settings : {},
    player: null,
  };
  const pl = data.player;
  if (pl && typeof pl === 'object') {
    const queue = tracks(pl.queue, 2000);
    out.player = {
      queue,
      index: Math.min(Math.max(-1, Number(pl.index) || 0), queue.length - 1),
      shuffle: !!pl.shuffle,
      repeat: ['off', 'all', 'one'].includes(pl.repeat) ? pl.repeat : 'off',
      volume: Math.min(1, Math.max(0, Number(pl.volume ?? 0.8))),
      rate: Math.min(2, Math.max(0.5, Number(pl.rate) || 1)),
      position: Math.max(0, Number(pl.position) || 0),
    };
  }
  return out;
}

export class UserData {
  constructor(dir) {
    this.dir = dir;
  }

  file(username) {
    if (!isValidUsername(username)) throw new HttpError('Utilisateur invalide', 400);
    return path.join(this.dir, 'users', `${username}.json`);
  }

  exists(username) {
    return fs.existsSync(this.file(username));
  }

  get(username) {
    return readJson(this.file(username), { rev: 0, updatedAt: null, data: null });
  }

  /** Save with optimistic concurrency: `baseRev` must match the stored revision. */
  put(username, baseRev, data) {
    const current = this.get(username);
    if (Number(baseRev) !== current.rev) {
      const err = new HttpError('Les données ont changé sur un autre appareil', 409, 'CONFLICT');
      err.current = current;
      throw err;
    }
    const clean = sanitizeData(data);
    const doc = { rev: current.rev + 1, updatedAt: Date.now(), data: clean };
    const size = Buffer.byteLength(JSON.stringify(doc));
    if (size > MAX_BYTES) throw new HttpError('Bibliothèque trop volumineuse', 413, 'TOO_LARGE');
    writeJsonAtomic(this.file(username), doc);
    return { rev: doc.rev, updatedAt: doc.updatedAt };
  }

  /**
   * Change a user's library on the server side (likes from the Discord bot). The devices get the
   * new revision at their next pull, and a device that saves on an older revision merges (409).
   */
  update(username, change) {
    const current = this.get(username);
    const data = current.data || { library: {}, settings: {}, player: null };
    data.library = data.library || {};
    const result = change(data);
    this.put(username, current.rev, data);
    return result;
  }
}
