import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createApp } from '../src/app.js';
import { Accounts, generatePassword } from '../src/accounts.js';

const BOT = 'b'.repeat(40);
const track = (n) => ({ id: `t${n}`, title: `Titre ${n}`, url: `https://www.youtube.com/watch?v=${n}`, duration: 200, thumbnail: null, author: 'A', source: 'youtube' });

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-social-'));
  const accountsFile = path.join(dir, 'accounts.json');
  const accounts = new Accounts(accountsFile);
  const pw = {};
  for (const u of ['evan', 'polo', 'lohan']) { pw[u] = generatePassword(80); await accounts.set(u, u[0].toUpperCase() + u.slice(1), pw[u]); }
  process.env.FORGE_BOT_TOKEN = BOT;
  const app = createApp({ ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg', logger: false, dataDir: dir, accountsFile });
  const cookie = {};
  for (const u of Object.keys(pw)) {
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: pw[u] } });
    cookie[u] = res.headers['set-cookie'].split(';')[0];
  }
  const as = (u) => async (method, url, payload) => {
    const res = await app.inject({ method, url, payload, headers: { cookie: cookie[u] } });
    return { status: res.statusCode, body: res.json() };
  };
  return { app, dir, evan: as('evan'), polo: as('polo'), lohan: as('lohan') };
}

test('shared playlists: owner shares, members edit tracks, only the owner manages', async () => {
  const { evan, polo, lohan } = await setup();
  const users = await evan('GET', '/api/users');
  assert.deepEqual(users.body.users.map((u) => u.username).sort(), ['lohan', 'polo']);

  const created = await evan('POST', '/api/shared', { name: 'Soirée', tracks: [track(1)], members: ['polo', 'inconnu', 'evan'] });
  assert.equal(created.status, 200);
  const id = created.body.playlist.id;
  assert.deepEqual(created.body.playlist.members, ['polo'], 'unknown accounts and the owner are not members');

  assert.equal((await polo('GET', '/api/shared')).body.playlists.length, 1);
  assert.equal((await lohan('GET', `/api/shared/${id}`)).status, 404, 'not shared with lohan');

  const add = await polo('POST', `/api/shared/${id}/tracks`, { tracks: [track(2), track(1)] });
  assert.equal(add.body.added, 1, 'duplicates skipped');
  assert.equal(add.body.playlist.tracks[1].addedBy, 'polo');

  assert.equal((await polo('PATCH', `/api/shared/${id}`, { name: 'Pirate' })).status, 403, 'members cannot rename');
  assert.equal((await polo('POST', `/api/shared/${id}/move`, { from: 1, to: 0 })).body.playlist.tracks[0].url, track(2).url);
  assert.equal((await polo('DELETE', `/api/shared/${id}/tracks?url=${encodeURIComponent(track(1).url)}`)).body.playlist.tracks.length, 1);

  await evan('PATCH', `/api/shared/${id}`, { members: ['polo', 'lohan'] });
  assert.equal((await lohan('GET', `/api/shared/${id}`)).status, 200);
  assert.equal((await lohan('DELETE', `/api/shared/${id}`)).body.deleted, false, 'a member leaves');
  assert.equal((await lohan('GET', `/api/shared/${id}`)).status, 404);
  assert.equal((await evan('DELETE', `/api/shared/${id}`)).body.deleted, true, 'the owner deletes');
  assert.equal((await polo('GET', '/api/shared')).body.playlists.length, 0);
});

test('Jam: join by code, everyone adds, host controls, idempotent advance', async () => {
  const { evan, polo } = await setup();
  const start = await evan('POST', '/api/jam', { tracks: [track(1), track(2)], index: 0, position: 12, playing: true });
  const { id, code } = start.body.jam;
  assert.match(code, /^[A-Z2-9]{6}$/);
  assert.equal((await polo('POST', '/api/jam/join', { code: 'NOPE00' })).status, 404);
  const joined = await polo('POST', '/api/jam/join', { code: code.toLowerCase() });
  assert.equal(joined.body.jam.participants.length, 2);

  const added = await polo('POST', `/api/jam/${id}/add`, { tracks: [track(3)], next: true });
  assert.deepEqual(added.body.jam.queue.map((t) => t.url), [track(1).url, track(3).url, track(2).url]);
  assert.equal(added.body.jam.queue[1].addedBy, 'polo');

  assert.equal((await polo('POST', `/api/jam/${id}/control`, { action: 'pause' })).status, 403, 'only the host controls');
  await evan('PATCH', `/api/jam/${id}`, { everyoneControls: true });
  assert.equal((await polo('POST', `/api/jam/${id}/control`, { action: 'pause' })).body.jam.playing, false);

  const a1 = await evan('POST', `/api/jam/${id}/control`, { action: 'advance', from: 0 });
  const a2 = await polo('POST', `/api/jam/${id}/control`, { action: 'advance', from: 0 });
  assert.equal(a1.body.jam.index, 1);
  assert.equal(a2.body.jam.index, 1, 'a second "track ended" for the same track does not skip another');

  assert.equal((await polo('POST', `/api/jam/${id}/remove`, { index: 2 })).status, 200, 'everyone controls: can remove');
  assert.equal((await polo('POST', `/api/jam/${id}/leave`)).body.jam, null);
  assert.equal((await evan('GET', '/api/jam')).body.jam.participants.length, 1);
  await evan('POST', `/api/jam/${id}/leave`);
  assert.equal((await evan('GET', '/api/jam')).body.jam, null, 'the host leaving ends the Jam');
});

