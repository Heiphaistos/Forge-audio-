import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';

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

test('access token protects the API', async () => {
  const app = make({ accessToken: 's3cret' });
  assert.equal((await app.inject('/api/search?q=x&source=youtube')).statusCode, 401);
  assert.equal((await app.inject('/api/health')).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { token: 'bad' } })).statusCode, 401);
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { token: 's3cret' } });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers['set-cookie'].split(';')[0];
  assert.equal((await app.inject({ url: '/api/search?q=x&source=youtube', headers: { cookie } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/search?q=x&source=youtube', headers: { 'x-forge-token': 's3cret' } })).statusCode, 200);
});

test('unknown API routes return JSON 404', async () => {
  const res = await make().inject('/api/nope');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().code, 'NOT_FOUND');
});
