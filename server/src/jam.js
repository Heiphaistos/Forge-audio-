import crypto from 'node:crypto';
import { HttpError } from './util.js';
import { cleanTracks } from './userdata.js';
import { cleanText } from './messages.js';

/**
 * Jam (Spotify-style group session): a host starts it, friends join with a code or an invitation,
 * everybody adds tracks to one shared queue and each device plays the same track at the same
 * position. The host controls playback (or everyone, if the host allows it).
 *
 * Kept in memory: a Jam ends when its host leaves or after 12 h without activity (and at a restart).
 * Position model: `position` seconds at server time `positionAt`; while playing, the current
 * position is position + (now - positionAt) / 1000. Clients correct their drift from it.
 */

const MAX_QUEUE = 1000;
const MAX_PARTICIPANTS = 50;
const IDLE_MS = 12 * 3600 * 1000;
const MAX_CHAT = 200;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class JamHub {
  constructor(hub) {
    this.hub = hub;
    /** @type {Map<string, object>} */
    this.jams = new Map();
    this.byUser = new Map();
    setInterval(() => this.sweep(), 10 * 60 * 1000).unref?.();
  }

  sweep() {
    for (const j of this.jams.values()) if (Date.now() - j.updatedAt > IDLE_MS) this.end(j, 'Écoute partagée terminée (inactive depuis 12 h)');
  }

  code() {
    for (;;) {
      const c = Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
      if (![...this.jams.values()].some((j) => j.code === c)) return c;
    }
  }

  /** Public state sent to participants (live position included). */
  view(j) {
    return {
      id: j.id, code: j.code, host: j.host, everyoneControls: j.everyoneControls,
      participants: [...j.participants.values()],
      queue: j.queue, index: j.index, playing: j.playing,
      position: j.position, positionAt: j.positionAt, serverNow: Date.now(),
      createdAt: j.createdAt,
    };
  }

  broadcast(j, extra = {}) {
    j.updatedAt = Date.now();
    this.hub.emit([...j.participants.keys()], { type: 'jam', jam: this.view(j), ...extra });
  }

  livePosition(j) {
    return j.playing ? j.position + (Date.now() - j.positionAt) / 1000 : j.position;
  }

  mine(username) {
    const id = this.byUser.get(username);
    return id ? this.jams.get(id) || null : null;
  }

  require(id, username) {
    const j = this.jams.get(String(id));
    if (!j || !j.participants.has(username)) throw new HttpError('Écoute partagée introuvable ou terminée', 404, 'NO_JAM');
    return j;
  }

  person(user) {
    return { username: user.username, displayName: user.displayName || user.username, joinedAt: Date.now() };
  }

  create(user, { tracks = [], index = 0, position = 0, playing = false } = {}) {
    const old = this.mine(user.username);
    if (old) this.leave(old.id, user.username);
    const queue = cleanTracks(tracks, MAX_QUEUE).map((t) => ({ ...t, addedBy: user.username }));
    const now = Date.now();
    const j = {
      id: crypto.randomBytes(9).toString('base64url'), code: this.code(), host: user.username, everyoneControls: false,
      participants: new Map([[user.username, this.person(user)]]),
      chat: [],
      queue, index: queue.length ? Math.min(Math.max(0, Number(index) || 0), queue.length - 1) : -1,
      playing: !!playing && queue.length > 0, position: Math.max(0, Number(position) || 0), positionAt: now,
      createdAt: now, updatedAt: now,
    };
    this.jams.set(j.id, j);
    this.byUser.set(user.username, j.id);
    this.broadcast(j);
    return this.view(j);
  }

  /** `refused(host)`: true when the host and this user blocked each other (same answer as a wrong code). */
  join(user, code, refused = () => false) {
    const j = [...this.jams.values()].find((x) => x.code === String(code || '').trim().toUpperCase());
    if (!j || (!j.participants.has(user.username) && refused(j.host))) throw new HttpError('Aucune écoute partagée avec ce code', 404, 'NO_JAM');
    if (!j.participants.has(user.username)) {
      if (j.participants.size >= MAX_PARTICIPANTS) throw new HttpError('Cette écoute partagée est complète', 400);
      const old = this.mine(user.username);
      if (old && old.id !== j.id) this.leave(old.id, user.username);
      j.participants.set(user.username, this.person(user));
      this.byUser.set(user.username, j.id);
    }
    this.broadcast(j, { joined: user.username });
    return this.view(j);
  }

  leave(id, username) {
    const j = this.require(id, username);
    if (j.host === username) return this.end(j, 'L\'hôte a terminé l’écoute partagée');
    j.participants.delete(username);
    this.byUser.delete(username);
    this.hub.emit(username, { type: 'jam', jam: null });
    this.broadcast(j, { left: username });
    return null;
  }

  end(j, reason) {
    const people = [...j.participants.keys()];
    this.jams.delete(j.id);
    for (const u of people) if (this.byUser.get(u) === j.id) this.byUser.delete(u);
    this.hub.emit(people, { type: 'jam', jam: null, reason });
    return null;
  }

  /** Friends only: `isFriend(target)` (an unknown account gets the same answer). */
  invite(id, from, to, isFriend) {
    const j = this.require(id, from.username);
    const target = String(to || '').trim().toLowerCase();
    if (!isFriend(target) || target === from.username) throw new HttpError('Vous ne pouvez inviter que vos amis', 403, 'NOT_FRIENDS');
    this.hub.emit(target, { type: 'jam-invite', code: j.code, from: from.displayName || from.username, host: j.host });
    return { online: this.hub.online(target) };
  }

  /** Text chat of the Jam: in memory only, gone when the Jam ends. */
  say(id, user, text) {
    const j = this.require(id, user.username);
    const clean = cleanText(text);
    const last = j.chat[j.chat.length - 1];
    const message = { id: crypto.randomBytes(8).toString('base64url'), from: user.username, displayName: user.displayName || user.username, text: clean, at: Math.max(Date.now(), (last?.at || 0) + 1) };
    j.chat.push(message);
    if (j.chat.length > MAX_CHAT) j.chat.splice(0, j.chat.length - MAX_CHAT);
    j.updatedAt = Date.now();
    this.hub.emit([...j.participants.keys()], { type: 'jam-chat', jamId: j.id, message });
    return message;
  }

  chatOf(id, username) {
    return this.require(id, username).chat;
  }

  canControl(j, username) {
    return j.host === username || j.everyoneControls;
  }

  add(id, username, tracks, next = false) {
    const j = this.require(id, username);
    const fresh = cleanTracks(tracks, MAX_QUEUE).map((t) => ({ ...t, addedBy: username }));
    if (!fresh.length) throw new HttpError('Aucun titre à ajouter', 400);
    if (j.queue.length + fresh.length > MAX_QUEUE) throw new HttpError(`${MAX_QUEUE} titres au maximum dans une écoute partagée`, 400);
    if (next && j.index >= 0) j.queue.splice(j.index + 1, 0, ...fresh);
    else j.queue.push(...fresh);
    if (j.index < 0) { j.index = 0; j.position = 0; j.positionAt = Date.now(); }
    this.broadcast(j, { added: { by: username, count: fresh.length, title: fresh[0].title } });
    return this.view(j);
  }

  remove(id, username, index) {
    const j = this.require(id, username);
    const i = Number(index);
    const t = j.queue[i];
    if (!t) throw new HttpError('Titre introuvable', 400);
    if (i === j.index) throw new HttpError('Impossible de retirer le titre en cours', 400);
    // Everyone removes what they added; the host (or everyone when allowed) removes anything.
    if (t.addedBy !== username && !this.canControl(j, username)) throw new HttpError('Seul l\'hôte peut retirer les titres des autres', 403, 'FORBIDDEN');
    j.queue.splice(i, 1);
    if (i < j.index) j.index -= 1;
    this.broadcast(j);
    return this.view(j);
  }

  settings(id, username, { everyoneControls }) {
    const j = this.require(id, username);
    if (j.host !== username) throw new HttpError('Seul l\'hôte peut changer ce réglage', 403, 'FORBIDDEN');
    j.everyoneControls = !!everyoneControls;
    this.broadcast(j);
    return this.view(j);
  }

  /**
   * Playback control. `advance` (track ended on the host) is idempotent: it only moves on when
   * `from` is still the current index, so several devices ending at once skip a single track.
   */
  control(id, username, { action, position, index, from }) {
    const j = this.require(id, username);
    if (action !== 'advance' && !this.canControl(j, username)) throw new HttpError('Seul l\'hôte contrôle la lecture de cette écoute partagée', 403, 'FORBIDDEN');
    if (action === 'advance' && j.host !== username && !j.everyoneControls) return this.view(j);
    const now = Date.now();
    const go = (i) => { j.index = i; j.position = 0; j.positionAt = now; };
    switch (action) {
      case 'play': j.position = this.livePosition(j); j.positionAt = now; j.playing = j.index >= 0; break;
      case 'pause': j.position = this.livePosition(j); j.positionAt = now; j.playing = false; break;
      case 'seek': j.position = Math.max(0, Number(position) || 0); j.positionAt = now; break;
      case 'jump': if (!j.queue[Number(index)]) throw new HttpError('Titre introuvable', 400); go(Number(index)); j.playing = true; break;
      case 'next': if (j.index < j.queue.length - 1) go(j.index + 1); else { j.playing = false; j.position = this.livePosition(j); j.positionAt = now; } break;
      case 'prev': if (this.livePosition(j) > 4 || j.index <= 0) { j.position = 0; j.positionAt = now; } else go(j.index - 1); break;
      case 'advance':
        if (Number(from) !== j.index) return this.view(j);
        if (j.index < j.queue.length - 1) go(j.index + 1); else { j.playing = false; j.position = 0; j.positionAt = now; }
        break;
      default: throw new HttpError('Action inconnue', 400);
    }
    this.broadcast(j);
    return this.view(j);
  }
}
