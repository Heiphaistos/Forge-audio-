import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createApp } from '../src/app.js';
import crypto from 'node:crypto';
import { Accounts, generatePassword } from '../src/accounts.js';

const b64 = (n) => crypto.randomBytes(n).toString('base64');
const wrapped = () => ({ v: 1, iter: 600000, salt: b64(16), iv: b64(12), ct: b64(150) });
async function newKey() {
  const pair = await crypto.webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return Buffer.from(await crypto.webcrypto.subtle.exportKey('raw', pair.publicKey)).toString('base64');
}

const track = (n) => ({ id: `t${n}`, title: `Titre ${n}`, url: `https://www.youtube.com/watch?v=${n}`, duration: 200, thumbnail: null, author: 'A', source: 'youtube' });

async function setup(names = ['evan', 'polo', 'lohan']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-friends-'));
  const accountsFile = path.join(dir, 'accounts.json');
  const accounts = new Accounts(accountsFile);
  const pw = generatePassword(80);
  for (const u of names) await accounts.set(u, u[0].toUpperCase() + u.slice(1), pw);
  const app = createApp({ ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg', logger: false, dataDir: dir, accountsFile });
  const as = {};
  const login = async (u) => (await app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: pw } })).headers['set-cookie'].split(';')[0];
  for (const u of names) {
    const cookie = await login(u);
    as[u] = async (method, url, payload) => {
      const res = await app.inject({ method, url, payload, headers: { cookie } });
      return { status: res.statusCode, body: res.json() };
    };
    as[u].cookie = cookie;
  }
  // Message keys as the browser sends them (lib/e2e.ts): the server only sees opaque bytes.
  const fps = {};
  const enroll = async (u) => {
    const r = await as[u]('PUT', '/api/me/keys', { pub: await newKey(), wrapped: wrapped() });
    assert.equal(r.status, 200);
    fps[u] = r.body.key.fp;
    return fps[u];
  };
  const sealed = (from, to, size = 40) => ({ v: 1, iv: b64(12), ct: b64(size), fp: fps[from], toFp: fps[to] });
  const befriend = async (a, b) => {
    assert.equal((await as[a]('POST', '/api/friends/requests', { username: b })).status, 202);
    assert.equal((await as[b]('POST', `/api/friends/requests/${a}/accept`)).status, 200);
  };
  return { app, dir, pw, as, befriend, enroll, sealed, login };
}

test('friends: request, accept, decline, cancel, remove; nothing automatic', async () => {
  const { as: { evan, polo, lohan } } = await setup();
  assert.deepEqual((await evan('GET', '/api/friends')).body, { friends: [], incoming: [], outgoing: [], blocked: [] });

  const sent = await evan('POST', '/api/friends/requests', { username: ' Polo ' });
  assert.deepEqual([sent.status, sent.body], [202, { status: 'sent' }]);
  assert.deepEqual((await evan('GET', '/api/friends')).body.outgoing.map((r) => Object.keys(r).sort()), [['at', 'username']], 'no display name before being friends');
  const inc = (await polo('GET', '/api/friends')).body.incoming;
  assert.deepEqual(inc.map((r) => [r.username, r.displayName]), [['evan', 'Evan']]);
  assert.equal((await evan('GET', '/api/users')).body.users.length, 0, 'a request is not a friendship');
  assert.equal((await lohan('POST', '/api/friends/requests/evan/accept')).status, 404, 'only the recipient accepts');

  assert.equal((await polo('POST', '/api/friends/requests/evan/accept')).status, 200);
  assert.deepEqual((await evan('GET', '/api/friends')).body.friends.map((f) => [f.username, f.displayName]), [['polo', 'Polo']]);
  assert.deepEqual((await polo('GET', '/api/users')).body.users, [{ username: 'evan', displayName: 'Evan' }]);
  assert.equal((await evan('POST', '/api/friends/requests', { username: 'polo' })).status, 409, 'already friends');

  // Decline / cancel
  await lohan('POST', '/api/friends/requests', { username: 'evan' });
  assert.equal((await evan('POST', '/api/friends/requests/lohan/decline')).status, 200);
  assert.equal((await lohan('GET', '/api/friends')).body.outgoing.length, 0);
  await lohan('POST', '/api/friends/requests', { username: 'evan' });
  assert.equal((await lohan('DELETE', '/api/friends/requests/evan')).status, 200, 'the sender cancels');
  assert.equal((await evan('GET', '/api/friends')).body.incoming.length, 0);
  assert.equal((await lohan('DELETE', '/api/friends/requests/evan')).status, 404);

  // Both asked: friends (each one wanted it)
  await lohan('POST', '/api/friends/requests', { username: 'polo' });
  const both = await polo('POST', '/api/friends/requests', { username: 'lohan' });
  assert.deepEqual([both.status, both.body.status], [200, 'friends']);

  // Remove
  assert.equal((await polo('DELETE', '/api/friends/evan')).status, 200);
  assert.equal((await evan('GET', '/api/friends')).body.friends.length, 0, 'removed on both sides');
  assert.equal((await polo('DELETE', '/api/friends/evan')).status, 404);

  assert.equal((await evan('POST', '/api/friends/requests', { username: 'evan' })).status, 400, 'not yourself');
  assert.equal((await evan('POST', '/api/friends/requests', { username: '../x' })).status, 400);
});

