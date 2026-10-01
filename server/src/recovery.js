import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJsonAtomic, normalizeUsername, checkPasswordPolicy, LoginLimiter } from './accounts.js';
import { checkWrapped } from './keys.js';
import { HttpError } from './util.js';
import { MAILS } from './mail.js';

/**
 * Optional e-mail address + « Mot de passe oublié » (<data>/emails.json).
 *
 * - The address is only used to recover the account. It counts once verified with a 6-digit code.
 * - Codes (verification and reset): 15 min, 5 tries, single use, stored as SHA-256(16-byte salt + code).
 * - /api/recovery/start answers the same thing, after the same delay, whether the account or address
 *   exists or not (no enumeration); limited per IP and per account; codes never reach a log line.
 * - A reset by mail cannot open the message key (wrapped with the forgotten password): the browser
 *   gets the key's « code de secours » envelope (keys.js) and re-wraps it itself, or a new key is made.
 */
const CODE_TTL = 15 * 60_000;
const MAX_TRIES = 5;
const MIN_GAP = 60_000;
const HOUR = 3600_000;
const SEND_LIMIT = { verify: 5, reset: 3 };
const START_DELAY = 1200;

export const normalizeEmail = (e) => String(e || '').trim().toLowerCase();
export const isValidEmail = (e) => e.length <= 254 && /^[^\s@<>()[\]\\,;:"]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e);

const digest = (salt, code) => crypto.createHash('sha256').update(salt).update(code).digest();
function newCode() {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const salt = crypto.randomBytes(16);
  return { code, slot: { salt: salt.toString('base64'), hash: digest(salt, code).toString('hex'), exp: Date.now() + CODE_TTL, tries: 0 } };
}
const live = (slot) => !!slot && slot.exp > Date.now() && slot.tries < MAX_TRIES;

export class Emails {
  constructor(dataDir) {
    this.file = dataDir ? path.join(dataDir, 'emails.json') : null;
    this.users = (this.file && readJson(this.file, null)?.users) || {};
  }

  save() {
    if (this.file) writeJsonAtomic(this.file, { users: this.users });
  }

  rec(u) { return (this.users[u] ||= {}); }

  view(u) {
    const r = this.users[u] || {};
    return { email: r.email || null, pending: live(r.pending) ? r.pending.email : null };
  }

  /** Account whose VERIFIED address is `email`. */
  findByEmail(email) {
    return Object.keys(this.users).find((u) => this.users[u].email === email) || null;
  }

  /** At most SEND_LIMIT[kind] mails per hour and one per minute, per account. */
  allowSend(u, kind, now = Date.now()) {
    const r = this.rec(u);
    const list = ((r.sends ||= {})[kind] || []).filter((t) => now - t < HOUR);
    r.sends[kind] = list;
    if (list.length >= SEND_LIMIT[kind] || (list.length && now - list[list.length - 1] < MIN_GAP)) return false;
    list.push(now);
    return true;
  }

  /** 'ok' (slot consumed), 'bad' (one try used) or 'dead' (missing, expired or no try left: slot dropped). */
  attempt(u, key, code) {
    const r = this.users[u];
    const slot = r?.[key];
    if (!live(slot)) {
      if (r && slot) { delete r[key]; this.save(); }
      return 'dead';
    }
    const got = digest(Buffer.from(slot.salt, 'base64'), String(code || '').replace(/\D/g, '').slice(0, 6));
    if (crypto.timingSafeEqual(got, Buffer.from(slot.hash, 'hex'))) {
      const value = slot.email;
      delete r[key];
      this.save();
      return { ok: true, email: value };
    }
    slot.tries += 1;
    if (slot.tries >= MAX_TRIES) delete r[key];
    this.save();
    return 'bad';
  }

  /** New account (sign-up): forget whatever a removed account of the same name had. */
  drop(u) {
    if (this.users[u]) { delete this.users[u]; this.save(); }
  }
}

/**
 * @param {object} ctx
 * @param {(sealed: unknown, plain: unknown) => string|null} ctx.openPassword sealed (login-key) or plain password
 * @param {(request, reply, username: string) => void} ctx.startSession sets the session cookie
 * @param {LoginLimiter} ctx.limiter failed-password limiter shared with /api/login
 */
export function registerRecovery(app, { accounts, sessions, keys, emails, mailer, openPassword, startSession, limiter }) {
  const startLimiter = new LoginLimiter({ max: 10, windowMs: HOUR }); // every request counts
  const verifyLimiter = new LoginLimiter({ max: 20, windowMs: HOUR }); // wrong codes
  const tickets = new Map(); // sha256(ticket) -> { u, exp }
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  // Accounts removed with accounts-cli (another process): their address goes at the next start.
  if (accounts.enabled) for (const u of Object.keys(emails.users)) if (!accounts.get(u)) emails.drop(u);

  /** Fire and forget: the SMTP answer is logged, never the address or the code. */
  const deliver = (log, u, kind, to, mail) => mailer.send({ to, ...mail }).then(
    (smtp) => log.info({ user: u, kind, smtp: String(smtp || '').slice(0, 120) }, 'Mail envoyé'),
    (err) => log.warn({ user: u, kind, code: err.code, responseCode: err.responseCode }, 'Échec d’envoi du mail'),
  );

  const needMail = () => {
    if (!mailer.enabled || !accounts.enabled) throw new HttpError('L’envoi de mails n’est pas disponible sur ce serveur : contactez l’administrateur', 503, 'MAIL_UNAVAILABLE');
  };

  /** The current password, required to add, change or remove the address (a stolen session alone cannot). */
  const checkPassword = async (request) => {
    const wait = limiter.blocked(request.ip);
    if (wait) throw new HttpError(`Trop de tentatives, réessayez dans ${wait} min`, 429, 'RATE_LIMITED');
    const clear = openPassword(request.body?.sealed, request.body?.password);
    if (typeof clear !== 'string' || !(await accounts.authenticate(request.user.username, clear))) {
      limiter.fail(request.ip);
      throw new HttpError('Mot de passe incorrect', 403, 'BAD_PASSWORD');
    }
  };

  const sendVerify = (log, u, email) => {
    const { code, slot } = newCode();
    emails.rec(u).pending = { ...slot, email };
    emails.save();
    return mailer.send({ to: email, ...MAILS.verify(code) }).then((smtp) => log.info({ user: u, kind: 'verify', smtp: String(smtp || '').slice(0, 120) }, 'Mail envoyé'));
  };
  const mailFailed = (log, u) => (err) => {
    log.warn({ user: u, kind: 'verify', code: err.code, responseCode: err.responseCode }, 'Échec d’envoi du mail');
    throw new HttpError('Le mail n’a pas pu être envoyé : vérifiez l’adresse ou réessayez plus tard', 502, 'MAIL_FAILED');
  };

  // ---------- Signed in: Paramètres > Adresse e-mail ----------
  app.get('/api/me/email', async (request) => ({ ...emails.view(request.user.username), mail: mailer.enabled }));

  app.put('/api/me/email', async (request, reply) => {
    needMail();
    await checkPassword(request);
    const u = request.user.username;
    const email = normalizeEmail(request.body?.email);
    if (!isValidEmail(email)) throw new HttpError('Adresse e-mail invalide', 400, 'BAD_EMAIL');
    if (emails.users[u]?.email === email) throw new HttpError('C’est déjà votre adresse vérifiée', 409, 'SAME_EMAIL');
    if (!emails.allowSend(u, 'verify')) { emails.save(); throw new HttpError('Trop de codes envoyés : réessayez dans quelques minutes', 429, 'RATE_LIMITED'); }
    await sendVerify(request.log, u, email).catch(mailFailed(request.log, u));
    reply.code(202);
    return { ...emails.view(u), mail: true };
  });

  app.post('/api/me/email/resend', async (request, reply) => {
    needMail();
    const u = request.user.username;
    const pending = emails.users[u]?.pending;
    if (!pending) throw new HttpError('Aucune adresse en attente de vérification', 404, 'NO_PENDING');
    if (!emails.allowSend(u, 'verify')) { emails.save(); throw new HttpError('Trop de codes envoyés : réessayez dans quelques minutes', 429, 'RATE_LIMITED'); }
    await sendVerify(request.log, u, pending.email).catch(mailFailed(request.log, u));
    reply.code(202);
    return { ...emails.view(u), mail: true };
  });

  app.post('/api/me/email/verify', async (request) => {
    const u = request.user.username;
    const r = emails.attempt(u, 'pending', request.body?.code);
    if (r === 'bad') throw new HttpError('Code incorrect', 400, 'CODE_INVALID');
    if (r === 'dead') throw new HttpError('Code expiré ou trop d’essais : demandez un nouveau code', 410, 'CODE_EXPIRED');
    const other = emails.findByEmail(r.email);
    if (other && other !== u && accounts.get(other)) throw new HttpError('Cette adresse est déjà liée à un autre compte', 409, 'EMAIL_TAKEN');
    const rec = emails.rec(u);
    const old = rec.email;
    rec.email = r.email;
    rec.verifiedAt = Date.now();
    delete rec.reset;
    emails.save();
    if (old && old !== r.email) deliver(request.log, u, 'removed', old, MAILS.emailRemoved(u));
    request.log.info({ user: u }, 'Adresse e-mail vérifiée');
    return { ...emails.view(u), mail: mailer.enabled };
  });

  app.delete('/api/me/email', async (request) => {
    await checkPassword(request);
    const u = request.user.username;
    const r = emails.users[u];
    const old = r?.email;
    // The record (and its send counters) stays: removing and re-adding cannot be used to send more mails.
    if (r) { delete r.email; delete r.verifiedAt; delete r.pending; delete r.reset; emails.save(); }
    if (old && mailer.enabled) deliver(request.log, u, 'removed', old, MAILS.emailRemoved(u));
    request.log.info({ user: u }, 'Adresse e-mail retirée');
    return { ...emails.view(u), mail: mailer.enabled };
  });

  // ---------- Public: « Mot de passe oublié ? » ----------
  const accountOf = (login) => {
    const s = String(login || '').trim().toLowerCase().slice(0, 254);
    const u = s.includes('@') ? emails.findByEmail(normalizeEmail(s)) : normalizeUsername(s);
    return u && accounts.get(u) && emails.users[u]?.email ? u : null;
  };

  app.get('/api/recovery/status', async () => ({ mail: mailer.enabled && accounts.enabled }));

  app.post('/api/recovery/start', async (request, reply) => {
    const t0 = Date.now();
    needMail();
    const wait = startLimiter.blocked(request.ip);
    if (wait) throw new HttpError(`Trop de demandes, réessayez dans ${wait} min`, 429, 'RATE_LIMITED');
    startLimiter.fail(request.ip);
    const u = accountOf(request.body?.login);
    let sent = false;
    if (u && emails.allowSend(u, 'reset')) {
      const { code, slot } = newCode();
      emails.rec(u).reset = slot;
      deliver(request.log, u, 'reset', emails.users[u].email, MAILS.reset(code));
      sent = true;
    }
    if (u) emails.save();
    request.log.info({ ip: request.ip, ...(u ? { user: u, sent } : {}) }, 'Mot de passe oublié : demande');
    // Same answer, same delay, whatever happened above.
    await new Promise((r) => setTimeout(r, Math.max(0, START_DELAY - (Date.now() - t0))));
    reply.code(202);
    return { ok: true };
  });

  app.post('/api/recovery/verify', async (request) => {
    const wait = verifyLimiter.blocked(request.ip);
    if (wait) throw new HttpError(`Trop d’essais, réessayez dans ${wait} min`, 429, 'RATE_LIMITED');
    const u = accountOf(request.body?.login);
    const r = u ? emails.attempt(u, 'reset', request.body?.code) : 'dead';
    if (r === 'bad' || r === 'dead') {
      verifyLimiter.fail(request.ip);
      throw new HttpError('Code incorrect ou expiré. Après 5 erreurs, demandez un nouveau code.', 400, 'CODE_INVALID');
    }
    const now = Date.now();
    for (const [k, t] of tickets) if (t.exp < now) tickets.delete(k);
    const ticket = crypto.randomBytes(32).toString('base64url');
    tickets.set(sha(ticket), { u, exp: now + CODE_TTL });
    request.log.info({ user: u }, 'Mot de passe oublié : code accepté');
    // The backup envelope is useless without the « code de secours » (≈119 bits, PBKDF2 600 000).
    return { ticket, username: u, hasKey: !!keys.current(u, accounts), backup: keys.backupOf(u, accounts) };
  });

  app.post('/api/recovery/reset', async (request, reply) => {
    const b = request.body || {};
    const t = tickets.get(sha(b.ticket));
    if (!t || t.exp < Date.now()) throw new HttpError('Demande expirée : recommencez depuis « Mot de passe oublié ? »', 400, 'TICKET_INVALID');
    const clear = openPassword(b.newSealed, b.newPassword);
    if (typeof clear !== 'string') throw new HttpError('Mot de passe illisible : rechargez la page et réessayez', 400, 'BAD_REQUEST');
    const problems = checkPasswordPolicy(clear);
    if (problems.length) throw new HttpError(`Mot de passe trop faible : il faut ${problems.join(', ')}`);
    const wrapped = b.wrapped ? checkWrapped(b.wrapped) : null;
    if (b.wrapped && !wrapped) throw new HttpError('Clé de messagerie invalide', 400, 'BAD_KEY');
    const { u } = t;
    tickets.delete(sha(b.ticket));
    const keyBefore = keys.current(u, accounts); // read before `since` moves (that retires it)
    await accounts.set(u, undefined, clear);
    // Key recovered with the « code de secours » and re-wrapped by the browser: conversations kept.
    if (wrapped && keyBefore) keys.rewrap(u, wrapped, accounts.get(u).since);
    sessions.destroyUser(u);
    startSession(request, reply, u);
    const to = emails.users[u]?.email;
    if (to) deliver(request.log, u, 'reset-done', to, MAILS.resetDone(u));
    request.log.info({ user: u, keptKey: !!(wrapped && keyBefore) }, 'Mot de passe réinitialisé par e-mail');
    const acc = accounts.get(u);
    return { ok: true, user: { username: acc.username, displayName: acc.displayName, role: acc.role } };
  });

  return {
    /** Sign-up with an address: send its code; a failure never blocks the new account (resend later). */
    addEmail(log, u, email) {
      if (!emails.allowSend(u, 'verify')) return;
      sendVerify(log, u, email).catch((err) => log.warn({ user: u, kind: 'verify', code: err.code, responseCode: err.responseCode }, 'Échec d’envoi du mail'));
    },
  };
}
