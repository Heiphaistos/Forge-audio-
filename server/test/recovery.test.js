import crypto from 'node:crypto';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createApp } from '../src/app.js';
import { Accounts, generatePassword } from '../src/accounts.js';
import { Invites } from '../src/invites.js';
import { createMailer } from '../src/mail.js';

/** Mailer that keeps messages in memory. */
const fakeMailer = () => {
  const sent = [];
  const codeFor = (to) => String([...sent].reverse().find((m) => m.to === to)?.text || '').match(/\b(\d{6})\b/)?.[1];
  return { enabled: true, sent, codeFor, send: async (m) => { sent.push(m); return '250 OK'; } };
};

const b64 = (n) => crypto.randomBytes(n).toString('base64');
const envelope = () => ({ v: 1, iter: 600000, salt: b64(16), iv: b64(12), ct: b64(150) });
const pubKey = async () => {
  const pair = await crypto.webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return Buffer.from(await crypto.webcrypto.subtle.exportKey('raw', pair.publicKey)).toString('base64');
};
const settle = () => new Promise((r) => setImmediate(r));

async function setup(mailer = fakeMailer()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rec-'));
  const accountsFile = path.join(dir, 'accounts.json');
  const pw = { evan: generatePassword(80), polo: generatePassword(80) };
  const accounts = new Accounts(accountsFile);
  await accounts.set('evan', 'Evan', pw.evan);
  await accounts.set('polo', 'Polo', pw.polo);
  const invites = new Invites(path.join(dir, 'invites.json'));
  const codes = [1, 2, 3].map(() => invites.create('evan').code);
  const app = createApp({ ytdlp: 'yt-dlp', logger: false, dataDir: dir, accountsFile, mailer });
  const login = (u, p = pw[u]) => app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: p } });
  const cookieOf = (res) => res.headers['set-cookie'].split(';')[0];
  const as = { evan: cookieOf(await login('evan')), polo: cookieOf(await login('polo')) };
  const call = (cookie, method, url, payload) => app.inject({ method, url, headers: cookie ? { cookie } : {}, payload });
  /** Add + verify an address for `u`. */
  const verifyEmail = async (u, email) => {
    assert.equal((await call(as[u], 'PUT', '/api/me/email', { email, password: pw[u] })).statusCode, 202);
    await settle();
    const res = await call(as[u], 'POST', '/api/me/email/verify', { code: mailer.codeFor(email) });
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };
  return { dir, app, pw, as, call, login, mailer, verifyEmail, accountsFile, codes };
}

const wrongOf = (code) => (code === '000000' ? '111111' : '000000');

test('mail.js: no SMTP_HOST = disabled, nothing sent', async () => {
  const m = createMailer({});
  assert.equal(m.enabled, false);
  await assert.rejects(m.send({ to: 'a@b.fr', subject: 'x', text: 'x' }));
  assert.equal(createMailer({ SMTP_HOST: 'smtp.example.org', SMTP_FROM: 'X <no-reply@example.org>' }).enabled, true);
});

test('e-mail address: password required, 6-digit code, resend limit, 5 tries then dead', async () => {
  const { call, as, pw, mailer } = await setup();
  assert.deepEqual((await call(as.evan, 'GET', '/api/me/email')).json(), { email: null, pending: null, mail: true });
  assert.equal((await call(null, 'GET', '/api/me/email')).statusCode, 401);
  assert.equal((await call(as.evan, 'PUT', '/api/me/email', { email: 'evan@example.org', password: 'faux' })).statusCode, 403, 'a stolen session alone is not enough');
  assert.equal((await call(as.evan, 'PUT', '/api/me/email', { email: 'pas une adresse', password: pw.evan })).statusCode, 400);
  assert.equal(mailer.sent.length, 0);

  assert.equal((await call(as.evan, 'PUT', '/api/me/email', { email: ' Evan@Example.org ', password: pw.evan })).statusCode, 202);
  await settle();
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, 'evan@example.org');
  assert.ok(mailer.sent[0].html && !/<img|src=|https?:/i.test(mailer.sent[0].html), 'no image, link or tracker');
  const code = mailer.codeFor('evan@example.org');
  assert.match(code, /^\d{6}$/);
  assert.equal((await call(as.evan, 'GET', '/api/me/email')).json().pending, 'evan@example.org');
  assert.equal((await call(as.evan, 'POST', '/api/me/email/resend')).statusCode, 429, 'one mail per minute');

  for (let i = 0; i < 5; i += 1) assert.equal((await call(as.evan, 'POST', '/api/me/email/verify', { code: wrongOf(code) })).statusCode, 400);
  assert.equal((await call(as.evan, 'POST', '/api/me/email/verify', { code })).statusCode, 410, 'right code refused after 5 tries');
  assert.equal((await call(as.evan, 'GET', '/api/me/email')).json().email, null);
});