test('friends: no enumeration, rate limit', async () => {
  const { as: { evan } } = await setup();
  const real = await evan('POST', '/api/friends/requests', { username: 'polo' });
  const ghost = await evan('POST', '/api/friends/requests', { username: 'personne' });
  assert.deepEqual([ghost.status, ghost.body], [real.status, real.body], 'same answer for an unknown username');
  assert.deepEqual((await evan('GET', '/api/friends')).body.outgoing.map((r) => r.username).sort(), ['personne', 'polo']);
  assert.equal((await evan('POST', '/api/friends/blocks', { username: 'personne2' })).status, 200, 'blocking an unknown name looks the same');
  for (let i = 0; i < 18; i++) assert.equal((await evan('POST', '/api/friends/requests', { username: `x${i}` })).status, 202);
  assert.equal((await evan('POST', '/api/friends/requests', { username: 'yy' })).status, 429, '20 requests per hour');
});

test('block: no request, no message, no activity, out of shared playlists and Jam', async () => {
  const { as: { evan, polo }, befriend, enroll, sealed } = await setup();
  await befriend('evan', 'polo');
  await enroll('evan');
  await enroll('polo');
  const { playlist } = (await evan('POST', '/api/shared', { name: 'À deux', tracks: [], members: ['polo'] })).body;
  assert.deepEqual(playlist.members, ['polo']);
  assert.equal((await polo('POST', '/api/messages/evan', sealed('polo', 'evan'))).status, 201);

  assert.equal((await evan('POST', '/api/friends/blocks', { username: 'polo' })).status, 200);
  assert.deepEqual((await evan('GET', '/api/friends')).body.blocked.map((b) => b.username), ['polo']);
  assert.equal((await polo('GET', '/api/friends')).body.friends.length, 0, 'the friendship is gone');
  assert.equal((await polo('GET', `/api/shared/${playlist.id}`)).status, 404, 'removed from the playlist');
  assert.equal((await polo('POST', '/api/messages/evan', sealed('polo', 'evan'))).status, 403);

  // Polo can still « send » a request (same answer as anyone), Evan never sees it.
  assert.equal((await polo('POST', '/api/friends/requests', { username: 'evan' })).status, 202);
  assert.equal((await evan('GET', '/api/friends')).body.incoming.length, 0);
  assert.equal((await evan('POST', '/api/friends/requests/polo/accept')).status, 404);
  assert.equal((await evan('POST', '/api/friends/requests', { username: 'polo' })).status, 409, 'unblock first');

  await polo('PUT', '/api/me/data', { baseRev: 0, data: { library: { liked: [], history: [{ track: track(1), at: Date.now() }], playCounts: {} }, settings: {} } });
  assert.equal((await evan('GET', '/api/activity')).body.friends.length, 0);

  const { jam } = (await evan('POST', '/api/jam', { tracks: [track(1)] })).body;
  const join = await polo('POST', '/api/jam/join', { code: jam.code });
  assert.deepEqual([join.status, join.body.code], [404, 'NO_JAM'], 'same answer as a wrong code');

  assert.equal((await evan('DELETE', '/api/friends/blocks/polo')).status, 200);
  assert.equal((await evan('GET', '/api/friends')).body.incoming.length, 1, 'the hidden request shows up once unblocked');
});

