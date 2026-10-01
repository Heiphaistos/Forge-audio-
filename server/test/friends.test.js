import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createApp } from '../src/app.js';
import { Accounts, generatePassword } from '../src/accounts.js';

const track = (n) => ({ id: `t${n}`, title: `Titre ${n}`, url: `https://www.youtube.com/watch?v=${n}`, duration: 200, thumbnail: null, author: 'A', source: 'youtube' });

async function setup(names = ['evan', 'polo', 'lohan']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-friends-'));
  const accountsFile = path.join(dir, 'accounts.json');
  const accounts = new Accounts(accountsFile);
  const pw = generatePassword(80);
  for (const u of names) await accounts.set(u, u[0].toUpperCase() + u.slice(1), pw);
  const app = createApp({ ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg', logger: false, dataDir: dir, accountsFile });
  const as = {};
  for (const u of names) {
    const cookie = (await app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: pw } })).headers['set-cookie'].split(';')[0];
    as[u] = async (method, url, payload) => {
      const res = await app.inject({ method, url, payload, headers: { cookie } });
      return { status: res.statusCode, body: res.json() };
    };
  }
  const befriend = async (a, b) => {
    assert.equal((await as[a]('POST', '/api/friends/requests', { username: b })).status, 202);
    assert.equal((await as[b]('POST', `/api/friends/requests/${a}/accept`)).status, 200);
  };
  return { app, dir, as, befriend };
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
  const { as: { evan, polo }, befriend } = await setup();
  await befriend('evan', 'polo');
  const { playlist } = (await evan('POST', '/api/shared', { name: 'À deux', tracks: [], members: ['polo'] })).body;
  assert.deepEqual(playlist.members, ['polo']);
  assert.equal((await polo('POST', '/api/messages/evan', { text: 'salut' })).status, 201);

  assert.equal((await evan('POST', '/api/friends/blocks', { username: 'polo' })).status, 200);
  assert.deepEqual((await evan('GET', '/api/friends')).body.blocked.map((b) => b.username), ['polo']);
  assert.equal((await polo('GET', '/api/friends')).body.friends.length, 0, 'the friendship is gone');
  assert.equal((await polo('GET', `/api/shared/${playlist.id}`)).status, 404, 'removed from the playlist');
  assert.equal((await polo('POST', '/api/messages/evan', { text: 'hé' })).status, 403);

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
  const { app, dir, as: { evan, polo, lohan }, befriend } = await setup();
  assert.equal((await app.inject('/api/messages')).statusCode, 401);
  const refused = await evan('POST', '/api/messages/polo', { text: 'coucou' });
  const ghost = await evan('POST', '/api/messages/personne', { text: 'coucou' });
  assert.deepEqual([refused.status, refused.body.code], [403, 'NOT_FRIENDS']);
  assert.deepEqual([ghost.status, ghost.body], [refused.status, refused.body], 'unknown account = same answer');

  await befriend('evan', 'polo');
  const html = '<img src=x onerror=alert(1)> **gras**';
  const sent = await evan('POST', '/api/messages/polo', { text: `  ${html}\u0000  ` });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.message.text, html, 'kept as plain text (the app renders it as text), control characters removed');
  assert.equal((await evan('POST', '/api/messages/polo', { text: 'a'.repeat(1001) })).status, 400);
  assert.equal((await evan('POST', '/api/messages/polo', { text: '   ' })).status, 400);
  assert.equal((await evan('POST', '/api/messages/polo', { text: 42 })).status, 400);
  assert.equal((await evan('POST', '/api/messages/polo', { text: 'é'.repeat(1000) })).status, 201);

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

  // Removing the friend stops sending, the history stays readable
  await polo('POST', '/api/messages/evan', { text: 'dernier' });
  await evan('DELETE', '/api/friends/polo');
  assert.equal((await evan('POST', '/api/messages/polo', { text: 'encore' })).status, 403);
  assert.equal((await evan('GET', '/api/messages/polo')).body.messages.length, 1);
  assert.equal((await evan('GET', '/api/messages/polo')).body.with.friend, false);

  // Rate limit: 30 per minute
  await befriend('lohan', 'evan');
  let codes = [];
  for (let i = 0; i < 31; i++) codes.push((await lohan('POST', '/api/messages/evan', { text: `m${i}` })).status);
  assert.deepEqual([codes.filter((c) => c === 201).length, codes[30]], [30, 429]);
  list = (await evan('GET', '/api/messages')).body;
  assert.equal(list.unread, 31, '30 from lohan + 1 from polo');
});

test('messages: only the last 500 of a conversation are kept', async () => {
  const { app, dir, befriend } = await setup();
  await befriend('evan', 'polo');
  // Straight through the store: the rate limit would take 17 minutes.
  const { Messages } = await import('../src/messages.js');
  const m = new Messages(dir);
  for (let i = 0; i < 510; i++) m.send('evan', 'polo', `n${i}`);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'messages', 'evan+polo.json'), 'utf8'));
  assert.equal(saved.messages.length, 500);
  assert.equal(saved.messages[0].text, 'n10');
  void app;
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