test('verification code: expires after 15 minutes, single use', async () => {
  const { call, as, pw, mailer } = await setup();
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    await call(as.evan, 'PUT', '/api/me/email', { email: 'evan@example.org', password: pw.evan });
    await settle();
    const code = mailer.codeFor('evan@example.org');
    mock.timers.tick(15 * 60_000 + 1000);
    assert.equal((await call(as.evan, 'POST', '/api/me/email/verify', { code })).statusCode, 410, 'expired');
    await call(as.evan, 'PUT', '/api/me/email', { email: 'evan@example.org', password: pw.evan });
    await settle();
    const code2 = mailer.codeFor('evan@example.org');
    assert.equal((await call(as.evan, 'POST', '/api/me/email/verify', { code: code2 })).statusCode, 200);
    assert.equal((await call(as.evan, 'POST', '/api/me/email/verify', { code: code2 })).statusCode, 410, 'already used');
    assert.equal((await call(as.evan, 'GET', '/api/me/email')).json().email, 'evan@example.org');
  } finally {
    mock.timers.reset();
  }
});

test('address: one verified address per account; a change alerts the old address; removal needs the password', async () => {
  const { call, as, pw, mailer, verifyEmail } = await setup();
  await verifyEmail('evan', 'evan@example.org');
  await call(as.polo, 'PUT', '/api/me/email', { email: 'evan@example.org', password: pw.polo });
  await settle();
  assert.equal((await call(as.polo, 'POST', '/api/me/email/verify', { code: mailer.codeFor('evan@example.org') })).statusCode, 409);
  mock.timers.enable({ apis: ['Date'], now: Date.now() + 61_000 });
  try { await verifyEmail('evan', 'evan2@example.org'); } finally { mock.timers.reset(); }
  await settle();
  assert.ok(mailer.sent.some((m) => m.to === 'evan@example.org' && /retirée/.test(m.subject)), 'old address told');
  assert.equal((await call(as.evan, 'DELETE', '/api/me/email', { password: 'faux' })).statusCode, 403);
  assert.equal((await call(as.evan, 'DELETE', '/api/me/email', { password: pw.evan })).json().email, null);
});

test('sign-up: e-mail optional; an invalid one is refused before anything is created; verification can wait', async () => {
  const { app, mailer, codes, dir } = await setup();
  const reg = (body) => app.inject({ method: 'POST', url: '/api/register', payload: { password: generatePassword(80), ...body } });
  const bad = await reg({ code: codes[0], username: 'loris', email: 'pas-une-adresse' });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, 'BAD_EMAIL');
  assert.equal(new Accounts(path.join(dir, 'accounts.json')).get('loris'), null, 'no account created, invite kept');
  assert.equal((await reg({ code: codes[0], username: 'loris' })).statusCode, 201, 'e-mail never required');
  const withMail = await reg({ code: codes[1], username: 'jimmy', email: 'jimmy@example.org' });
  assert.equal(withMail.statusCode, 201);
  await settle();
  const cookie = withMail.headers['set-cookie'].split(';')[0];
  assert.deepEqual((await app.inject({ url: '/api/me/email', headers: { cookie } })).json(), { email: null, pending: 'jimmy@example.org', mail: true });
  const ok = await app.inject({ method: 'POST', url: '/api/me/email/verify', headers: { cookie }, payload: { code: mailer.codeFor('jimmy@example.org') } });
  assert.equal(ok.json().email, 'jimmy@example.org');
});

