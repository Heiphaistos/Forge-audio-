import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './util.js';
import { readJson, writeJsonAtomic, normalizeUsername, isValidUsername, LoginLimiter } from './accounts.js';
import { sniff, TYPES } from './covers.js';
import { CONTROL } from './messages.js';
import { sharing } from './activity.js';

/**
 * Profiles: display name (accounts.json), biography, profile picture, the playlists one chose to show
 * (`onProfile` on each playlist of the synced library) and, if wanted, listening activity and stats.
 *
 * Visible to friends and to oneself only. Anyone else, a blocked account or an unknown username gets
 * the same 404, and so does the picture of a non-friend even with its exact address.
 * Saved in <data>/profiles.json; pictures in <data>/avatars/<user>/<random>.<ext>.
 */
export const MAX_BIO = 300;
export const MAX_NAME = 40;
const MAX_AVATAR = 1024 * 1024;
const FILE = /^[A-Za-z0-9_-]{16,40}\.(jpg|png|webp)$/;

const notFound = () => new HttpError('Profil introuvable', 404, 'NOT_FOUND');

/** Plain text, 0 to 300 characters (newlines kept, control and bidi characters removed). */
export function cleanBio(raw) {
  if (raw === null || raw === undefined) return '';
  if (typeof raw !== 'string') throw new HttpError('Biographie invalide', 400, 'BAD_REQUEST');
  const text = raw.replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > MAX_BIO) throw new HttpError(`Biographie : ${MAX_BIO} caractères au maximum`, 400, 'TOO_LONG');
  return text;
}

export function cleanName(raw) {
  if (typeof raw !== 'string') throw new HttpError('Nom invalide', 400, 'BAD_REQUEST');
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(CONTROL, '').trim();
  if (!name) throw new HttpError('Le nom affiché ne peut pas être vide', 400, 'BAD_REQUEST');
  if (name.length > MAX_NAME) throw new HttpError(`Nom affiché : ${MAX_NAME} caractères au maximum`, 400, 'TOO_LONG');
  return name;
}

export class Profiles {
  constructor(dataDir) {
    this.file = dataDir ? path.join(dataDir, 'profiles.json') : null;
    this.avatarDir = dataDir ? path.join(dataDir, 'avatars') : null;
    /** username -> { bio, avatar (file name) | null, showStats } */
    this.map = new Map(Object.entries((this.file && readJson(this.file, {})) || {}));
  }

  get(username) {
    return { bio: '', avatar: null, showStats: true, ...(this.map.get(username) || {}) };
  }

  set(username, patch) {
    this.map.set(username, { ...this.get(username), ...patch });
    if (this.file) writeJsonAtomic(this.file, Object.fromEntries(this.map));
  }

  avatarPath(username, file) {
    return path.join(this.avatarDir, username, file);
  }

  /** Replace the picture (old file removed). `buf` is checked by its first bytes, never by a declared type. */
  setAvatar(username, buf) {
    if (!this.avatarDir) throw new HttpError('Stockage indisponible', 501, 'NO_STORAGE');
    if (!Buffer.isBuffer(buf) || !buf.length) throw new HttpError('Envoyez une image JPEG, PNG ou WebP', 400, 'BAD_REQUEST');
    if (buf.length > MAX_AVATAR) throw new HttpError('Image trop lourde : 1 Mo au maximum', 413, 'TOO_LARGE');
    const ext = sniff(buf);
    if (!ext) throw new HttpError('Format d’image non reconnu (JPEG, PNG ou WebP)', 415, 'BAD_TYPE');
    const dir = path.join(this.avatarDir, username);
    fs.mkdirSync(dir, { recursive: true });
    const file = `${crypto.randomBytes(18).toString('base64url')}.${ext}`;
    fs.writeFileSync(path.join(dir, file), buf, { mode: 0o600 });
    this.removeAvatar(username);
    this.set(username, { avatar: file });
    return file;
  }

  removeAvatar(username) {
    const old = this.get(username).avatar;
    if (old && this.avatarDir) fs.rmSync(this.avatarPath(username, old), { force: true });
    if (old) this.set(username, { avatar: null });
  }
}

export const avatarUrl = (username, file) => (file ? `/api/avatars/${username}/${file}` : null);

/**
 * Routes. `activity` comes from registerActivity (nowOf, statsOf); `friends` decides who sees what.
 */