test('visibility: a non-friend sees no activity, cannot be invited or added, cannot Blend', async () => {
  const { as: { evan, polo, lohan }, befriend } = await setup();
  await befriend('evan', 'polo');
  const now = Date.now();
  await evan('PUT', '/api/me/data', { baseRev: 0, data: { library: { liked: [track(1)], history: [{ track: track(1), at: now }], playCounts: {} }, settings: {} } });
  await lohan('PUT', '/api/me/data', { baseRev: 0, data: { library: { liked: [track(2)], history: [{ track: track(2), at: now }], playCounts: {} }, settings: {} } });
  await evan('POST', '/api/activity', { track: track(3) });
  assert.deepEqual((await polo('GET', '/api/activity')).body.friends.map((f) => f.user), ['evan']);
  assert.deepEqual((await lohan('GET', '/api/activity')).body.friends, [], 'lohan is nobody’s friend');
  assert.deepEqual((await evan('GET', '/api/activity')).body.friends, [], 'polo played nothing, lohan is not a friend');
  assert.equal((await lohan('GET', '/api/blend/evan')).status, 404);
  assert.equal((await polo('GET', '/api/blend/evan')).status, 200);

  const { jam } = (await evan('POST', '/api/jam', { tracks: [track(1)] })).body;
  assert.equal((await evan('POST', `/api/jam/${jam.id}/invite`, { username: 'lohan' })).status, 403);
  assert.equal((await evan('POST', `/api/jam/${jam.id}/invite`, { username: 'personne' })).status, 403, 'unknown = same answer');
  assert.equal((await evan('POST', `/api/jam/${jam.id}/invite`, { username: 'polo' })).status, 200);
  assert.equal((await lohan('POST', '/api/jam/join', { code: jam.code })).status, 200, 'a Jam code stays an explicit way in');

  const p = (await evan('POST', '/api/shared', { name: 'x', tracks: [], members: ['polo', 'lohan'] })).body.playlist;
  assert.deepEqual(p.members, ['polo'], 'only friends become members');
  // A member who is no longer a friend stays; a non-friend cannot be added later.
  await evan('DELETE', '/api/friends/polo');
  const p2 = (await evan('PATCH', `/api/shared/${p.id}`, { members: ['polo', 'lohan'] })).body.playlist;
  assert.deepEqual(p2.members, ['polo']);
});

