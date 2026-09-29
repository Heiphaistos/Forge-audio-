import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { createApp } from '../src/app.js';
import { Accounts, generatePassword } from '../src/accounts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ytdlp = path.join(here, 'fixtures', 'fake-ytdlp.mjs');
const MEDIA = Buffer.from('0123456789'.repeat(100));

let media;
before(async () => {
  // Fake CDN serving a byte range, like googlevideo does.
  media = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (!m) { res.writeHead(200, { 'content-type': 'audio/mp4', 'content-length': MEDIA.length }); return res.end(MEDIA); }
    const start = Number(m[1]);
    const end = Math.min(MEDIA.length - 1, m[2] ? Number(m[2]) : MEDIA.length - 1);
    res.writeHead(206, { 'content-type': 'audio/mp4', 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${MEDIA.length}` });
    res.end(MEDIA.subarray(start, end + 1));
  });
  await new Promise((r) => media.listen(0, '127.0.0.1', r));
  process.env.FAKE_MEDIA_URL = `http://127.0.0.1:${media.address().port}/a.m4a`;
});
after(() => media.close());

const make = (opts = {}) => createApp({ ytdlp, ffmpeg: 'ffmpeg', logger: false, ...opts });

test('health reports yt-dlp version', async () => {
  const app = make();
  const res = await app.inject('/api/health');
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ytdlp, '2026.08.19');
  assert.equal(res.json().authRequired, false);
});

test('search on YouTube returns normalized tracks', async () => {
  const app = make();
  const res = await app.inject('/api/search?q=rick&source=youtube');
  assert.equal(res.statusCode, 200);
  const { tracks } = res.json();
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal((await app.inject('/api/search?q=&source=youtube')).statusCode, 400);
  assert.equal((await app.inject('/api/search?q=x&source=nope')).statusCode, 400);
});

test('resolve imports playlists and rejects private URLs', async () => {
  const app = make();
  const res = await app.inject(`/api/resolve?url=${encodeURIComponent('https://www.youtube.com/playlist?list=PL1')}`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().title, 'Ma playlist');
  assert.equal(res.json().tracks.length, 2);
  assert.equal((await app.inject(`/api/resolve?url=${encodeURIComponent('http://127.0.0.1/x')}`)).statusCode, 400);
  const failed = await app.inject(`/api/resolve?url=${encodeURIComponent('https://www.youtube.com/watch?v=fail')}`);
  assert.equal(failed.statusCode, 502);
  assert.match(failed.json().error, /Video unavailable/);
});

test('radio uses the YouTube mix and excludes the seed', async () => {
  const app = make();
  const res = await app.inject(`/api/radio?url=${encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ')}`);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().tracks.map((t) => t.title), ['Un', 'Deux']);
});