test('forgot password: same answer and delay for unknown account / address / account without mail', async () => {
  const { app, mailer, verifyEmail } = await setup();
  await verifyEmail('evan', 'evan@example.org');
  const before = mailer.sent.length;
  const start = async (login, remoteAddress = '127.0.0.1') => {
    const t = Date.now();
    const res = await app.inject({ method: 'POST', url: '/api/recovery/start', payload: { login }, remoteAddress });
    return { status: res.statusCode, body: res.body, ms: Date.now() - t };
  };
  const known = await start('evan');
  for (const login of ['personne', 'polo', 'x@example.org']) {
    const r = await start(login);
    assert.equal(r.status, known.status, login);
    assert.equal(r.body, known.body, login);
    assert.ok(Math.abs(r.ms - known.ms) < 400, `same delay for ${login} (${r.ms} vs ${known.ms} ms)`);
  }
  assert.equal(known.status, 202);
  assert.ok(known.ms >= 1100, 'constant delay');
  await settle();
  assert.equal(mailer.sent.length, before + 1, 'only the real account got a mail');
  const v1 = await app.inject({ method: 'POST', url: '/api/recovery/verify', payload: { login: 'evan', code: wrongOf(mailer.codeFor('evan@example.org')) } });
  const v2 = await app.inject({ method: 'POST', url: '/api/recovery/verify', payload: { login: 'personne', code: '123456' } });
  assert.equal(v1.statusCode, 400);
  assert.equal(v1.body, v2.body, 'same error for a wrong code and an unknown account');
});

test('forgot password: by username or address, 5 tries, single use, sessions closed, alert mail', async () => {
  const { app, mailer, verifyEmail, call, as, login } = await setup();
  await verifyEmail('evan', 'evan@example.org');
  await app.inject({ method: 'POST', url: '/api/recovery/start', payload: { login: 'EVAN@example.org' } });
  await settle();
  const code = mailer.codeFor('evan@example.org');
  assert.ok(!mailer.sent.at(-1).subject.includes(code), 'reset code kept out of the subject (lock screens)');
  const verify = (c, l = 'evan') => app.inject({ method: 'POST', url: '/api/recovery/verify', payload: { login: l, code: c } });
  for (let i = 0; i < 5; i += 1) assert.equal((await verify(wrongOf(code))).statusCode, 400);
  assert.equal((await verify(code)).statusCode, 400, 'dead after 5 tries');

  mock.timers.enable({ apis: ['Date'], now: Date.now() + 61_000 }); // one mail per minute
  try {
    await app.inject({ method: 'POST', url: '/api/recovery/start', payload: { login: 'evan' } });
  } finally { mock.timers.reset(); }
  await settle();
  const code2 = mailer.codeFor('evan@example.org');
  const ok = await verify(code2, 'evan@example.org');
  assert.equal(ok.statusCode, 200, ok.body);
  const { ticket, username } = ok.json();
  assert.equal(username, 'evan');
  assert.equal((await verify(code2)).statusCode, 400, 'code single use');

  assert.equal((await app.inject({ method: 'POST', url: '/api/recovery/reset', payload: { ticket, newPassword: 'trop court' } })).statusCode, 400);
  const fresh = generatePassword(80);
  const done = await app.inject({ method: 'POST', url: '/api/recovery/reset', payload: { ticket, newPassword: fresh } });
  assert.equal(done.statusCode, 200, done.body);
  assert.match(done.headers['set-cookie'], /forge_session=/);
  assert.equal((await app.inject({ method: 'POST', url: '/api/recovery/reset', payload: { ticket, newPassword: generatePassword(80) } })).statusCode, 400, 'ticket single use');
  assert.equal((await call(as.evan, 'GET', '/api/me')).statusCode, 401, 'old sessions closed');
  assert.equal((await login('evan')).statusCode, 401, 'old password refused');
  assert.equal((await login('evan', fresh)).statusCode, 200);
  await settle();
  assert.ok(mailer.sent.some((m) => m.to === 'evan@example.org' && /réinitialisé/.test(m.subject)), 'alert mail');
});

