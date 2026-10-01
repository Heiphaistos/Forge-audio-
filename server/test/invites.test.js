import crypto from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createApp } from '../src/app.js';
import { Accounts, generatePassword, checkPasswordPolicy, PASSWORD_MIN } from '../src/accounts.js';
import { Invites } from '../src/invites.js';

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-inv-'));
  const accountsFile = path.join(dir, 'accounts.json');
  const pw = { momo: generatePassword(80), evan: generatePassword(80) };
  const accounts = new Accounts(accountsFile);
  await accounts.set('momo', 'Momo', pw.momo);
  await accounts.set('evan', 'Evan', pw.evan);
  accounts.setRole('momo', 'admin');
  const app = createApp({ ytdlp: 'yt-dlp', logger: false, dataDir: dir, accountsFile });
  const login = async (u) => (await app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: pw[u] } })).headers['set-cookie'].split(';')[0];
  return { dir, accountsFile, app, admin: await login('momo'), user: await login('evan') };
}

const strong = () => generatePassword(80);

test('password policy: 70 characters minimum with every class', () => {
  assert.equal(PASSWORD_MIN, 70);
  const base = `Aa1!${'x'.repeat(66)}`;
  assert.equal(base.length, 70);
  assert.deepEqual(checkPasswordPolicy(base), []);
  assert.ok(checkPasswordPolicy(base.slice(1)).length, '69 characters is refused');
  assert.ok(checkPasswordPolicy(`aa1!${'x'.repeat(66)}`).includes('une majuscule'));
});

test('role: stored, defaults to user, sent by /api/me, kept on password change', async () => {
  const { app, admin, user, accountsFile } = await setup();
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie: admin } })).json().user.role, 'admin');
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie: user } })).json().user.role, 'user');
  // Old files without `role` stay valid.
  fs.writeFileSync(accountsFile, JSON.stringify({ users: [{ username: 'old', displayName: 'Old', password: 'scrypt$1$1$1$AA==$AA==' }] }));
  assert.equal(new Accounts(accountsFile).get('old').role, 'user');
  const a = new Accounts(accountsFile);
  a.setRole('old', 'admin');
  await a.set('old', undefined, strong());
  assert.equal(new Accounts(accountsFile).get('old').role, 'admin');
});

test('admin API: 403 for a user, 401 signed out', async () => {
  const { app, user } = await setup();
  for (const [method, url] of [['GET', '/api/admin/invites'], ['POST', '/api/admin/invites'], ['DELETE', '/api/admin/invites/abc'], ['GET', '/api/admin/accounts']]) {
    assert.equal((await app.inject({ method, url, headers: { cookie: user }, payload: {} })).statusCode, 403, `${method} ${url}`);
    assert.equal((await app.inject({ method, url, payload: {} })).statusCode, 401, `${method} ${url} signed out`);
  }
});

