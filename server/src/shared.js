import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './util.js';
import { readJson, writeJsonAtomic } from './accounts.js';
import { cleanTracks } from './userdata.js';

/**
 * Playlists shared between accounts (Spotify "collaborative playlists"): the owner shares with
 * other accounts, every member can add, remove and reorder tracks; only the owner renames,
 * changes the members or deletes. Saved in <data>/shared.json; changes are pushed live to members.
 */

const MAX_PLAYLISTS = 500;
const MAX_TRACKS = 5000;
const MAX_MEMBERS = 50;

export class SharedPlaylists {
  constructor(dataDir) {
    this.file = dataDir ? path.join(dataDir, 'shared.json') : null;
    this.lists = new Map(Object.entries((this.file && readJson(this.file, { playlists: {} }).playlists) || {}));
  }

  save() {
    if (this.file) writeJsonAtomic(this.file, { playlists: Object.fromEntries(this.lists) });
  }

  /** Everyone concerned by a playlist (owner + members): who gets the live update. */
  audience(p) {
    return [p.owner, ...p.members];
  }

  forUser(username) {
    return [...this.lists.values()].filter((p) => p.owner === username || p.members.includes(username))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id, username) {
    const p = this.lists.get(String(id));
    if (!p || (p.owner !== username && !p.members.includes(username))) throw new HttpError('Playlist partagée introuvable', 404, 'NOT_FOUND');
    return p;
  }

  owned(id, username) {
    const p = this.get(id, username);
    if (p.owner !== username) throw new HttpError('Seul le créateur de la playlist peut faire cela', 403, 'FORBIDDEN');
    return p;
  }

  touch(p) {
    p.updatedAt = Date.now();
    p.rev = (p.rev || 0) + 1;
    this.save();
    return p;
  }

  create(owner, { name, description = '', cover = null, tracks = [], members = [] }, isAccount) {
    if (this.forUser(owner).filter((p) => p.owner === owner).length >= MAX_PLAYLISTS) throw new HttpError('Trop de playlists partagées', 400);
    const now = Date.now();
    const p = {
      id: crypto.randomBytes(9).toString('base64url'),
      name: String(name || '').trim().slice(0, 200) || 'Playlist partagée',
      description: String(description || '').slice(0, 2000),
      cover: typeof cover === 'string' && /^https?:\/\//.test(cover) ? cover : null,
      owner,
      members: this.cleanMembers(owner, members, isAccount),
      tracks: cleanTracks(tracks, MAX_TRACKS).map((t) => ({ ...t, addedBy: owner, addedAt: t.addedAt || now })),
      createdAt: now,
      updatedAt: now,
      rev: 1,
    };
    this.lists.set(p.id, p);
    this.save();
    return p;
  }

  cleanMembers(owner, members, isAccount) {
    const list = [...new Set((Array.isArray(members) ? members : []).map((m) => String(m).trim().toLowerCase()))]
      .filter((m) => m && m !== owner && isAccount(m));
    if (list.length > MAX_MEMBERS) throw new HttpError(`${MAX_MEMBERS} membres au maximum`, 400);
    return list;
  }

  update(id, username, patch, isAccount) {
    const p = this.owned(id, username);
    if (patch.name !== undefined) p.name = String(patch.name).trim().slice(0, 200) || p.name;
    if (patch.description !== undefined) p.description = String(patch.description).slice(0, 2000);
    if (patch.cover !== undefined) p.cover = typeof patch.cover === 'string' && /^https?:\/\//.test(patch.cover) ? patch.cover : null;
    const before = this.audience(p);
    if (patch.members !== undefined) p.members = this.cleanMembers(p.owner, patch.members, isAccount);
    this.touch(p);
    return { playlist: p, notify: [...new Set([...before, ...this.audience(p)])] };
  }

  addTracks(id, username, tracks) {
    const p = this.get(id, username);
    const have = new Set(p.tracks.map((t) => t.url));
    const now = Date.now();
    const fresh = cleanTracks(tracks, MAX_TRACKS).filter((t) => !have.has(t.url) && have.add(t.url)).map((t) => ({ ...t, addedBy: username, addedAt: now }));
    if (p.tracks.length + fresh.length > MAX_TRACKS) throw new HttpError(`${MAX_TRACKS} titres au maximum`, 400);
    p.tracks.push(...fresh);
    if (fresh.length) this.touch(p);
    return { playlist: p, added: fresh.length };
  }

  removeTrack(id, username, url) {
    const p = this.get(id, username);
    const n = p.tracks.length;
    p.tracks = p.tracks.filter((t) => t.url !== url);
    if (p.tracks.length !== n) this.touch(p);
    return p;
  }

  moveTrack(id, username, from, to) {
    const p = this.get(id, username);
    const f = Number(from); const t = Number(to);
    if (!Number.isInteger(f) || !Number.isInteger(t) || f < 0 || t < 0 || f >= p.tracks.length || t >= p.tracks.length) throw new HttpError('Position invalide', 400);
    const [m] = p.tracks.splice(f, 1);
    p.tracks.splice(t, 0, m);
    return this.touch(p);
  }

  /** A member leaves; the owner deletes. Returns who must be told. */
  leaveOrDelete(id, username) {
    const p = this.get(id, username);
    const audience = this.audience(p);
    if (p.owner === username) this.lists.delete(p.id);
    else p.members = p.members.filter((m) => m !== username);
    this.save();
    return { deleted: p.owner === username, notify: audience };
  }
}
