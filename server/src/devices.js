import { HttpError } from './util.js';
import { cleanTracks } from './userdata.js';
import { LoginLimiter } from './accounts.js';

/**
 * Remote control between the devices of ONE account (Spotify Connect style).
 *
 * A device is an open live-event stream (/api/events?device=<id>&name=<name>): it exists while that
 * connection is open and disappears when it closes (tab closed, app quit, network lost: the 25 s
 * ping fails). Nothing is written to disk. Each device reports its playback state; every device of
 * the account receives the list (`devices` event). A command is delivered to the target device's
 * own stream only, and only within the account (an unknown id or another account's id = 404).
 */

const ID = /^[A-Za-z0-9_-]{8,40}$/;
const MAX_DEVICES = 20;
const MAX_QUEUE = 1000;
const ACTIONS = new Set(['play', 'pause', 'next', 'prev', 'seek', 'volume', 'load', 'handoff']);

const cleanName = (name) => String(name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 60) || 'Appareil';
const num = (v, min, max) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : null);

export class Devices {
  constructor(hub) {
    this.hub = hub;
    /** @type {Map<string, Map<string, {id: string, name: string, kind: string, since: number, state: object|null, send: Function}>>} */
    this.byUser = new Map();
    this.reports = new LoginLimiter({ max: 240, windowMs: 60_000 });
    this.commands = new LoginLimiter({ max: 120, windowMs: 60_000 });
  }

  /** Called when a live-event stream opens; returns the cleanup to run when it closes (or null). */
  attach(username, query, send) {
    const id = String(query?.device || '');
    if (!ID.test(id)) return null;
    let mine = this.byUser.get(username);
    if (!mine) this.byUser.set(username, (mine = new Map()));
    if (!mine.has(id) && mine.size >= MAX_DEVICES) return null;
    const kind = ['web', 'desktop', 'android'].includes(query.kind) ? query.kind : 'web';
    const device = { id, name: cleanName(query.name), kind, since: Date.now(), state: null, send };
    mine.set(id, device);
    this.broadcast(username);
    return () => {
      // A reconnection of the same device replaced this entry: leave the new one alone.
      if (mine.get(id) !== device) return;
      mine.delete(id);
      if (!mine.size) this.byUser.delete(username);
      this.broadcast(username);
    };
  }

  list(username) {
    return [...(this.byUser.get(username)?.values() || [])].map(({ id, name, kind, since, state }) => ({ id, name, kind, since, state }));
  }

  broadcast(username) {
    this.hub.emit(username, { type: 'devices', devices: this.list(username), serverNow: Date.now() });
  }

  get(username, id) {
    const d = this.byUser.get(username)?.get(String(id));
    if (!d) throw new HttpError('Appareil introuvable ou déconnecté', 404, 'NO_DEVICE');
    return d;
  }

  rate(limiter, username) {
    const wait = limiter.blocked(username);
    if (wait) throw new HttpError(`Trop de requêtes, réessayez dans ${wait} min`, 429, 'RATE_LIMITED');
    limiter.fail(username);
  }

  /** Playback state reported by the device itself. Position is stamped with the server clock. */
  report(username, id, body = {}) {
    this.rate(this.reports, username);
    const d = this.get(username, id);
    if (body.name !== undefined) d.name = cleanName(body.name);
    const s = body.state && typeof body.state === 'object' ? body.state : null;
    d.state = s && {
      track: cleanTracks([s.track], 1)[0] || null,
      playing: !!s.playing,
      position: num(s.position, 0, 86_400) ?? 0,
      positionAt: Date.now(),
      volume: num(s.volume, 0, 1) ?? 1,
      jam: !!s.jam,
      hasNext: !!s.hasNext,
    };
    this.broadcast(username);
    return { ok: true };
  }

  /** Validate a command and deliver it to the target device of the same account. */
  command(username, id, body = {}) {
    this.rate(this.commands, username);
    const d = this.get(username, id);
    const action = String(body.action || '');
    if (!ACTIONS.has(action)) throw new HttpError('Commande inconnue', 400, 'BAD_COMMAND');
    // An écoute partagée drives that device's playback: no remote control meanwhile.
    if (d.state?.jam) throw new HttpError('Cet appareil est dans une écoute partagée', 409, 'IN_JAM');
    const cmd = { type: 'device-command', to: d.id, action, from: body.from && ID.test(String(body.from)) ? String(body.from) : null };
    if (action === 'seek') {
      cmd.position = num(body.position, 0, 86_400);
      if (cmd.position === null) throw new HttpError('Position invalide', 400, 'BAD_COMMAND');
    } else if (action === 'volume') {
      cmd.volume = num(body.volume, 0, 1);
      if (cmd.volume === null) throw new HttpError('Volume invalide', 400, 'BAD_COMMAND');
    } else if (action === 'load') {
      cmd.tracks = cleanTracks(body.tracks, MAX_QUEUE);
      if (!cmd.tracks.length) throw new HttpError('Aucun titre à transférer', 400, 'BAD_COMMAND');
      cmd.index = Math.min(cmd.tracks.length - 1, Math.max(0, Math.trunc(Number(body.index) || 0)));
      cmd.position = num(body.position, 0, 86_400) ?? 0;
      cmd.playing = body.playing !== false;
    } else if (action === 'handoff') {
      // « Transfer what you play to device X »: X must be a device of the same account too.
      cmd.target = this.get(username, body.target).id;
      if (cmd.target === d.id) throw new HttpError('Choisissez un autre appareil', 400, 'BAD_COMMAND');
    }
    d.send(cmd);
    return { ok: true };
  }
}

export function registerDevices(app, { devices }) {
  const me = (request) => request.user.username;
  app.get('/api/devices', async (request) => ({ devices: devices.list(me(request)), serverNow: Date.now() }));
  app.post('/api/devices/:id/state', async (request) => devices.report(me(request), request.params.id, request.body || {}));
  app.post('/api/devices/:id/command', async (request) => devices.command(me(request), request.params.id, request.body || {}));
}