test('forgot password: limited per IP (10/h) and per account (1 mail/min)', async () => {
  const { app, mailer, verifyEmail } = await setup();
  await verifyEmail('evan', 'evan@example.org');
  const n = mailer.sent.length;
  const statuses = await Promise.all(Array.from({ length: 10 }, () => app.inject({ method: 'POST', url: '/api/recovery/start', payload: { login: 'evan' } }).then((r) => r.statusCode)));
  assert.deepEqual([...new Set(statuses)], [202]);
  await settle();
  assert.equal(mailer.sent.length, n + 1, 'one mail despite 10 requests');
  assert.equal((await app.inject({ method: 'POST', url: '/api/recovery/start', payload: { login: 'evan' } })).statusCode, 429, '11th from the same IP');
  assert.equal((await app.inject({ method: 'POST', url: '/api/recovery/start', payload: { login: 'evan' }, remoteAddress: '10.9.9.9' })).statusCode, 202, 'another IP');
});

test('mail unavailable: 503, address cannot be added, status says so', async () => {
  const { app, call, as, pw } = await setup({ enabled: false, send: async () => { throw new Error('off'); } });
  assert.deepEqual((await app.inject('/api/recovery/status')).json(), { mail: false });
  assert.equal((await app.inject({ method: 'POST', url: '/api/recovery/start', payload: { login: 'evan' } })).statusCode, 503);
  assert.equal((await call(as.evan, 'PUT', '/api/me/email', { email: 'a@example.org', password: pw.evan })).statusCode, 503);
  assert.equal((await call(as.evan, 'GET', '/api/me/email')).json().mail, false);
});

test('message key after a reset: kept when the browser re-wraps it (code de secours), retired otherwise', async () => {
  for (const keep of [true, false]) {
    const { app, mailer, verifyEmail, call, as } = await setup();
    const backup = envelope();
    assert.equal((await call(as.evan, 'PUT', '/api/me/keys', { pub: await pubKey(), wrapped: envelope(), backup })).statusCode, 200);
    const { fp, backupAt } = (await call(as.evan, 'GET', '/api/me/keys')).json().key;
    assert.ok(backupAt);
    // Regenerating replaces the envelope: the old code opens nothing stored any more.
    const backup2 = envelope();
    assert.equal((await call(as.evan, 'PUT', '/api/me/keys/backup', { fp, backup: backup2 })).statusCode, 200);
    assert.equal((await call(as.evan, 'PUT', '/api/me/keys/backup', { fp: 'x', backup: envelope() })).statusCode, 409);
    assert.equal((await call(as.evan, 'PUT', '/api/me/keys/backup', { fp, backup: { ...envelope(), iter: 1000 } })).statusCode, 400);
    await verifyEmail('evan', 'evan@example.org');
    await app.inject({ method: 'POST', url: '/api/recovery/start', payload: { login: 'evan' } });
    await settle();
    const v = (await app.inject({ method: 'POST', url: '/api/recovery/verify', payload: { login: 'evan', code: mailer.codeFor('evan@example.org') } })).json();
    assert.equal(v.hasKey, true);
    assert.deepEqual(v.backup, backup2, 'latest backup envelope, opened in the browser only');
    const rewrapped = envelope();
    const res = await app.inject({ method: 'POST', url: '/api/recovery/reset', payload: { ticket: v.ticket, newPassword: generatePassword(80), ...(keep ? { wrapped: rewrapped } : {}) } });
    assert.equal(res.statusCode, 200);
    const cookie = res.headers['set-cookie'].split(';')[0];
    const key = (await app.inject({ url: '/api/me/keys', headers: { cookie } })).json().key;
    if (keep) {
      assert.equal(key.fp, fp, 'same key: conversations kept');
      assert.deepEqual(key.wrapped, rewrapped);
      assert.ok(key.backupAt, 'backup code still valid');
    } else {
      assert.equal(key, null, 'key retired: a new one will be made, old messages unreadable');
    }
  }
});

test('SMTP refusing the mail: 502, no address left waiting for a code that never came', async () => {
  const { call, as, pw } = await setup({ enabled: true, send: async () => { throw Object.assign(new Error('535 auth'), { code: 'EAUTH', responseCode: 535 }); } });
  const res = await call(as.evan, 'PUT', '/api/me/email', { email: 'evan@example.org', password: pw.evan });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().code, 'MAIL_FAILED');
  assert.deepEqual((await call(as.evan, 'GET', '/api/me/email')).json(), { email: null, pending: null, mail: true });
});
