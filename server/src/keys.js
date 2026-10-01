import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './util.js';
import { readJson, writeJsonAtomic } from './accounts.js';
import { targetName } from './friends.js';

/**
 * Public keys for end-to-end encrypted private messages (<data>/keys.json).
 *
 * Each account has an ECDH P-256 key pair made in the browser. The server keeps the public key
 * (raw, base64) and the private key ENCRYPTED in the browser with a key derived from the user's
 * password (PBKDF2-SHA-256 ≥ 600 000 rounds + AES-GCM): the server can never use it.
 * When an administrator resets the password (accounts-cli passwd: account `since` moves past the
 * key's `at`), the envelope cannot be opened any more: the key is retired into `old` (public part
 * only, so friends still read what they exchanged with it) and the browser makes a new pair.
 */
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
export const MIN_ITER = 600_000;
const MAX_ITER = 10_000_000;
const KEEP_OLD = 20;

/** Bytes of a standard base64 string, or null. */
export function bytesOf(value, min, max) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || !B64.test(value)) return null;
  const buf = Buffer.from(value, 'base64');
  return buf.length >= min && buf.length <= max && buf.toString('base64') === value ? buf : null;
}

export const fingerprint = (pub) => crypto.createHash('sha256').update(Buffer.from(pub, 'base64')).digest('hex');

/** A real P-256 point (65 bytes, uncompressed), checked by importing it. */
async function checkPublicKey(pub) {
  const raw = bytesOf(pub, 65, 65);
  if (!raw || raw[0] !== 4) return false;
  try {
    await crypto.webcrypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    return true;
  } catch {
    return false;
  }
}

/** The password envelope of the private key: only sizes and rounds are checked, the content is opaque. */
export function checkWrapped(w) {
  if (!w || typeof w !== 'object' || w.v !== 1) return null;
  const iter = Number(w.iter);
  if (!Number.isInteger(iter) || iter < MIN_ITER || iter > MAX_ITER) return null;
  if (!bytesOf(w.salt, 16, 16) || !bytesOf(w.iv, 12, 12) || !bytesOf(w.ct, 48, 1024)) return null;
  return { v: 1, iter, salt: w.salt, iv: w.iv, ct: w.ct };
}

export class Keys {
  constructor(dataDir) {
    this.file = dataDir ? path.join(dataDir, 'keys.json') : null;
    this.users = (this.file && readJson(this.file, null)?.users) || {};
  }

  save() {
    if (this.file) writeJsonAtomic(this.file, { users: this.users });
  }

  /** The usable key of `username` (null if none), retiring it after an admin password reset. */
  current(username, accounts) {
    const rec = this.users[username];
    if (!rec?.pub) return null;
    const since = accounts.get(username)?.since || 0;
    if (rec.at >= since) return rec;
    rec.old = [{ pub: rec.pub, fp: rec.fp, at: rec.at, until: Date.now() }, ...(rec.old || [])].slice(0, KEEP_OLD);
    delete rec.pub; delete rec.fp; delete rec.wrapped; delete rec.at;
    this.save();
    return null;
  }

  /** Current + retired public keys (never the envelope). */
  publicOf(username, accounts) {
    const cur = this.current(username, accounts);
    return { current: cur ? { pub: cur.pub, fp: cur.fp } : null, old: (this.users[username]?.old || []).map(({ pub, fp }) => ({ pub, fp })) };
  }

  set(username, pub, wrapped, at = Date.now()) {
    const rec = (this.users[username] ||= {});
    Object.assign(rec, { pub, fp: fingerprint(pub), wrapped, at });
    this.save();
    return rec;
  }

  /** New envelope for the same key (password changed by the user): stays valid past the new `since`. */
  rewrap(username, wrapped, at) {
    const rec = this.users[username];
    if (!rec?.pub) return;
    Object.assign(rec, { wrapped, at });
    this.save();
  }
}

export function registerKeys(app, { accounts, friends, messages, keys }) {
  const me = (request) => request.user.username;

  app.get('/api/me/keys', async (request) => {
    const cur = keys.current(me(request), accounts);
    return { key: cur ? { pub: cur.pub, fp: cur.fp, wrapped: cur.wrapped, at: cur.at } : null };
  });

  // Only when there is no key yet (first sign-in after 0.18, or after an admin reset): never overwritten.
  app.put('/api/me/keys', async (request) => {
    const u = me(request);
    const { pub } = request.body || {};
    const wrapped = checkWrapped(request.body?.wrapped);
    if (!wrapped || !(await checkPublicKey(pub))) throw new HttpError('Clé invalide', 400, 'BAD_KEY');
    if (keys.current(u, accounts)) throw new HttpError('Une clé existe déjà pour ce compte', 409, 'KEY_EXISTS');
    const rec = keys.set(u, pub, wrapped);
    request.log.info({ user: u }, 'Nouvelle clé de messagerie');
    return { key: { pub: rec.pub, fp: rec.fp, wrapped: rec.wrapped, at: rec.at } };
  });

  // Public keys of a friend, or of someone one already has a conversation with (to read it).
  app.get('/api/keys/:username', async (request) => {
    const u = me(request);
    const other = targetName(request.params.username, u);
    messages.all(u);
    if (!friends.are(u, other) && !messages.cache.has(messages.key(u, other))) throw new HttpError('Introuvable', 404, 'NOT_FOUND');
    return { username: other, ...keys.publicOf(other, accounts) };
  });
}
