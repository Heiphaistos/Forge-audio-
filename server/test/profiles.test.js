import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createApp } from '../src/app.js';
import { Accounts, generatePassword } from '../src/accounts.js';
import { cleanBio } from '../src/profiles.js';

const track = (n) => ({ id: `t${n}`, title: `Titre ${n}`, url: `https://www.youtube.com/watch?v=${n}`, duration: 200, thumbnail: null, author: `Artiste ${n % 2}`, source: 'youtube' });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);

async function setup(names = ['evan', 'polo', 'lohan', 'zoe']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-profiles-'));
  const accountsFile = path.join(dir, 'accounts.json');
  const accounts = new Accounts(accountsFile);
  const pw = generatePassword(80);
  for (const u of names) await accounts.set(u, u[0].toUpperCase() + u.slice(1), pw);
  const app = createApp({ ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg', logger: false, dataDir: dir, accountsFile });
  const as = {};
  const raw = {};
  for (const u of names) {
    const cookie = (await app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: pw } })).headers['set-cookie'].split(';')[0];
    raw[u] = (opts) => app.inject({ ...opts, headers: { cookie, ...(opts.headers || {}) } });
    as[u] = async (method, url, payload) => {
      const res = await app.inject({ method, url, payload, headers: { cookie } });
      return { status: res.statusCode, body: res.json() };
    };
  }
  const befriend = async (a, b) => {
    assert.equal((await as[a]('POST', '/api/friends/requests', { username: b })).status, 202);
    assert.equal((await as[b]('POST', `/api/friends/requests/${a}/accept`)).status, 200);
  };
  const library = async (u, playlists, extra = {}) => {
    const cur = (await as[u]('GET', '/api/me/data')).body;
    assert.equal((await as[u]('PUT', '/api/me/data', { baseRev: cur.rev, data: { library: { playlists, ...extra }, settings: extra.settings || {} } })).status, 200);
  };
  return { app, dir, as, raw, befriend, library };
}

test('profiles: a friend sees name, bio, picture, friends-since and only the playlists shown', async () => {
  const { as: { evan, polo }, raw, befriend, library } = await setup();
  await befriend('evan', 'polo');
  const now = Date.now();
  await library('evan', [
    { id: 'shown', name: 'Montrée', description: '', tracks: [track(1), track(2)], createdAt: now, updatedAt: now, onProfile: true },
    { id: 'hidden', name: 'Privée', description: '', tracks: [track(3)], createdAt: now, updatedAt: now },
  ], { history: [{ track: track(1), at: now - 1000 }, { track: track(2), at: now - 2000 }] });

  const patched = await evan('PATCH', '/api/me/profile', { displayName: '  Evan le Grand ', bio: 'Salut <b>toi</b>\r\nligne 2' });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.profile.displayName, 'Evan le Grand');
  assert.equal(patched.body.profile.bio, 'Salut <b>toi</b>\nligne 2', 'kept as plain text (escaped when shown), never interpreted');
  const up = await raw.evan({ method: 'POST', url: '/api/me/avatar', payload: PNG, headers: { 'content-type': 'image/png' } });
  assert.equal(up.statusCode, 200);
  const avatar = up.json().avatar;
  assert.match(avatar, /^\/api\/avatars\/evan\/[A-Za-z0-9_-]{24}\.png$/);

  const seen = await polo('GET', '/api/profiles/evan');
  assert.equal(seen.status, 200);
  const p = seen.body.profile;
  assert.deepEqual([p.username, p.displayName, p.bio, p.avatar, p.self], ['evan', 'Evan le Grand', 'Salut <b>toi</b>\nligne 2', avatar, false]);
  assert.ok(p.friendsSince > 0);
  assert.deepEqual(p.playlists.map((x) => [x.id, x.count]), [['shown', 2]], 'a playlist not ticked never shows');
  assert.equal(p.activity.stats.plays, 2, 'activity shared by default');
  assert.equal((await polo('GET', '/api/profiles/evan/playlists/shown')).body.playlist.tracks.length, 2);
  assert.equal((await polo('GET', '/api/profiles/evan/playlists/hidden')).status, 404, 'not ticked = not readable even with its id');
  const img = await raw.polo({ method: 'GET', url: avatar });
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.equal(img.headers['x-content-type-options'], 'nosniff');
  assert.equal((await polo('GET', '/api/users')).body.users[0].displayName, 'Evan le Grand', 'new display name everywhere');

  // Own profile
  assert.equal((await evan('GET', '/api/profiles/evan')).body.profile.self, true);
  assert.equal((await evan('GET', '/api/me/profile')).body.profile.bio, 'Salut <b>toi</b>\nligne 2');
});

