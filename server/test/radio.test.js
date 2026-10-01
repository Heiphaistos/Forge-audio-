import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createApp } from '../src/app.js';
import { Accounts, generatePassword } from '../src/accounts.js';
import { isPublicIp, safeLookup, icyTitle, imageType } from '../src/radio.js';

const UUID1 = '11111111-2222-4333-8444-555555555555';
const UUID2 = '22222222-2222-4333-8444-555555555555';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

/** Fake station server on 127.0.0.1: ICY stream, .pls, redirect, HTML, endless stream, logos. */
async function upstream() {
  const AUDIO = Buffer.alloc(64, 0xaa);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/icy') {
      // metaint 16: 16 audio bytes, metadata block, 16 audio bytes, empty block, 16 audio bytes.
      const meta = Buffer.alloc(48);
      meta.write("StreamTitle='Daft Punk - One More Time';");
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'icy-metaint': '16' });
      res.end(Buffer.concat([AUDIO.subarray(0, 16), Buffer.from([3]), meta, AUDIO.subarray(0, 16), Buffer.from([0]), AUDIO.subarray(0, 16)]));
    } else if (u.pathname === '/pls') {
      res.writeHead(200, { 'content-type': 'audio/x-scpls' });
      res.end(`[playlist]\nFile1=http://127.0.0.1:${server.address().port}/icy\nNumberOfEntries=1\n`);
    } else if (u.pathname === '/redirect') {
      res.writeHead(302, { location: u.searchParams.get('to') });
      res.end();
    } else if (u.pathname === '/html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
    } else if (u.pathname === '/endless') {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      const t = setInterval(() => res.write(AUDIO), 50);
      res.on('close', () => clearInterval(t));
    } else if (u.pathname === '/logo.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
    } else if (u.pathname === '/logo.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}`, AUDIO };
}

const rbStation = (id, url, extra = {}) => ({ stationuuid: id, name: `Radio ${id.slice(0, 4)}`, url, url_resolved: url, countrycode: 'FR', country: 'France', tags: 'pop,rock', codec: 'MP3', bitrate: 128, favicon: '', homepage: 'https://example.org', votes: 3, clickcount: 9, hls: 0, ...extra });

async function setup({ stations = [], allow = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-radio-'));
  const accountsFile = path.join(dir, 'accounts.json');
  const pw = generatePassword(80);
  await new Accounts(accountsFile).set('evan', 'Evan', pw);
  const calls = [];
  const fetchJson = async (p) => {
    calls.push(p);
    if (p.startsWith('/json/countries')) return [{ name: 'France', iso_3166_1: 'FR', stationcount: 3000 }, { name: 'Germany', iso_3166_1: 'DE', stationcount: 5000 }, { name: 'Bad', iso_3166_1: '', stationcount: 4 }];
    if (p.startsWith('/json/stations/byuuid/')) return stations.filter((s) => p.endsWith(s.stationuuid));
    if (p.startsWith('/json/stations/search')) return stations;
    if (p.startsWith('/json/url/')) return { ok: true };
    return [];
  };
  const radio = { fetchJson, ...(allow ? { checkUrl: allow } : {}) };
  const app = createApp({ logger: false, dataDir: dir, accountsFile, radio });
  const cookie = (await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'evan', password: pw } })).headers['set-cookie'].split(';')[0];
  const get = (url) => app.inject({ method: 'GET', url, headers: { cookie } });
  return { app, dir, calls, get, cookie };
}

test('radio: every route needs a session', async () => {
  const { app } = await setup();
  for (const url of ['/api/radio/featured', '/api/radio/countries', '/api/radio/genres', '/api/radio/languages', '/api/radio/stations?q=fip', `/api/radio/station/${UUID1}`, '/api/radio/listen/fr-fip', '/api/radio/logo/fr-fip', '/api/radio/meta/fr-fip']) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401, url);
  }
});