test('messages: friends only, no IDOR, size, read state, delete, rate limit', async () => {
  const { app, dir, as: { evan, polo, lohan }, befriend, enroll, sealed } = await setup();
  for (const u of ['evan', 'polo', 'lohan']) await enroll(u);
  assert.equal((await app.inject('/api/messages')).statusCode, 401);
  const refused = await evan('POST', '/api/messages/polo', sealed('evan', 'polo'));
  const ghost = await evan('POST', '/api/messages/personne', sealed('evan', 'polo'));
  assert.deepEqual([refused.status, refused.body.code], [403, 'NOT_FRIENDS']);
  assert.deepEqual([ghost.status, ghost.body], [refused.status, refused.body], 'unknown account = same answer');

  await befriend('evan', 'polo');
  const sent = await evan('POST', '/api/messages/polo', sealed('evan', 'polo'));
  assert.equal(sent.status, 201);
  assert.deepEqual(Object.keys(sent.body.message).sort(), ['at', 'ct', 'fp', 'from', 'id', 'iv', 'toFp', 'v']);
  assert.equal((await evan('POST', '/api/messages/polo', sealed('evan', 'polo', 4017))).status, 400, 'over 1000 characters of UTF-8 + tag');
  assert.equal((await evan('POST', '/api/messages/polo', sealed('evan', 'polo', 4016))).status, 201);

  let list = (await polo('GET', '/api/messages')).body;
  assert.equal(list.unread, 2);
  assert.deepEqual(list.conversations.map((c) => [c.with.username, c.with.displayName, c.with.friend, c.unread]), [['evan', 'Evan', true, 2]]);
  assert.equal((await polo('GET', '/api/messages/evan')).body.messages.length, 2);
  await polo('POST', '/api/messages/evan/read');
  assert.equal((await polo('GET', '/api/messages')).body.unread, 0);
  assert.ok((await evan('GET', '/api/messages/polo')).body.readByOther > 0, 'seen');

  // IDOR: lohan only ever reads lohan's conversations
  assert.deepEqual((await lohan('GET', '/api/messages/evan')).body.messages, []);
  assert.deepEqual((await lohan('GET', '/api/messages/polo')).body.messages, []);
  assert.deepEqual((await lohan('GET', '/api/messages')).body.conversations, []);
  assert.equal((await lohan('GET', '/api/messages/..%2Fevan+polo')).status, 400);
  assert.equal((await lohan('DELETE', '/api/messages/evan')).status, 200);
  assert.equal((await polo('GET', '/api/messages/evan')).body.messages.length, 2, 'lohan’s delete touched nothing');

  // Delete: hidden for one, erased from the disk once both deleted
  const file = path.join(dir, 'messages', 'evan+polo.json');
  assert.ok(fs.existsSync(file));
  await polo('DELETE', '/api/messages/evan');
  assert.deepEqual((await polo('GET', '/api/messages')).body.conversations, []);
  assert.equal((await evan('GET', '/api/messages/polo')).body.messages.length, 2, 'still there for evan');
  await evan('DELETE', '/api/messages/polo');
  assert.ok(!fs.existsSync(file), 'erased');

  // Removing the friend stops sending, the history stays readable (keys too)
  await polo('POST', '/api/messages/evan', sealed('polo', 'evan'));
  await evan('DELETE', '/api/friends/polo');
  assert.equal((await evan('POST', '/api/messages/polo', sealed('evan', 'polo'))).status, 403);
  assert.equal((await evan('GET', '/api/messages/polo')).body.messages.length, 1);
  assert.equal((await evan('GET', '/api/messages/polo')).body.with.friend, false);
  assert.equal((await evan('GET', '/api/keys/polo')).status, 200, 'a past correspondent: keys to read the history');

  // Rate limit: 30 per minute
  await befriend('lohan', 'evan');
  const codes = [];
  for (let i = 0; i < 31; i++) codes.push((await lohan('POST', '/api/messages/evan', sealed('lohan', 'evan'))).status);
  assert.deepEqual([codes.filter((c) => c === 201).length, codes[30]], [30, 429]);
  list = (await evan('GET', '/api/messages')).body;
  assert.equal(list.unread, 31, '30 from lohan + 1 from polo');
});

test('messages: end-to-end encrypted only, the server refuses clear text and stores no text', async () => {
  const { dir, as: { evan }, befriend, enroll, sealed } = await setup();
  await befriend('evan', 'polo');
  await enroll('evan');
  const noKey = await evan('POST', '/api/messages/polo', { ...sealed('evan', 'polo'), toFp: 'a'.repeat(64) });
  assert.deepEqual([noKey.status, noKey.body.code], [409, 'NO_KEY'], 'the friend has no key yet');
  await enroll('polo');
  const witness = 'TEMOIN-EN-CLAIR-42';
  for (const body of [{ text: witness }, { ...sealed('evan', 'polo'), text: witness }]) {
    const r = await evan('POST', '/api/messages/polo', body);
    assert.deepEqual([r.status, r.body.code], [400, 'PLAINTEXT_REFUSED']);
  }
  const bad = [
    { ...sealed('evan', 'polo'), v: 2 },
    { ...sealed('evan', 'polo'), iv: Buffer.alloc(16).toString('base64') },
    { ...sealed('evan', 'polo'), iv: 'pas du base64 !' },
    { ...sealed('evan', 'polo'), ct: '' },
    { ...sealed('evan', 'polo'), fp: 'x' },
  ];
  for (const body of bad) assert.equal((await evan('POST', '/api/messages/polo', body)).status, 400, JSON.stringify(body).slice(0, 80));
  const stale = await evan('POST', '/api/messages/polo', { ...sealed('evan', 'polo'), toFp: 'a'.repeat(64) });
  assert.deepEqual([stale.status, stale.body.code], [409, 'KEY_CHANGED'], 'must be encrypted for the current key');
  assert.equal((await evan('POST', '/api/messages/polo', { ...sealed('evan', 'polo'), fp: 'b'.repeat(64) })).status, 409);
  assert.equal((await evan('POST', '/api/messages/polo', { ...sealed('evan', 'polo'), extra: witness })).status, 201);
  const raw = fs.readFileSync(path.join(dir, 'messages', 'evan+polo.json'), 'utf8');
  assert.ok(!raw.includes(witness), 'unknown fields are not stored');
  assert.deepEqual(Object.keys(JSON.parse(raw).messages[0]).sort(), ['at', 'ct', 'fp', 'from', 'id', 'iv', 'toFp', 'v']);
});