export function registerProfiles(app, { accounts, userData, friends, activity, profiles, hub }) {
  const me = (request) => request.user.username;
  // 30 profile changes per hour and per account (name, bio, options, picture).
  const limiter = new LoginLimiter({ max: 30, windowMs: 60 * 60 * 1000 });
  const write = (u) => {
    const wait = limiter.blocked(u);
    if (wait) throw new HttpError(`Trop de modifications, réessayez dans ${wait} min`, 429, 'RATE_LIMITED');
    limiter.fail(u);
  };
  const libraryOf = (u) => userData?.get(u).data || null;
  /** `target` if `viewer` may see it (itself or a friend, existing account), else the generic 404. */
  const visible = (viewer, raw) => {
    const target = normalizeUsername(raw);
    if (!isValidUsername(target) || !accounts.get(target)) throw notFound();
    if (target !== viewer && !friends.are(viewer, target)) throw notFound();
    return target;
  };
  const shown = (data) => (data?.library?.playlists || []).filter((p) => p.onProfile);
  const own = (u) => {
    const p = profiles.get(u);
    return { username: u, displayName: accounts.get(u)?.displayName || u, bio: p.bio, avatar: avatarUrl(u, p.avatar), showStats: p.showStats, shareActivity: sharing(libraryOf(u)) };
  };
  const changed = (u) => hub?.emit([u, ...friends.of(u).map((f) => f.username)], { type: 'profile', user: u });

  app.get('/api/me/profile', async (request) => ({ profile: own(me(request)) }));

  app.patch('/api/me/profile', async (request) => {
    const u = me(request);
    const body = request.body || {};
    // Validate everything before writing anything.
    const name = body.displayName !== undefined ? cleanName(body.displayName) : undefined;
    const bio = body.bio !== undefined ? cleanBio(body.bio) : undefined;
    if (body.showStats !== undefined && typeof body.showStats !== 'boolean') throw new HttpError('showStats doit être vrai ou faux', 400, 'BAD_REQUEST');
    write(u);
    if (name !== undefined && name !== accounts.get(u)?.displayName) accounts.setDisplayName(u, name);
    const patch = {};
    if (bio !== undefined) patch.bio = bio;
    if (body.showStats !== undefined) patch.showStats = body.showStats;
    if (Object.keys(patch).length) profiles.set(u, patch);
    changed(u);
    return { profile: own(u) };
  });

  app.post('/api/me/avatar', async (request) => {
    const u = me(request);
    write(u);
    const file = profiles.setAvatar(u, request.body);
    changed(u);
    return { avatar: avatarUrl(u, file) };
  });

  app.delete('/api/me/avatar', async (request) => {
    const u = me(request);
    write(u);
    profiles.removeAvatar(u);
    changed(u);
    return { ok: true };
  });

  app.get('/api/avatars/:user/:file', async (request, reply) => {
    const { user, file } = request.params;
    const target = visible(me(request), user);
    const current = profiles.get(target).avatar;
    // Only the current picture of someone you may see; an old or guessed address is the same 404.
    if (!FILE.test(String(file)) || file !== current) throw notFound();
    const full = profiles.avatarPath(target, file);
    if (!fs.existsSync(full)) throw notFound();
    reply.header('content-type', TYPES[file.split('.').pop()]).header('cache-control', 'private, max-age=3600').header('x-content-type-options', 'nosniff');
    return reply.send(fs.createReadStream(full));
  });

  /** What `viewer` sees of `raw`'s profile (generic 404 unless itself or a friend). Shared with the bot route (social.js). */
  const profileView = (viewer, raw) => {
    const target = visible(viewer, raw);
    const p = profiles.get(target);
    const data = libraryOf(target);
    const self = target === viewer;
    const withActivity = p.showStats && sharing(data);
    const stats = withActivity ? activity.statsOf(target, 28) : null;
    return {
      username: target,
      displayName: accounts.get(target)?.displayName || target,
      bio: p.bio,
      avatar: avatarUrl(target, p.avatar),
      self,
      friendsSince: self ? null : friends.of(viewer).find((f) => f.username === target)?.since ?? null,
      playlists: shown(data).map((pl) => ({
        id: pl.id, name: pl.name, description: pl.description, cover: pl.cover,
        count: pl.tracks.length,
        duration: pl.tracks.reduce((a, t) => a + (Number(t.duration) || 0), 0),
        thumbnails: pl.tracks.slice(0, 4).map((t) => t.thumbnail || null),
      })),
      // Activity and stats only if the person shares both (« Partager mon activité » + « sur mon profil »).
      activity: withActivity ? {
        now: activity.nowOf(target),
        stats: { days: stats.days, plays: stats.plays, minutes: stats.minutes, topArtists: stats.topArtists.slice(0, 5), topTracks: stats.topTracks.slice(0, 5) },
      } : null,
    };
  };

  app.get('/api/profiles/:username', async (request) => ({ profile: profileView(me(request), request.params.username) }));

  app.get('/api/profiles/:username/playlists/:id', async (request) => {
    const target = visible(me(request), request.params.username);
    const pl = shown(libraryOf(target)).find((x) => x.id === String(request.params.id));
    if (!pl) throw new HttpError('Playlist introuvable', 404, 'NOT_FOUND');
    return { playlist: { id: pl.id, name: pl.name, description: pl.description, cover: pl.cover, owner: target, tracks: pl.tracks } };
  });

  return { profileView };
}
