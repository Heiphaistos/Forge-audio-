import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

/**
 * User accounts, sessions and login throttling.
 *
 * Accounts live in a JSON file ({ users: [{ username, displayName, password }] }) where `password`
 * is a scrypt hash. With no account configured the server runs in single-user "local" mode
 * (desktop app, private installs): no login page, data saved under the `local` user.
 */

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

export const PASSWORD_MIN = 75;
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
// No quotes, backslash or spaces: easy to paste anywhere.
const SYMBOLS = '!#$%&*+-=?@^_~.:;,()[]{}<>|/';

/** Password policy: at least 75 characters with upper case, lower case, digits and symbols. */
export function checkPasswordPolicy(pw) {
  const s = String(pw || '');
  const problems = [];
  if (s.length < PASSWORD_MIN) problems.push(`au moins ${PASSWORD_MIN} caractères`);
  if (!/[A-Z]/.test(s)) problems.push('une majuscule');
  if (!/[a-z]/.test(s)) problems.push('une minuscule');
  if (!/[0-9]/.test(s)) problems.push('un chiffre');
  if (!/[^A-Za-z0-9]/.test(s)) problems.push('un symbole');
  return problems;
}

/** Random password meeting the policy (CSPRNG, every class guaranteed). */
export function generatePassword(length = 80) {
  const all = UPPER + LOWER + DIGITS + SYMBOLS;
  const pick = (set) => set[crypto.randomInt(set.length)];
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < Math.max(length, PASSWORD_MIN)) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password), salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const got = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(got, expected);
}

export function normalizeUsername(name) {
  return String(name || '').trim().toLowerCase();
}

export function isValidUsername(name) {
  return /^[a-z0-9][a-z0-9._-]{1,31}$/.test(name);
}

/** Write a file atomically (temp file + rename) so a crash never leaves half a JSON document. */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export class Accounts {
  /** @param {string} file accounts JSON path */
  constructor(file) {
    this.file = file;
    this.users = new Map();
    this.mtime = null;
    this.reload();
  }

  /** Pick up changes made by accounts-cli.js (another process) without a restart. */
  refresh() {
    let mtime = null;
    try { mtime = fs.statSync(this.file).mtimeMs; } catch { /* no file: no account */ }
    if (mtime !== this.mtime) this.reload();
  }

  reload() {
    this.users.clear();
    try { this.mtime = this.file ? fs.statSync(this.file).mtimeMs : null; } catch { this.mtime = null; }
    const data = this.file ? readJson(this.file, { users: [] }) : { users: [] };
    for (const u of data.users || []) {
      const username = normalizeUsername(u.username);
      if (isValidUsername(username) && u.password) this.users.set(username, { username, displayName: u.displayName || username, password: u.password, since: Number(u.since) || 0 });
    }
  }

  get enabled() {
    this.refresh();
    return this.users.size > 0;
  }

  get(username) {
    this.refresh();
    return this.users.get(normalizeUsername(username)) || null;
  }

  list() {
    return [...this.users.values()].map(({ username, displayName }) => ({ username, displayName }));
  }

  save() {
    writeJsonAtomic(this.file, { users: [...this.users.values()] });
  }

  async set(username, displayName, password) {
    const name = normalizeUsername(username);
    if (!isValidUsername(name)) throw new Error(`Nom d'utilisateur invalide : ${username}`);
    const problems = checkPasswordPolicy(password);
    if (problems.length) throw new Error(`Mot de passe trop faible : il faut ${problems.join(', ')}`);
    this.users.set(name, { username: name, displayName: displayName || this.users.get(name)?.displayName || name, password: await hashPassword(password), since: Date.now() });
    this.save();
  }

  remove(username) {
    const ok = this.users.delete(normalizeUsername(username));
    if (ok) this.save();
    return ok;
  }

  /** Check credentials in constant-ish time (unknown users still pay for a hash). */
  async authenticate(username, password) {
    const user = this.get(username);
    const ok = await verifyPassword(password, user?.password || DUMMY_HASH);
    return ok && user ? { username: user.username, displayName: user.displayName } : null;
  }
}

// Hash of a random string: verifying against it costs the same as a real account.
const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(KEYLEN).toString('base64');

const SESSION_TTL = 180 * 24 * 3600 * 1000;

/** Login sessions: only a SHA-256 of each token is stored on disk. */
export class Sessions {
  constructor(file) {
    this.file = file;
    this.map = new Map(Object.entries(file ? readJson(file, {}) : {}));
    this.timer = null;
    this.prune();
  }

  static hash(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  }

  create(username) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.map.set(Sessions.hash(token), { username, created: Date.now(), expires: Date.now() + SESSION_TTL });
    this.persist();
    return token;
  }

  get(token) {
    if (!token) return null;
    const s = this.map.get(Sessions.hash(token));
    if (!s) return null;
    if (s.expires < Date.now()) {
      this.map.delete(Sessions.hash(token));
      this.persist();
      return null;
    }
    return s;
  }

  destroy(token) {
    if (token && this.map.delete(Sessions.hash(token))) this.persist();
  }

  destroyUser(username) {
    for (const [k, s] of this.map) if (s.username === username) this.map.delete(k);
    this.persist();
  }

  prune() {
    const now = Date.now();
    for (const [k, s] of this.map) if (s.expires < now) this.map.delete(k);
  }

  persist() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.prune();
      try { writeJsonAtomic(this.file, Object.fromEntries(this.map)); } catch { /* read-only disk: sessions stay in memory */ }
    }, 200);
    this.timer.unref?.();
  }
}

/** Failed-login throttle per IP: 8 failures per 15 minutes. */
export class LoginLimiter {
  constructor({ max = 8, windowMs = 15 * 60 * 1000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  blocked(ip) {
    const h = this.hits.get(ip);
    if (!h) return 0;
    if (Date.now() - h.first > this.windowMs) {
      this.hits.delete(ip);
      return 0;
    }
    return h.count >= this.max ? Math.ceil((h.first + this.windowMs - Date.now()) / 60000) : 0;
  }

  fail(ip) {
    const h = this.hits.get(ip);
    if (!h || Date.now() - h.first > this.windowMs) this.hits.set(ip, { first: Date.now(), count: 1 });
    else h.count += 1;
  }

  reset(ip) {
    this.hits.delete(ip);
  }
}