test('keys: own key once, envelope private, public keys to friends only, admin reset retires it', async () => {
  const { app, dir, as: { evan, polo, lohan }, befriend, enroll } = await setup();
  assert.equal((await app.inject('/api/me/keys')).statusCode, 401);
  assert.equal((await app.inject('/api/keys/evan')).statusCode, 401);
  assert.deepEqual((await evan('GET', '/api/me/keys')).body, { key: null });
  assert.equal((await evan('PUT', '/api/me/keys', { pub: 'abc', wrapped: wrapped() })).status, 400);
  assert.equal((await evan('PUT', '/api/me/keys', { pub: Buffer.alloc(65, 4).toString('base64'), wrapped: wrapped() })).status, 400, 'not a curve point');
  assert.equal((await evan('PUT', '/api/me/keys', { pub: await newKey(), wrapped: { ...wrapped(), iter: 100000 } })).status, 400, '600 000 rounds at least');
  const fp = await enroll('evan');
  assert.equal((await evan('PUT', '/api/me/keys', { pub: await newKey(), wrapped: wrapped() })).status, 409, 'never overwritten');
  const mine = (await evan('GET', '/api/me/keys')).body.key;
  assert.equal(mine.fp, fp);
  assert.ok(mine.wrapped.ct);

  assert.equal((await polo('GET', '/api/keys/evan')).status, 404, 'not friends');
  assert.equal((await polo('GET', '/api/keys/personne')).status, 404, 'unknown = same answer');
  await befriend('evan', 'polo');
  const pub = (await polo('GET', '/api/keys/evan')).body;
  assert.deepEqual(Object.keys(pub).sort(), ['current', 'old', 'username']);
  assert.equal(pub.current.fp, fp);
  assert.equal(pub.current.wrapped, undefined, 'the envelope is for its owner only');
  assert.equal((await lohan('GET', '/api/keys/evan')).status, 404);

  // Admin reset (accounts-cli passwd = new hash + since): the key is retired, public part kept
  const accounts = new Accounts(path.join(dir, 'accounts.json'));
  await new Promise((r) => setTimeout(r, 5));
  await accounts.set('evan', undefined, generatePassword(80));
  const after = (await polo('GET', '/api/keys/evan')).body;
  assert.equal(after.current, null);
  assert.deepEqual(after.old.map((k) => k.fp), [fp], 'friends still read what they exchanged');
  const keysFile = JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8'));
  assert.equal(keysFile.users.evan.wrapped, undefined, 'the useless envelope is dropped');
});

test('password change: re-wrapped key kept, other sessions signed out, old password checked', async () => {
  const { app, pw, as: { evan }, enroll, login } = await setup();
  const fp = await enroll('evan');
  const other = await login('evan');
  const pw2 = generatePassword(80);
  const wrong = await evan('POST', '/api/me/password', { oldPassword: 'faux', newPassword: pw2, wrapped: wrapped() });
  assert.deepEqual([wrong.status, wrong.body.code], [403, 'BAD_PASSWORD'], 'never 401: the app would sign out');
  assert.equal((await evan('POST', '/api/me/password', { oldPassword: pw, newPassword: 'court', wrapped: wrapped() })).status, 400);
  assert.equal((await evan('POST', '/api/me/password', { oldPassword: pw, newPassword: pw2 })).status, 400, 'the envelope is required');
  const w = wrapped();
  await new Promise((r) => setTimeout(r, 5));
  const res = await app.inject({ method: 'POST', url: '/api/me/password', payload: { oldPassword: pw, newPassword: pw2, wrapped: w }, headers: { cookie: evan.cookie } });
  assert.equal(res.statusCode, 200);
  const fresh = res.headers['set-cookie'].split(';')[0];
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie: other } })).statusCode, 401, 'other sessions signed out');
  const key = (await app.inject({ url: '/api/me/keys', headers: { cookie: fresh } })).json().key;
  assert.deepEqual([key.fp, key.wrapped.ct], [fp, w.ct], 'same key, new envelope, not retired');
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'evan', password: pw2 } })).statusCode, 200);
});