test('profiles: non-friend, blocked and unknown get the same 404 (profile, playlists, picture)', async () => {
  const { app, as: { evan, polo, lohan, zoe }, raw, befriend, library } = await setup();
  await befriend('evan', 'polo');
  await befriend('evan', 'zoe');
  const now = Date.now();
  await library('evan', [{ id: 'shown', name: 'Montrée', description: '', tracks: [track(1)], createdAt: now, updatedAt: now, onProfile: true }]);
  const avatar = (await raw.evan({ method: 'POST', url: '/api/me/avatar', payload: JPEG, headers: { 'content-type': 'image/jpeg' } })).json().avatar;

  const unknown = await lohan('GET', '/api/profiles/nobody');
  const stranger = await lohan('GET', '/api/profiles/evan');
  assert.deepEqual([stranger.status, stranger.body], [unknown.status, unknown.body]);
  assert.deepEqual(stranger.body, { error: 'Profil introuvable', code: 'NOT_FOUND' });
  assert.equal((await lohan('GET', '/api/profiles/evan/playlists/shown')).status, 404);
  assert.equal((await raw.lohan({ method: 'GET', url: avatar })).statusCode, 404, 'picture of a non-friend: 404 even with the exact address');
  assert.equal((await lohan('GET', '/api/profiles/Bad%20Name')).status, 404);

  // Blocked (either way) = same answer
  assert.equal((await zoe('POST', '/api/friends/blocks', { username: 'evan' })).status, 200);
  assert.deepEqual((await zoe('GET', '/api/profiles/evan')).body, unknown.body);
  assert.deepEqual((await evan('GET', '/api/profiles/zoe')).body, unknown.body);
  assert.equal((await raw.zoe({ method: 'GET', url: avatar })).statusCode, 404);

  // Removed friend: gone too
  assert.equal((await polo('GET', '/api/profiles/evan')).status, 200);
  assert.equal((await evan('DELETE', '/api/friends/polo')).status, 200);
  assert.equal((await polo('GET', '/api/profiles/evan')).status, 404);

  // Replaced picture: the old address is dead
  await befriend('evan', 'polo');
  const next = (await raw.evan({ method: 'POST', url: '/api/me/avatar', payload: PNG, headers: { 'content-type': 'image/png' } })).json().avatar;
  assert.notEqual(next, avatar);
  assert.equal((await raw.polo({ method: 'GET', url: avatar })).statusCode, 404);
  assert.equal((await raw.polo({ method: 'GET', url: next })).statusCode, 200);
  assert.equal((await evan('DELETE', '/api/me/avatar')).status, 200);
  assert.equal((await raw.polo({ method: 'GET', url: next })).statusCode, 404);
  assert.equal((await polo('GET', '/api/profiles/evan')).body.profile.avatar, null);

  // No session: 401 everywhere
  for (const url of ['/api/profiles/evan', '/api/profiles/evan/playlists/shown', '/api/me/profile', next]) assert.equal((await app.inject({ url })).statusCode, 401, url);
});

test('profiles: picture and bio validation, activity follows both settings', async () => {
  const { as: { evan, polo }, raw, befriend, library } = await setup();
  await befriend('evan', 'polo');
  const post = (payload, type) => raw.evan({ method: 'POST', url: '/api/me/avatar', payload, headers: { 'content-type': type } });
  assert.equal((await post(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml')).statusCode, 415, 'no SVG');
  assert.equal((await post(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/png')).statusCode, 415, 'type checked by the bytes, not the header');
  assert.equal((await post(Buffer.from('GIF89a......'), 'image/png')).statusCode, 415);
  const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]);
  assert.equal((await post(big, 'image/png')).statusCode, 413, 'over 1 MB');
  assert.equal((await post(Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]), 'image/png')).statusCode, 413, 'over the parser limit: 413, not 500');
  assert.equal((await post(PNG, 'image/png')).statusCode, 200);

  assert.equal((await evan('PATCH', '/api/me/profile', { bio: 'x'.repeat(301) })).status, 400);
  assert.equal((await evan('PATCH', '/api/me/profile', { bio: 'x'.repeat(300) })).status, 200);
  assert.equal((await evan('PATCH', '/api/me/profile', { bio: 42 })).status, 400);
  assert.equal((await evan('PATCH', '/api/me/profile', { displayName: '   ' })).status, 400);
  assert.equal((await evan('PATCH', '/api/me/profile', { displayName: 'y'.repeat(41) })).status, 400);
  assert.equal((await evan('PATCH', '/api/me/profile', { showStats: 'oui' })).status, 400);
  assert.equal(cleanBio('a‮b​c\u0007d'), 'abcd', 'control and bidi characters removed');

  const now = Date.now();
  await library('evan', [], { history: [{ track: track(1), at: now }] });
  assert.ok((await polo('GET', '/api/profiles/evan')).body.profile.activity);
  assert.equal((await evan('PATCH', '/api/me/profile', { showStats: false })).status, 200);
  assert.equal((await polo('GET', '/api/profiles/evan')).body.profile.activity, null, 'hidden from the profile');
  assert.equal((await evan('PATCH', '/api/me/profile', { showStats: true })).status, 200);
  await library('evan', [], { history: [{ track: track(1), at: now }], settings: { shareActivity: false } });
  assert.equal((await polo('GET', '/api/profiles/evan')).body.profile.activity, null, '« Partager mon activité » off wins');
});

test('profiles: writes are rate limited', async () => {
  const { as: { evan } } = await setup(['evan']);
  for (let i = 0; i < 30; i++) assert.equal((await evan('PATCH', '/api/me/profile', { bio: `bio ${i}` })).status, 200);
  assert.equal((await evan('PATCH', '/api/me/profile', { bio: 'encore' })).status, 429);
});
