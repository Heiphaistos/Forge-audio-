import crypto from 'node:crypto';
import { readJson, writeJsonAtomic } from './accounts.js';
import { HttpError, clampInt } from './util.js';

/**
 * Invitation codes (data/invites.json). Only a SHA-256 of each code is stored: the code is shown once,
 * at creation. Single use, with an expiry (7 days by default) and an optional note ("pour Loris").
 */
const DAY = 24 * 3600 * 1000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L

const hashCode = (code) => crypto.createHash('sha256').update(String(code || '').trim().toUpperCase()).digest('hex');

export class Invites {
  /** @param {string|null} file invites JSON (null: memory only) */
  constructor(file) {
    this.file = file;
    this.list = file ? readJson(file, { invites: [] }).invites || [] : [];
  }

  save() {
    if (this.file) writeJsonAtomic(this.file, { invites: this.list });
  }

  /** New code, returned in clear this one time. */
  create(createdBy, { days = 7, note = '' } = {}) {
    const part = () => Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
    const code = `FORGE-${part()}-${part()}-${part()}`;
    const now = Date.now();
    const invite = {
      id: crypto.randomBytes(6).toString('hex'),
      hash: hashCode(code),
      note: String(note || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100),
      createdBy,
      createdAt: now,
      expiresAt: now + clampInt(days, 1, 90, 7) * DAY,
      usedBy: null,
      usedAt: null,
      revokedAt: null,
    };
    this.list.push(invite);
    this.save();
    return { code, invite: Invites.view(invite) };
  }

  static status(i, now = Date.now()) {
    if (i.usedBy) return 'used';
    if (i.revokedAt) return 'revoked';
    return i.expiresAt < now ? 'expired' : 'active';
  }

  static view(i) {
    const { hash, ...rest } = i; // eslint-disable-line no-unused-vars
    return { ...rest, status: Invites.status(i) };
  }

  all() {
    return [...this.list].sort((a, b) => b.createdAt - a.createdAt).map(Invites.view);
  }

  /** The active invite matching `code`, or null. */
  find(code) {
    const h = hashCode(code);
    return this.list.find((i) => i.hash === h && Invites.status(i) === 'active') || null;
  }

  /** Mark as used. Synchronous: call right after find() with no await in between (single use). */
  consume(invite, username) {
    invite.usedBy = username;
    invite.usedAt = Date.now();
    this.save();
  }

  revoke(id) {
    const i = this.list.find((x) => x.id === id);
    if (!i) return 'missing';
    if (i.usedBy) return 'used';
    i.revokedAt ??= Date.now();
    this.save();
    return 'ok';
  }
}

/** Admin API: invitation codes and account list (403 unless the signed-in user is an admin). */
export function registerAdmin(app, { accounts, invites }) {
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/admin/')) return;
    if (request.user?.role !== 'admin') throw new HttpError('Réservé aux administrateurs', 403, 'FORBIDDEN');
  });

  app.get('/api/admin/invites', async () => ({ invites: invites.all() }));
  app.post('/api/admin/invites', async (request, reply) => {
    const { days, note } = request.body || {};
    reply.code(201);
    return invites.create(request.user.username, { days, note });
  });
  app.delete('/api/admin/invites/:id', async (request) => {
    const r = invites.revoke(String(request.params.id));
    if (r === 'missing') throw new HttpError('Code introuvable', 404, 'NOT_FOUND');
    if (r === 'used') throw new HttpError('Code déjà utilisé', 409, 'CONFLICT');
    return { ok: true };
  });
  app.get('/api/admin/accounts', async () => ({ accounts: accounts.adminList() }));
}