test('migration: messages saved in clear by older versions are erased at start-up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-migr-'));
  const folder = path.join(dir, 'messages');
  fs.mkdirSync(folder);
  const enc = { id: '2', from: 'evan', at: 2, v: 1, iv: 'x', ct: 'y', fp: 'f', toFp: 'g' };
  const clear = { id: '1', from: 'evan', text: 'TEMOIN', at: 1 };
  fs.writeFileSync(path.join(folder, 'evan+polo.json'), JSON.stringify({ a: 'evan', b: 'polo', messages: [clear], read: {}, cleared: {} }));
  fs.writeFileSync(path.join(folder, 'evan+lohan.json'), JSON.stringify({ a: 'evan', b: 'lohan', messages: [clear, enc], read: {}, cleared: {} }));
  fs.writeFileSync(path.join(folder, 'lohan+polo.json'), JSON.stringify({ a: 'lohan', b: 'polo', messages: [enc], read: {}, cleared: {} }));
  const logs = [];
  const { Messages } = await import('../src/messages.js');
  new Messages(dir, { warn: (o) => logs.push(o) });
  assert.ok(!fs.existsSync(path.join(folder, 'evan+polo.json')));
  for (const f of fs.readdirSync(folder)) assert.ok(!fs.readFileSync(path.join(folder, f), 'utf8').includes('TEMOIN'), f);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'evan+lohan.json'), 'utf8')).messages.length, 1, 'the encrypted one stays');
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, 'lohan+polo.json'), 'utf8')).messages.length, 1, 'untouched');
  assert.deepEqual(logs, [{ conversations: 2, messages: 2 }]);
});

test('messages: only the last 500 of a conversation are kept', async () => {
  const { dir } = await setup();
  const { Messages } = await import('../src/messages.js');
  const m = new Messages(dir);
  for (let i = 0; i < 510; i++) m.send('evan', 'polo', { v: 1, iv: 'i', ct: `n${i}`, fp: 'f', toFp: 'g' });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'messages', 'evan+polo.json'), 'utf8'));
  assert.equal(saved.messages.length, 500);
  assert.equal(saved.messages[0].ct, 'n10');
});

test('Jam chat: participants only, in memory, gone with the Jam', async () => {
  const { as: { evan, polo, lohan }, befriend } = await setup();
  await befriend('evan', 'polo');
  const { jam } = (await evan('POST', '/api/jam', { tracks: [track(1)] })).body;
  await polo('POST', '/api/jam/join', { code: jam.code });
  const said = await polo('POST', `/api/jam/${jam.id}/chat`, { text: '<b>ce son</b> !' });
  assert.equal(said.status, 201);
  assert.deepEqual([said.body.message.from, said.body.message.displayName, said.body.message.text], ['polo', 'Polo', '<b>ce son</b> !']);
  assert.equal((await evan('GET', `/api/jam/${jam.id}/chat`)).body.messages.length, 1);
  assert.equal((await lohan('GET', `/api/jam/${jam.id}/chat`)).status, 404, 'not a participant');
  assert.equal((await lohan('POST', `/api/jam/${jam.id}/chat`, { text: 'hé' })).status, 404);
  assert.equal((await evan('POST', `/api/jam/${jam.id}/chat`, { text: 'x'.repeat(1001) })).status, 400);
  assert.equal((await evan('POST', `/api/jam/${jam.id}/chat`, { text: '' })).status, 400);
  const codes = [];
  for (let i = 0; i < 31; i++) codes.push((await polo('POST', `/api/jam/${jam.id}/chat`, { text: `m${i}` })).status);
  assert.equal(codes.filter((c) => c === 429).length, 2, '30 per minute (the first message counted)');
  await evan('POST', `/api/jam/${jam.id}/leave`);
  assert.equal((await polo('GET', `/api/jam/${jam.id}/chat`)).status, 404, 'the Jam ended: its chat is gone');
});