test('radio: lists cached (24 h on disk too), searches cached, input validated', async () => {
  const { get, calls, dir } = await setup({ stations: [rbStation(UUID1, 'http://example.org/a')] });
  const a = await get('/api/radio/countries');
  assert.equal(a.statusCode, 200);
  assert.deepEqual(a.json().countries.map((c) => c.code), ['DE', 'FR']);
  await get('/api/radio/countries');
  assert.equal(calls.filter((c) => c.startsWith('/json/countries')).length, 1);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'radio-cache.json'), 'utf8')).countries, 'countries kept on disk');

  const s1 = await get('/api/radio/stations?country=fr&q=radio');
  assert.equal(s1.statusCode, 200);
  assert.equal(s1.json().stations[0].id, UUID1);
  assert.equal(s1.json().stations[0].url, undefined, 'the stream URL never reaches the client');
  await get('/api/radio/stations?country=FR&q=radio');
  assert.equal(calls.filter((c) => c.startsWith('/json/stations/search')).length, 1);

  assert.equal((await get('/api/radio/stations?country=FRA')).statusCode, 400);
  assert.equal((await get('/api/radio/stations?genre=nope')).statusCode, 400);
  assert.equal((await get('/api/radio/stations?language=%3Cscript%3E')).statusCode, 400);
  const g = await get('/api/radio/stations?genre=rock');
  assert.equal(g.statusCode, 200);
  assert.equal(g.json().stations.length, 1, 'a station found under several tags of the genre is listed once');
  const f = (await get('/api/radio/featured')).json().stations;
  assert.ok(f.some((s) => s.id === 'fr-franceinter') && f.every((s) => !s.url));
});

test('radio: only stations of the directory or the hand-picked list can be relayed', async () => {
  const { get, calls } = await setup({ stations: [] });
  assert.equal((await get('/api/radio/listen/not-a-station')).statusCode, 404);
  assert.equal((await get(`/api/radio/listen/x?url=${encodeURIComponent('http://127.0.0.1:1/')}`)).statusCode, 404);
  assert.equal((await get(`/api/radio/listen/${UUID2}`)).statusCode, 404, 'unknown to the directory');
  assert.ok(calls.includes(`/json/stations/byuuid/${UUID2}`));
});

test('radio: SSRF guards (private addresses, DNS answers, redirects)', async () => {
  assert.equal(isPublicIp('127.0.0.1'), false);
  assert.equal(isPublicIp('10.1.2.3'), false);
  assert.equal(isPublicIp('169.254.169.254'), false);
  assert.equal(isPublicIp('100.64.0.1'), false);
  assert.equal(isPublicIp('239.1.1.1'), false);
  assert.equal(isPublicIp('::1'), false);
  assert.equal(isPublicIp('fd00:80::2'), false);
  assert.equal(isPublicIp('::ffff:127.0.0.1'), false);
  assert.equal(isPublicIp('93.184.216.34'), true);
  assert.equal(isPublicIp('2a02:2479:e0:dc00::1'), true);
  const err = await new Promise((r) => safeLookup('localhost', {}, (e) => r(e)));
  assert.equal(err?.code, 'EBLOCKED', 'a name resolving to a private address is refused');

  const up = await upstream();
  try {
    // Default guards: a directory station pointing at a private address is never fetched.
    const { get } = await setup({ stations: [rbStation(UUID1, `${up.base}/icy`)] });
    const res = await get(`/api/radio/listen/${UUID1}`);
    assert.equal(res.statusCode, 403);

    // A public-looking first hop redirecting to a refused address: the redirect is checked again.
    const only = (u) => u.startsWith(`${up.base}/redirect`);
    const redir = await setup({ stations: [rbStation(UUID1, `${up.base}/redirect?to=${encodeURIComponent(`${up.base}/icy`)}`)], allow: only });
    assert.equal((await redir.get(`/api/radio/listen/${UUID1}`)).statusCode, 403);
  } finally {
    up.server.close();
  }
});

test('radio: relays audio without ICY metadata, reports the title, resolves .pls, refuses non-audio', async () => {
  const up = await upstream();
  try {
    const allow = (u) => u.startsWith(up.base);
    const { get } = await setup({ allow, stations: [rbStation(UUID1, `${up.base}/pls`), rbStation(UUID2, `${up.base}/html`)] });
    await get('/api/radio/stations');
    const res = await get(`/api/radio/listen/${UUID1}`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'audio/mpeg');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(res.rawPayload, Buffer.alloc(48, 0xaa), 'metadata blocks removed');
    assert.equal((await get(`/api/radio/meta/${UUID1}`)).json().title, 'Daft Punk - One More Time');
    const html = await get(`/api/radio/listen/${UUID2}`);
    assert.equal(html.statusCode, 502);
    assert.match(html.json().error, /Radio indisponible/);
  } finally {
    up.server.close();
  }
});

