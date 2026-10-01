import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './util.js';
import { readJson, writeJsonAtomic, LoginLimiter } from './accounts.js';
import { targetName } from './friends.js';
import { bytesOf } from './keys.js';

/**
 * Private messages between friends (1-to-1) and the text chat of a Jam.
 *
 * Conversations live in <data>/messages/<a>+<b>.json (usernames sorted; `+` is not allowed in a
 * username), at most the last 500 messages each. Private messages are end-to-end encrypted (0.18):
 * the server only stores { from, at, v, iv, ct, fp, toFp } (AES-GCM, keys made in the browsers,
 * see keys.js) and never sees the text. The Jam chat stays plain text, in memory only. Deleting a conversation hides it for oneself;
 * once both sides deleted it, the messages are erased from the disk. Only friends can write;
 * anyone keeps reading their own past conversations.
 */
export const MAX_TEXT = 1000;
const KEEP = 500;

/** Control and bidi/zero-width characters (newline and tab kept). */
export const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g;

/** Plain text, 1 to 1000 characters, control characters removed (newlines and tabs kept). */
export function cleanText(raw) {
  if (typeof raw !== 'string') throw new HttpError('Message vide', 400, 'EMPTY');
  const text = raw.replace(/\r\n?/g, '\n').replace(CONTROL, '').trim();
  if (!text) throw new HttpError('Message vide', 400, 'EMPTY');
  if (text.length > MAX_TEXT) throw new HttpError(`${MAX_TEXT} caractères au maximum`, 400, 'TOO_LONG');
  return text;
}

/** 1000 characters of UTF-8 (≤ 4 bytes each) + the 16-byte AES-GCM tag. */
const MAX_CT = MAX_TEXT * 4 + 16;
const FP = /^[0-9a-f]{64}$/;

/** An encrypted message as sent by the browser: any clear-text field is refused, sizes are re-checked. */
export function cleanSealed(body) {
  if (!body || typeof body !== 'object') throw new HttpError('Message vide', 400, 'EMPTY');
  if ('text' in body) throw new HttpError('Les messages privés doivent être chiffrés : rechargez la page', 400, 'PLAINTEXT_REFUSED');
  if (body.v !== 1) throw new HttpError('Version de chiffrement inconnue : rechargez la page', 400, 'BAD_VERSION');
  if (!bytesOf(body.iv, 12, 12)) throw new HttpError('Message chiffré invalide', 400, 'BAD_MESSAGE');
  if (!bytesOf(body.ct, 17, MAX_CT)) throw new HttpError(`${MAX_TEXT} caractères au maximum`, 400, 'TOO_LONG');
  if (!FP.test(String(body.fp)) || !FP.test(String(body.toFp))) throw new HttpError('Message chiffré invalide', 400, 'BAD_MESSAGE');
  return { v: 1, iv: body.iv, ct: body.ct, fp: body.fp, toFp: body.toFp };
}

/** 30 messages per minute and per account (private messages and Jam chat counted separately). */
export const messageLimiter = () => new LoginLimiter({ max: 30, windowMs: 60 * 1000 });

export function checkRate(limiter, username) {
  const wait = limiter.blocked(username);
  if (wait) throw new HttpError(`Trop de messages, réessayez dans ${wait} min`, 429, 'RATE_LIMITED');
  limiter.fail(username);
}

export class Messages {
  constructor(dataDir, log = null) {
    this.dir = dataDir ? path.join(dataDir, 'messages') : null;
    /** key -> conversation (loaded on first use) */
    this.cache = new Map();
    this.loadedAll = !this.dir;
    if (this.dir) this.purgeClear(log);
  }