test('Discord link: code once, then the bot reads and toggles the same liked tracks', async () => {
  const { app, evan } = await setup();
  const bot = async (method, url, payload, token = BOT) => {
    const res = await app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
    return { status: res.statusCode, body: res.json() };
  };
  const { code } = (await evan('POST', '/api/me/discord/code')).body;
  assert.match(code, /^\d{6}$/);
  assert.equal((await bot('POST', '/api/bot/link', { code, discordId: '394720555825102858' }, 'x'.repeat(40))).status, 401, 'bad bot token');
  assert.equal((await bot('POST', '/api/bot/link', { code: '000000', discordId: '394720555825102858' })).status, 400);
  const link = await bot('POST', '/api/bot/link', { code, discordId: '394720555825102858', discordName: 'momo' });
  assert.equal(link.body.username, 'evan');
  assert.equal((await bot('POST', '/api/bot/link', { code, discordId: '394720555825102858' })).status, 400, 'a code works once');
  assert.equal((await evan('GET', '/api/me/discord')).body.link.discordId, '394720555825102858');

  // Liked in the app, seen by the bot
  await evan('PUT', '/api/me/data', { baseRev: 0, data: { library: { playlists: [], liked: [{ ...track(1), addedAt: 1 }], history: [], playCounts: {} }, settings: {}, player: null } });
  assert.deepEqual((await bot('GET', '/api/bot/users/394720555825102858')).body.liked.map((t) => t.url), [track(1).url]);
  // ❤ from Discord: added in the app's library
  assert.equal((await bot('POST', '/api/bot/users/394720555825102858/like', { track: track(2) })).body.liked, true);
  const lib = (await evan('GET', '/api/me/data')).body;
  assert.equal(lib.rev, 2);
  assert.deepEqual(lib.data.library.liked.map((t) => t.url), [track(2).url, track(1).url]);
  // Second ❤ = unlike, with a tombstone so the app does not bring it back
  assert.equal((await bot('POST', '/api/bot/users/394720555825102858/like', { track: track(2) })).body.liked, false);
  const lib2 = (await evan('GET', '/api/me/data')).body.data.library;
  assert.equal(lib2.liked.length, 1);
  assert.ok(lib2.unliked[track(2).url] > 0);
  assert.equal((await bot('GET', '/api/bot/users/111111111111111111')).status, 404, 'unlinked Discord account');
  assert.equal((await app.inject('/api/bot/users/394720555825102858')).statusCode, 401, 'no token, no session');
});

test('Jam and shared playlist with 10 people: all join, all add, all get the live state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ten-'));
  const accountsFile = path.join(dir, 'accounts.json');
  const accounts = new Accounts(accountsFile);
  const names = Array.from({ length: 10 }, (_, i) => `ami${i}`);
  const pw = generatePassword(80);
  for (const u of names) await accounts.set(u, u, pw);
  const app = createApp({ ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg', logger: false, dataDir: dir, accountsFile });
  const cookie = {};
  for (const u of names) cookie[u] = (await app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: pw } })).headers['set-cookie'].split(';')[0];
  const as = (u) => async (method, url, payload) => (await app.inject({ method, url, payload, headers: { cookie: cookie[u] } })).json();

  const { jam } = await as('ami0')('POST', '/api/jam', { tracks: [track(0)] });
  for (const u of names.slice(1)) await as(u)('POST', '/api/jam/join', { code: jam.code });
  for (const [i, u] of names.entries()) await as(u)('POST', `/api/jam/${jam.id}/add`, { tracks: [track(100 + i)] });
  const view = (await as('ami9')('GET', '/api/jam')).jam;
  assert.equal(view.participants.length, 10);
  assert.equal(view.queue.length, 11, 'the first track + one per person');
  assert.deepEqual(new Set(view.queue.slice(1).map((t) => t.addedBy)), new Set(names));

  const { playlist } = await as('ami0')('POST', '/api/shared', { name: 'Les 10', tracks: [], members: names.slice(1) });
  for (const [i, u] of names.entries()) await as(u)('POST', `/api/shared/${playlist.id}/tracks`, { tracks: [track(200 + i)] });
  for (const u of names) assert.equal((await as(u)('GET', `/api/shared/${playlist.id}`)).playlist.tracks.length, 10, `${u} sees all 10 tracks`);
});