test('radio: at most 3 streams per account, freed when the listener leaves', async () => {
  const up = await upstream();
  const allow = (u) => u.startsWith(up.base);
  const { app, cookie } = await setup({ allow, stations: [rbStation(UUID1, `${up.base}/endless`)] });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const open = [];
  try {
    for (let i = 0; i < 3; i++) {
      const ac = new AbortController();
      const res = await fetch(`${base}/api/radio/listen/${UUID1}`, { headers: { cookie }, signal: ac.signal });
      assert.equal(res.status, 200);
      open.push({ ac, res });
    }
    const fourth = await fetch(`${base}/api/radio/listen/${UUID1}`, { headers: { cookie } });
    assert.equal(fourth.status, 429);
    open.shift().ac.abort();
    let again;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 50));
      again = await fetch(`${base}/api/radio/listen/${UUID1}`, { headers: { cookie }, signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (again?.status === 200) break;
    }
    assert.equal(again?.status, 200);
    await again.body.cancel();
  } finally {
    for (const o of open) o.ac.abort();
    await app.close();
    up.server.close();
  }
});

test('radio: logos are images checked by their bytes (never SVG)', async () => {
  const up = await upstream();
  try {
    const allow = (u) => u.startsWith(up.base);
    const { get } = await setup({ allow, stations: [rbStation(UUID1, `${up.base}/icy`, { favicon: `${up.base}/logo.png` }), rbStation(UUID2, `${up.base}/icy`, { favicon: `${up.base}/logo.svg` })] });
    const list = (await get('/api/radio/stations')).json().stations;
    assert.equal(list[0].logo, `/api/radio/logo/${UUID1}`);
    const ok = await get(`/api/radio/logo/${UUID1}`);
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['content-type'], 'image/png');
    assert.equal(ok.headers['x-content-type-options'], 'nosniff');
    assert.equal((await get(`/api/radio/logo/${UUID2}`)).statusCode, 404);
    assert.equal(imageType(Buffer.from('<svg')), null);
    assert.equal(icyTitle(Buffer.from("StreamTitle='Caf\xe9';", 'latin1')), 'Café');
  } finally {
    up.server.close();
  }
});

test('radio: favourites and recent stations are kept in the synced library, sanitized', async () => {
  const { app, cookie } = await setup();
  const put = await app.inject({ method: 'PUT', url: '/api/me/data', headers: { cookie }, payload: { baseRev: 0, data: { library: {
    radioFavorites: [{ id: 'fr-fip', name: 'FIP', logo: '/api/radio/logo/fr-fip', homepage: 'javascript:alert(1)', at: 5 }, { id: '../../etc', name: 'x' }, { id: UUID1, name: 'Radio', logo: 'https://evil/x.png' }],
    radioUnfavorited: { 'fr-rtl': 9 },
    radioRecent: [{ id: 'fr-rtl', name: 'RTL', at: 7 }],
  } } } });
  assert.equal(put.statusCode, 200);
  const lib = (await app.inject({ method: 'GET', url: '/api/me/data', headers: { cookie } })).json().data.library;
  assert.deepEqual(lib.radioFavorites.map((s) => [s.id, s.logo, s.homepage]), [['fr-fip', '/api/radio/logo/fr-fip', null], [UUID1, null, null]]);
  assert.deepEqual(lib.radioUnfavorited, { 'fr-rtl': 9 });
  assert.equal(lib.radioRecent[0].name, 'RTL');
});

// ---------- logo resolution (radio-logo.js) ----------
const pngOf = (w, h) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  return Buffer.concat([PNG.subarray(0, 8), Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), ihdr, Buffer.alloc(16)]);
};

/** Station site: favicon 404, home page declaring an SVG icon, an apple-touch-icon and a manifest. */
async function site() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const send = (type, body) => { res.writeHead(200, { 'content-type': type }); res.end(body); };
    if (req.url === '/home') {
      send('text/html', `<html><head><link rel="icon" type="image/svg+xml" href="/logo.svg"><link rel="shortcut icon" href="/small.png">
        <link href="/touch.png" rel="apple-touch-icon" sizes="180x180"><link rel="manifest" href="/site.webmanifest"></head></html>`);
    } else if (req.url === '/site.webmanifest') send('application/manifest+json', JSON.stringify({ icons: [{ src: '/big.png', sizes: '512x512' }, { src: '/m.svg', sizes: 'any' }] }));
    else if (req.url === '/big.png') send('image/png', pngOf(512, 512));
    else if (req.url === '/touch.png') send('image/png', pngOf(180, 180));
    else if (req.url === '/small.png') send('image/png', pngOf(16, 16));
    else if (req.url === '/logo.svg' || req.url === '/svgonly') send('image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    else if (req.url === '/svghome') send('text/html', '<link rel="icon" href="/svgonly"><meta property="og:image" content="/logo.svg">');
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, hits, base: `http://127.0.0.1:${server.address().port}` };
}