  /**
   * Since 0.18 nothing is kept in clear: messages saved by older versions (plain `text`) are erased
   * at start-up, file overwritten with zeros before it is deleted.
   */
  purgeClear(log) {
    let files = 0;
    let count = 0;
    for (const f of fs.existsSync(this.dir) ? fs.readdirSync(this.dir) : []) {
      if (!f.endsWith('.json')) continue;
      const file = path.join(this.dir, f);
      const saved = readJson(file, null);
      const plain = (saved?.messages || []).filter((m) => !m?.ct);
      if (saved && !plain.length) continue;
      try { fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size)); } catch { /* deleted below anyway */ }
      fs.rmSync(file, { force: true });
      const kept = (saved?.messages || []).filter((m) => m?.ct);
      if (kept.length) writeJsonAtomic(file, { ...saved, messages: kept });
      files += 1;
      count += plain.length;
    }
    if (files) log?.warn?.({ conversations: files, messages: count }, 'Messages privés en clair effacés (passage au chiffrement de bout en bout)');
  }

  key(a, b) {
    return a < b ? `${a}+${b}` : `${b}+${a}`;
  }

  load(key) {
    if (!this.cache.has(key)) {
      const [a, b] = key.split('+');
      const saved = this.dir && readJson(path.join(this.dir, `${key}.json`), null);
      // Never hand out anything that is not encrypted.
      if (saved) saved.messages = (saved.messages || []).filter((m) => m?.ct);
      this.cache.set(key, saved || { a, b, messages: [], read: {}, cleared: {} });
    }
    return this.cache.get(key);
  }

  /** Every conversation of `username` (reads the folder once, then the cache). */
  all(username) {
    if (!this.loadedAll) {
      for (const f of fs.existsSync(this.dir) ? fs.readdirSync(this.dir) : []) if (/^[a-z0-9._-]+\+[a-z0-9._-]+\.json$/.test(f)) this.load(f.slice(0, -5));
      this.loadedAll = true;
    }
    return [...this.cache.values()].filter((c) => c.a === username || c.b === username);
  }

  save(c) {
    if (!this.dir) return;
    const file = path.join(this.dir, `${this.key(c.a, c.b)}.json`);
    if (!c.messages.length && c.cleared[c.a] && c.cleared[c.b]) {
      fs.rmSync(file, { force: true });
      this.cache.delete(this.key(c.a, c.b));
      return;
    }
    // ponytail: whole file rewritten per message (≤ 500 short messages); append-only log if it gets busy.
    writeJsonAtomic(file, c);
  }

  /** What `username` sees: messages after their own « delete conversation ». */
  visible(c, username) {
    const from = c.cleared[username] || 0;
    return c.messages.filter((m) => m.at > from);
  }

  unread(c, username) {
    const after = Math.max(c.read[username] || 0, c.cleared[username] || 0);
    return c.messages.filter((m) => m.at > after && m.from !== username).length;
  }

  send(from, to, sealed) {
    const c = this.load(this.key(from, to));
    const last = c.messages[c.messages.length - 1];
    // Strictly increasing times: « read up to » and « deleted up to » compare them.
    const at = Math.max(Date.now(), (last?.at || 0) + 1);
    const message = { id: crypto.randomBytes(8).toString('base64url'), from, at, ...sealed };
    c.messages.push(message);
    if (c.messages.length > KEEP) c.messages.splice(0, c.messages.length - KEEP);
    c.read[from] = at;
    this.save(c);
    return message;
  }

  markRead(username, other) {
    const c = this.load(this.key(username, other));
    const last = c.messages[c.messages.length - 1];
    if (!last || (c.read[username] || 0) >= last.at) return;
    c.read[username] = last.at;
    this.save(c);
  }

  /** Delete the conversation for `username`; erased for good once both sides did it. */
  clear(username, other) {
    const c = this.load(this.key(username, other));
    const now = Math.max(Date.now(), c.messages[c.messages.length - 1]?.at || 0);
    c.cleared[username] = now;
    const both = Math.min(c.cleared[c.a] || 0, c.cleared[c.b] || 0);
    c.messages = c.messages.filter((m) => m.at > both);
    this.save(c);
  }
}

export function registerMessages(app, { accounts, friends, messages, hub, keys }) {
  const me = (request) => request.user.username;
  const limiter = messageLimiter();
  const view = (viewer, other) => ({
    username: other,
    // A display name only for a friend: nothing more is revealed about other accounts.
    displayName: friends.are(viewer, other) ? accounts.get(other)?.displayName || other : other,
    friend: friends.are(viewer, other) && !!accounts.get(other),
  });
  /** The conversation of `u` with `other`, or null (never created by reading). */
  const find = (u, other) => { messages.all(u); return messages.cache.get(messages.key(u, other)) || null; };

  app.get('/api/messages', async (request) => {
    const u = me(request);
    const conversations = messages.all(u).map((c) => {
      const other = c.a === u ? c.b : c.a;
      const list = messages.visible(c, u);
      return list.length ? { with: view(u, other), last: list[list.length - 1], unread: messages.unread(c, u) } : null;
    }).filter(Boolean).sort((x, y) => y.last.at - x.last.at);
    return { conversations, unread: conversations.reduce((n, c) => n + c.unread, 0) };
  });

  app.get('/api/messages/:username', async (request) => {
    const u = me(request);
    const other = targetName(request.params.username, u);
    // Never creates anything: an unknown account looks like a friend-less empty conversation.
    const c = find(u, other);
    const list = c ? messages.visible(c, u) : [];
    return { with: view(u, other), messages: list, readByOther: c ? c.read[other] || 0 : 0 };
  });

  app.post('/api/messages/:username', async (request, reply) => {
    const u = me(request);
    const other = targetName(request.params.username, u);
    if (!friends.are(u, other) || !accounts.get(other)) throw new HttpError('Vous ne pouvez écrire qu’à vos amis', 403, 'NOT_FRIENDS');
    const sealed = cleanSealed(request.body);
    // Encrypted for the keys the server knows now, or the other side could not read it.
    const mine = keys.current(u, accounts);
    const theirs = keys.current(other, accounts);
    if (!theirs) throw new HttpError(`${accounts.get(other)?.displayName || other} n’a pas encore activé le chiffrement des messages : il doit se reconnecter une fois`, 409, 'NO_KEY');
    if (!mine || sealed.fp !== mine.fp || sealed.toFp !== theirs.fp) throw new HttpError('Clé de chiffrement changée : réessayez', 409, 'KEY_CHANGED');
    checkRate(limiter, u);
    const message = messages.send(u, other, sealed);
    hub.emit(other, { type: 'message', with: u, displayName: accounts.get(u)?.displayName || u, message });
    hub.emit(u, { type: 'message', with: other, message });
    reply.code(201);
    return { message };
  });

  app.post('/api/messages/:username/read', async (request) => {
    const u = me(request);
    const other = targetName(request.params.username, u);
    const c = find(u, other);
    if (c) {
      messages.markRead(u, other);
      hub.emit(u, { type: 'message-read', with: other });
      if (friends.are(u, other)) hub.emit(other, { type: 'message-read-by', with: u, at: c.read[u] || 0 });
    }
    return { ok: true };
  });

  app.delete('/api/messages/:username', async (request) => {
    const u = me(request);
    const other = targetName(request.params.username, u);
    if (find(u, other)) messages.clear(u, other);
    hub.emit(u, { type: 'message-cleared', with: other });
    return { ok: true };
  });
}