test('playback + stream proxy the media with Range support', async () => {
  const app = make();
  const url = encodeURIComponent('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  const pb = (await app.inject(`/api/playback?url=${url}`)).json();
  assert.equal(pb.seekable, true);
  assert.equal(pb.src, `/api/stream/audio?url=${url}`);
  const full = await app.inject(pb.src);
  assert.equal(full.statusCode, 206);
  assert.equal(full.rawPayload.length, MEDIA.length);
  const part = await app.inject({ url: pb.src, headers: { range: 'bytes=10-19' } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers['content-range'], `bytes 10-19/${MEDIA.length}`);
  assert.equal(part.payload, '0123456789');
});

test('HLS sources are reported as non-seekable', async () => {
  const app = make();
  const pb = (await app.inject(`/api/playback?url=${encodeURIComponent('https://www.dailymotion.com/video/x8abc')}`)).json();
  assert.equal(pb.seekable, false);
  assert.equal(pb.mime, 'audio/mpeg');
});

test('accounts: login, per-user library, logout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-'));
  const accountsFile = path.join(dir, 'accounts.json');
  const accounts = new Accounts(accountsFile);
  const pw = generatePassword(80);
  await accounts.set('evan', 'Evan', pw);
  await accounts.set('polo', 'Polo', generatePassword(80));
  const app = make({ dataDir: dir, accountsFile });

  assert.equal((await app.inject('/api/search?q=x&source=youtube')).statusCode, 401);
  const health = (await app.inject('/api/health')).json();
  assert.equal(health.authRequired, true);
  assert.equal(health.authenticated, false);
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'evan', password: `${pw}x` } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'nobody', password: pw } })).statusCode, 401);

  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'Evan', password: pw } });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().user.displayName, 'Evan');
  const cookie = login.headers['set-cookie'].split(';')[0];
  assert.equal((await app.inject({ url: '/api/search?q=x&source=youtube', headers: { cookie } })).statusCode, 200);

  // Library round trip; local files are never stored.
  const empty = (await app.inject({ url: '/api/me/data', headers: { cookie } })).json();
  assert.equal(empty.rev, 0);
  const data = {
    library: {
      playlists: [{ id: 'p1', name: 'Spotify import', tracks: [
        { id: '1', title: 'Titre', url: 'https://open.spotify.com/track/abc', source: 'spotify', duration: 200, thumbnail: null, author: 'A' },
        { id: '2', title: 'Mon mp3', url: 'blob:http://x/123', source: 'local', duration: null, thumbnail: null, author: null },
      ], createdAt: 1, updatedAt: 2 }],
      liked: [], history: [{ track: { id: '2', title: 'Mon mp3', url: 'blob:http://x/123', source: 'local' }, at: 5 }], playCounts: {},
    },
    settings: { accent: 'Rubis' },
    player: { queue: [], index: -1 },
  };
  const put = await app.inject({ method: 'PUT', url: '/api/me/data', headers: { cookie }, payload: { baseRev: 0, data } });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().rev, 1);
  const got = (await app.inject({ url: '/api/me/data', headers: { cookie } })).json();
  assert.equal(got.rev, 1);
  assert.deepEqual(got.data.library.playlists[0].tracks.map((t) => t.url), ['https://open.spotify.com/track/abc']);
  assert.equal(got.data.library.history.length, 0);
  assert.equal(got.data.settings.accent, 'Rubis');

  // Stale revision → conflict with the current document.
  const conflict = await app.inject({ method: 'PUT', url: '/api/me/data', headers: { cookie }, payload: { baseRev: 0, data } });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().current.rev, 1);

  // Data survives a restart (new app, same folder) and is private to each user.
  await new Promise((r) => setTimeout(r, 300)); // sessions are written to disk with a short delay
  const app2 = make({ dataDir: dir, accountsFile });
  assert.equal((await app2.inject({ url: '/api/me/data', headers: { cookie } })).json().rev, 1);

  const logout = await app2.inject({ method: 'POST', url: '/api/logout', headers: { cookie } });
  assert.equal(logout.statusCode, 200);
  assert.equal((await app2.inject({ url: '/api/me/data', headers: { cookie } })).statusCode, 401);
});

test('login is throttled after repeated failures', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-'));
  const accountsFile = path.join(dir, 'accounts.json');
  await new Accounts(accountsFile).set('lohan', 'Lohan', generatePassword(80));
  const app = make({ dataDir: dir, accountsFile });
  for (let i = 0; i < 8; i += 1) await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'lohan', password: 'nope' } });
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'lohan', password: 'nope' } })).statusCode, 429);
});

test('without accounts the server runs in local mode', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-'));
  const app = make({ dataDir: dir });
  const me = (await app.inject('/api/me')).json();
  assert.equal(me.local, true);
  assert.equal(me.user.username, 'local');
  assert.equal((await app.inject({ method: 'PUT', url: '/api/me/data', payload: { baseRev: 0, data: { library: {} } } })).statusCode, 200);
});

test('unknown API routes return JSON 404', async () => {
  const res = await make().inject('/api/nope');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().code, 'NOT_FOUND');
});

test('accounts changed by the CLI apply without a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-'));
  const accountsFile = path.join(dir, 'accounts.json');
  await new Accounts(accountsFile).set('evan', 'Evan', generatePassword(80));
  const app = make({ dataDir: dir, accountsFile });
  const login = (username, password) => app.inject({ method: 'POST', url: '/api/login', payload: { username, password } });

  // Another process (accounts-cli.js) adds a user while the server runs.
  const pw = generatePassword(80);
  await new Accounts(accountsFile).set('polo', 'Polo', pw);
  const res = await login('polo', pw);
  assert.equal(res.statusCode, 200);
  const cookie = res.headers['set-cookie'].split(';')[0];
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie } })).json().user.username, 'polo');

  // passwd signs out existing sessions, remove locks the account out.
  await new Promise((r) => setTimeout(r, 5));
  await new Accounts(accountsFile).set('polo', 'Polo', generatePassword(80));
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie } })).statusCode, 401);
  assert.equal((await login('polo', pw)).statusCode, 401);
  new Accounts(accountsFile).remove('polo');
  assert.equal(new Accounts(accountsFile).get('polo'), null);
  await app.close();
});