test('radio logos: favicon 404 -> best icon of the home page, cached on disk (found and not found)', async () => {
  const s = await site();
  try {
    const allow = (u) => u.startsWith(s.base);
    const st = setup({ allow, stations: [
      rbStation(UUID1, `${s.base}/icy`, { favicon: `${s.base}/gone.png`, homepage: `${s.base}/home` }),
      rbStation(UUID2, `${s.base}/icy`, { favicon: `${s.base}/logo.svg`, homepage: `${s.base}/svghome` }),
    ] });
    const { get, dir } = await st;
    const list = (await get('/api/radio/stations')).json().stations;
    assert.ok(list.every((x) => x.logo === `/api/radio/logo/${x.id}`));

    const ok = await get(`/api/radio/logo/${UUID1}`);
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['content-type'], 'image/png');
    assert.equal(ok.rawPayload.readUInt32BE(16), 512, 'the largest square picture (manifest) wins over 180 and 16 px');

    const svg = await get(`/api/radio/logo/${UUID2}`);
    assert.equal(svg.statusCode, 404, 'SVG everywhere: no logo');

    const before = s.hits.length;
    assert.equal((await get(`/api/radio/logo/${UUID1}`)).statusCode, 200);
    assert.equal((await get(`/api/radio/logo/${UUID2}`)).statusCode, 404);
    assert.equal(s.hits.length, before, 'both answers come from the disk cache');
    const files = fs.readdirSync(path.join(dir, 'radio-logos'));
    assert.equal(files.filter((f) => f.endsWith('.none')).length, 1);
    assert.equal(files.filter((f) => !f.endsWith('.none')).length, 1);
  } finally {
    s.server.close();
  }
});

test('radio logos: SVG and private addresses refused, even from the home page', async () => {
  const s = await site();
  try {
    // Default guards: favicon and home page on 127.0.0.1 are never fetched.
    const { get } = await setup({ stations: [rbStation(UUID1, `${s.base}/icy`, { favicon: `${s.base}/big.png`, homepage: `${s.base}/home` })] });
    assert.equal((await get(`/api/radio/logo/${UUID1}`)).statusCode, 404);
    assert.equal(s.hits.length, 0, 'nothing fetched from a private address');
    // A public-looking home page whose icon is on a refused address.
    const { pageIcons } = await import('../src/radio-logo.js');
    const icons = pageIcons('<link rel="apple-touch-icon" href="http://169.254.169.254/x.png"><link rel="icon" href="javascript:alert(1)">', 'https://radio.example/');
    assert.deepEqual(icons.icons.map((i) => i.url), ['http://169.254.169.254/x.png'], 'only http(s) URLs kept, each then checked by the guarded GET');
    assert.equal((await get('/api/radio/logo/..%2F..%2Fetc')).statusCode, 404);
  } finally {
    s.server.close();
  }
});

test('radio logos: .ico turned into PNG (embedded PNG or 32-bit bitmap)', async () => {
  const { icoToPng, toLogo, imageSize } = await import('../src/radio-logo.js');
  const ico = (entries) => {
    const head = Buffer.alloc(6 + 16 * entries.length);
    head.writeUInt16LE(1, 2);
    head.writeUInt16LE(entries.length, 4);
    let off = head.length;
    entries.forEach(({ w, data }, k) => {
      head[6 + 16 * k] = w;
      head.writeUInt32LE(data.length, 6 + 16 * k + 8);
      head.writeUInt32LE(off, 6 + 16 * k + 12);
      off += data.length;
    });
    return Buffer.concat([head, ...entries.map((e) => e.data)]);
  };
  // 2x2 32-bit bitmap (BGRA, bottom-up) + AND mask.
  const dib = Buffer.alloc(40 + 16 + 8);
  dib.writeUInt32LE(40, 0); dib.writeInt32LE(2, 4); dib.writeInt32LE(4, 8); dib.writeUInt16LE(1, 12); dib.writeUInt16LE(32, 14);
  Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 0]).copy(dib, 40);
  const fromBmp = toLogo(ico([{ w: 2, data: dib }]));
  assert.equal(fromBmp.type, 'image/png');
  assert.deepEqual(imageSize(fromBmp.buf), { w: 2, h: 2 });
  const fromPng = icoToPng(ico([{ w: 16, data: dib }, { w: 0, data: pngOf(256, 256) }]));
  assert.deepEqual(imageSize(fromPng), { w: 256, h: 256 }, 'largest entry first');
});
