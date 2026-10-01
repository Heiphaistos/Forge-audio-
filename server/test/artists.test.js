import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createApp } from '../src/app.js';
import { Accounts, generatePassword } from '../src/accounts.js';
import { directory, scopes, searchArtists } from '../src/artists.js';

// Fake Deezer: a chart of 60 artists, each with 20 « similar » artists further down the id space.
const artist = (id) => ({ id, name: `A${id}`, picture_big: `https://e.test/${id}.jpg` });
function fakeDeezer(calls) {
  return async (url) => {
    const u = new URL(url);
    calls.push({ path: u.pathname + u.search, at: Date.now() });
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    const p = u.pathname;
    let m;
    if (p === '/chart/0/artists') return json({ data: Array.from({ length: 60 }, (_, i) => artist(i + 1)) });
    if ((m = p.match(/^\/artist\/(\d+)\/related$/))) return json({ data: Array.from({ length: 20 }, (_, i) => artist(Number(m[1]) * 100 + i)) });
    if (p === '/genre') return json({ data: [{ id: 0, name: 'Tous' }, { id: 116, name: 'Rap/Hip Hop' }, { id: 457, name: 'Livres audio' }] });
    if (p === '/user/637006841/playlists') return json({ data: [{ id: 11, title: 'Top France' }, { id: 12, title: 'Top USA' }, { id: 13, title: 'Top France 2025' }, { id: 14, title: 'Top Femmes France' }] });
    if (p === '/playlist/11/tracks') return json({ data: [{ artist: artist(7) }, { artist: artist(7) }, { artist: artist(8) }] });
    if (p === '/search/playlist') return json({ data: [{ id: 21, title: 'Rap', nb_tracks: 3, user: { name: 'Narjes - Deezer Rap Editrice' } }, { id: 22, title: 'perso', nb_tracks: 3, user: { name: 'kevin' } }] });
    if (p === '/playlist/21/tracks') return json({ data: [{ artist: artist(9) }, { artist: artist(5) }, { artist: artist(5) }] });
    if (p === '/search/artist') return json({ data: [artist(1), artist(2)], total: 120 });
    return json({ data: [] });
  };
}

test('artist directory: chart first, then similar artists without duplicates, pages served from cache, Deezer paced', async () => {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = fakeDeezer(calls);
  try {
    const p1 = await directory('all', 0);
    assert.equal(p1.artists.length, 48);
    assert.equal(p1.next, 48);
    assert.deepEqual(p1.artists.slice(0, 2).map((a) => a.name), ['A1', 'A2']);

    const p2 = await directory('all', 48);
    assert.equal(p2.artists.length, 48, 'past the 60 of the chart: grown with similar artists');
    assert.deepEqual(p2.artists.slice(0, 12).map((a) => a.id), [49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
    assert.equal(p2.artists[12].id, 100, 'then the artists similar to the first one');
    const ids = [...p1.artists, ...p2.artists].map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length, 'no duplicates');

    const before = calls.length;
    const again = await directory('all', 48);
    assert.deepEqual(again, p2);
    assert.equal(calls.length, before, 'a page already built costs no Deezer call');

    // Deezer allows ~10 req/s per IP: our queue keeps ≥ 100 ms between calls.
    const gaps = calls.slice(1).map((c, i) => c.at - calls[i].at);
    assert.ok(gaps.every((g) => g >= 100), `calls spaced: ${gaps.join(',')}`);

    await assert.rejects(directory('playlist:1', 0), (e) => e.status === 400);
    await assert.rejects(directory('country:999', 0), (e) => e.status === 404, 'only Deezer Charts country playlists');

    const s = await scopes();
    assert.deepEqual(s.genres.map((g) => g.id), [116], '« Tous » and audiobooks left out');
    assert.deepEqual(s.countries.map((c) => [c.id, c.name, c.flag]), [[12, 'États-Unis', '🇺🇸'], [11, 'France', '🇫🇷']]);
    const fr = await directory('country:11', 0);
    assert.deepEqual(fr.artists.slice(0, 2).map((a) => a.id), [7, 8], 'artists of « Top France », once each');

    const rap = await directory('genre:116', 0);
    assert.deepEqual(rap.artists.slice(0, 2).map((a) => a.id), [5, 9], 'artists of the curated rap playlists, most frequent first');
    await assert.rejects(directory('genre:457', 0), (e) => e.status === 404);

    const r = await searchArtists('a', 0);
    assert.deepEqual([r.artists.length, r.next], [2, 48]);
    assert.match(calls.at(-1).path, /index=0&limit=48/);
  } finally {
    globalThis.fetch = real;
  }
});

test('artist directory routes need a session', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-artists-'));
  const accountsFile = path.join(dir, 'accounts.json');
  const pw = generatePassword(80);
  await new Accounts(accountsFile).set('evan', 'Evan', pw);
  const app = createApp({ ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg', logger: false, dataDir: dir, accountsFile });
  for (const url of ['/api/catalog/artists', '/api/catalog/artists?q=jul', '/api/catalog/artists?scope=genre:116&index=48', '/api/catalog/artists/scopes']) {
    assert.equal((await app.inject({ url })).statusCode, 401, url);
  }
  const cookie = (await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'evan', password: pw } })).headers['set-cookie'].split(';')[0];
  const bad = await app.inject({ url: '/api/catalog/artists?scope=user:1', headers: { cookie } });
  assert.equal(bad.statusCode, 400, 'unknown scope refused before any Deezer call');
});