test('invites: create shows the code once, list hides it, revoke', async () => {
  const { app, admin, dir } = await setup();
  const res = await app.inject({ method: 'POST', url: '/api/admin/invites', headers: { cookie: admin }, payload: { days: 3, note: 'pour Loris' } });
  assert.equal(res.statusCode, 201);
  const { code, invite } = res.json();
  assert.match(code, /^FORGE-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(invite.note, 'pour Loris');
  assert.equal(invite.createdBy, 'momo');
  assert.equal(invite.status, 'active');
  assert.ok(Math.abs(invite.expiresAt - invite.createdAt - 3 * 86400000) < 1000);
  const stored = fs.readFileSync(path.join(dir, 'invites.json'), 'utf8');
  assert.ok(!stored.includes(code), 'the code is never stored in clear');
  assert.ok(stored.includes(crypto.createHash('sha256').update(code).digest('hex')));
  const list = (await app.inject({ url: '/api/admin/invites', headers: { cookie: admin } })).json().invites;
  assert.equal(list.length, 1);
  assert.ok(!JSON.stringify(list).includes(code) && !('hash' in list[0]));

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/invites/${invite.id}`, headers: { cookie: admin } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/admin/invites', headers: { cookie: admin } })).json().invites[0].status, 'revoked');
  const reg = await app.inject({ method: 'POST', url: '/api/register', payload: { code, username: 'loris', password: strong() } });
  assert.equal(reg.statusCode, 403, 'a revoked code no longer works');
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/admin/invites/nope', headers: { cookie: admin } })).statusCode, 404);
  const accounts = (await app.inject({ url: '/api/admin/accounts', headers: { cookie: admin } })).json().accounts;
  assert.deepEqual(accounts.map((a) => [a.username, a.role]), [['momo', 'admin'], ['evan', 'user']]);
  assert.ok(!JSON.stringify(accounts).includes('scrypt'));
});

test('register: success opens a session, the code is single use', async () => {
  const { app, admin, accountsFile } = await setup();
  const { code, invite } = (await app.inject({ method: 'POST', url: '/api/admin/invites', headers: { cookie: admin }, payload: {} })).json();
  assert.ok(Math.abs(invite.expiresAt - invite.createdAt - 7 * 86400000) < 1000, '7 days by default');
  const pw = strong();
  const res = await app.inject({ method: 'POST', url: '/api/register', payload: { code: code.toLowerCase(), username: 'Loris', displayName: 'Loris B.', password: pw } });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.json().user, { username: 'loris', displayName: 'Loris B.', role: 'user' });
  const cookie = res.headers['set-cookie'].split(';')[0];
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie } })).json().user.username, 'loris');
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'loris', password: pw } })).statusCode, 200);
  assert.equal(new Accounts(accountsFile).get('loris').role, 'user');
  const again = await app.inject({ method: 'POST', url: '/api/register', payload: { code, username: 'other', password: strong() } });
  assert.equal(again.statusCode, 403, 'single use');
  const used = (await app.inject({ url: '/api/admin/invites', headers: { cookie: admin } })).json().invites[0];
  assert.equal(used.status, 'used');
  assert.equal(used.usedBy, 'loris');
  assert.ok(used.usedAt);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/invites/${used.id}`, headers: { cookie: admin } })).statusCode, 409);
});

test('register: refusals (bad code, expired, weak password, bad or taken username, sealed)', async () => {
  const { app, admin, dir } = await setup();
  const mk = async () => (await app.inject({ method: 'POST', url: '/api/admin/invites', headers: { cookie: admin }, payload: { days: 1 } })).json().code;
  const reg = (payload) => app.inject({ method: 'POST', url: '/api/register', payload });
  const code = await mk();
  assert.equal((await reg({ code: 'FORGE-AAAA-AAAA-AAAA', username: 'zoe', password: strong() })).statusCode, 403);
  assert.equal((await reg({ code, username: 'zoe', password: `Aa1!${'x'.repeat(60)}` })).statusCode, 400);
  assert.equal((await reg({ code, username: '-bad', password: strong() })).statusCode, 400);
  assert.equal((await reg({ code, username: 'evan', password: strong() })).statusCode, 409);
  // A removed account's library is not handed over.
  fs.mkdirSync(path.join(dir, 'users'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'users', 'ghost.json'), '{}');
  assert.equal((await reg({ code, username: 'ghost', password: strong() })).statusCode, 409);
  assert.equal((await reg({ code, username: 'zoe', sealed: 'garbage' })).statusCode, 400);

  // Sealed password, as sent by the web page.
  const { key, nonce } = (await app.inject('/api/login-key')).json();
  const pub = crypto.createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' });
  const pw = strong();
  const sealed = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(JSON.stringify({ p: pw, n: nonce }))).toString('base64');
  assert.equal((await reg({ code, username: 'zoe', sealed })).statusCode, 201, 'the failures above did not use the code');
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'zoe', password: pw } })).statusCode, 200);

  // Expired.
  const file = path.join(dir, 'invites.json');
  const late = await mk();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.invites.at(-1).expiresAt = Date.now() - 1;
  fs.writeFileSync(file, JSON.stringify(data));
  const inv = new Invites(file);
  assert.equal(inv.find(late), null);
  assert.equal(inv.all()[0].status, 'expired');
});

test('register is rate limited per IP', async () => {
  const { app } = await setup();
  let last;
  for (let i = 0; i < 11; i += 1) last = await app.inject({ method: 'POST', url: '/api/register', payload: { code: 'x', username: 'zoe', password: strong() } });
  assert.equal(last.statusCode, 429);
});
