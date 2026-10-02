import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { createApp } from '../src/app.js';
import { Accounts, generatePassword } from '../src/accounts.js';
import { MediaService } from '../src/stream.js';
import { HttpError } from '../src/util.js';
import { ZipWriter } from '../src/zip.js';

// Fake media: no yt-dlp/ffmpeg. The URL's path says what the "download" does.
const killed = [];
MediaService.prototype.openDownload = async function fakeOpen(url) {
  const kind = new URL(url).pathname.slice(1);
  if (kind === 'fail') throw new HttpError('Vidéo indisponible', 502, 'YTDLP_ERROR');
  let stop = false;
  let exit;
  const exited = new Promise((r) => { exit = r; });
  async function* gen() {
    if (kind === 'slow') {
      for (let i = 0; !stop && i < 1000; i += 1) { yield Buffer.alloc(64 * 1024, i); await new Promise((r) => setTimeout(r, 10)); }
      return exit(null);
    }
    if (kind !== 'empty') yield Buffer.from(`audio de ${kind} `.repeat(kind === 'big' ? 100 : 3));
    exit(kind === 'partial' || kind === 'empty' ? 1 : 0);
  }
  return { proc: { stdout: Readable.from(gen()), exited, kill: () => { stop = true; killed.push(kind); } }, filename: 'x.mp3', type: 'audio/mpeg' };
};

/** Minimal reader: central directory -> local header -> data, CRC checked, data descriptor checked. */
function readZip(buf) {
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50);
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    assert.equal(buf.readUInt16LE(p + 8), 0x0808);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    assert.equal(buf.readUInt32LE(local), 0x04034b50);
    const data = buf.subarray(local + 30 + nameLen, local + 30 + nameLen + size);
    assert.equal(zlib.crc32(data) >>> 0, crc, `CRC de ${name}`);
    const d = local + 30 + nameLen + size;
    assert.equal(buf.readUInt32LE(d), 0x08074b50);
    assert.equal(buf.readUInt32LE(d + 4), crc);
    out.push({ name, data });
    p += 46 + nameLen;
  }
  return out;
}

/** Same archive through Python's zipfile (CRC test) when Python is installed. */
function pythonCheck(buf) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-zip-')), 'a.zip');
  fs.writeFileSync(file, buf);
  for (const py of ['python3', 'python']) {
    const r = spawnSync(py, ['-m', 'zipfile', '-t', file], { encoding: 'utf8' });
    if (r.error) continue;
    assert.equal(r.status, 0, r.stderr);
    return true;
  }
  return false;
}

async function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-'));
  const accountsFile = path.join(dir, 'accounts.json');
  const accounts = new Accounts(accountsFile);
  const pw = generatePassword(80);
  await accounts.set('evan', 'Evan', pw);
  await accounts.set('polo', 'Polo', pw);
  const app = createApp({ ytdlp: 'yt-dlp-absent', logger: false, dataDir: dir, accountsFile, ...opts });
  const login = async (username) => (await app.inject({ method: 'POST', url: '/api/login', payload: { username, password: pw } })).headers['set-cookie'].split(';')[0];
  return { app, evan: await login('evan'), polo: await login('polo') };
}

const T = (kind, title, author = 'Artiste') => ({ url: `https://example.com/${kind}`, title, author });
const post = (app, cookie, payload) => app.inject({ method: 'POST', url: '/api/download/batch', headers: cookie ? { cookie } : {}, payload });

test('zip writer: stored entries readable, truncated at the limit', async () => {
  const zip = new ZipWriter({ limit: 600 });
  const chunks = [];
  zip.stream.on('data', (c) => chunks.push(c));
  assert.deepEqual(await zip.add('vide.mp3', []), { size: 0, truncated: false });
  assert.equal((await zip.add('é.mp3', [Buffer.from('a'.repeat(300))])).truncated, false);
  const cut = await zip.add('b.mp3', [Buffer.from('b'.repeat(300))]);
  assert.equal(cut.truncated, true);
  assert.ok(zip.full);
  await zip.add('rapport.txt', [Buffer.from('reste')], { capped: false });
  await zip.finish();
  const buf = Buffer.concat(chunks);
  const entries = readZip(buf);
  assert.deepEqual(entries.map((e) => e.name), ['é.mp3', 'b.mp3', 'rapport.txt']);
  assert.ok(entries[1].data.length < 300);
  pythonCheck(buf);
});

test('batch download: one zip, numbered names, failures listed, single use, owner only', async () => {
  const { app, evan, polo } = await setup();
  assert.equal((await post(app, null, { name: 'x', format: 'mp3', tracks: [T('a', 'A')] })).statusCode, 401);
  const res = await post(app, evan, {
    name: 'Ma playlist : été', format: 'mp3',
    tracks: [T('a', 'Artiste - Déjà nommé'), T('fail', 'Cassé'), T('b', 'Titre/avec*interdits?...'), T('empty', 'Vide'), T('partial', 'Coupé'), T('c', 'Titre', 'X - Topic')],
  });
  assert.equal(res.statusCode, 200);
  const { id, count } = res.json();
  assert.equal(count, 6);
  assert.equal((await app.inject({ url: `/api/download/batch/${id}`, headers: { cookie: polo } })).statusCode, 404);
  const zipRes = await app.inject({ url: `/api/download/batch/${id}`, headers: { cookie: evan } });
  assert.equal(zipRes.statusCode, 200);
  assert.equal(zipRes.headers['content-type'], 'application/zip');
  assert.match(zipRes.headers['content-disposition'], /filename\*=UTF-8''Ma%20playlist%20%C3%A9t%C3%A9\.zip/);
  const entries = readZip(zipRes.rawPayload);
  assert.deepEqual(entries.map((e) => e.name), [
    '01 - Artiste - Déjà nommé.mp3', '03 - Artiste - Titre avec interdits.mp3', '05 - Artiste - Coupé.mp3', '06 - X - Titre.mp3', 'titres-non-telecharges.txt',
  ]);
  const report = entries.at(-1).data.toString('utf8');
  assert.match(report, /\(3\/6\)/);
  assert.match(report, /Cassé \(Vidéo indisponible\)/);
  assert.match(report, /Vide \(aucune donnée reçue\)/);
  assert.match(report, /Coupé \(incomplet\)/);
  pythonCheck(zipRes.rawPayload);
  assert.equal((await app.inject({ url: `/api/download/batch/${id}`, headers: { cookie: evan } })).statusCode, 404, 'retiré une fois complet');
});

test('batch download: same link asked again (Android WebView then DownloadManager) restarts it', async () => {
  const { app, evan } = await setup();
  await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const { id } = (await post(app, evan, { name: 'lent', format: 'mp3', tracks: [T('slow', 'Lent')] })).json();
    const { port } = app.server.address();
    const first = await new Promise((resolve) => {
      const req = http.get({ port, host: '127.0.0.1', path: `/api/download/batch/${id}`, headers: { cookie: evan } }, (res) => res.once('data', () => resolve({ req, res })));
      req.on('error', () => {});
    });
    first.res.on('error', () => {});
    assert.equal(first.res.statusCode, 200);
    killed.length = 0;
    const second = await app.inject({ url: `/api/download/batch/${id}`, headers: { cookie: evan } });
    assert.equal(second.statusCode, 200);
    assert.ok(killed.includes('slow'), 'premier flux arrêté');
    assert.equal(readZip(second.rawPayload)[0].name, '01 - Artiste - Lent.mp3');
    first.req.destroy();
  } finally {
    await app.close();
  }
});

test('batch download: refusals (format, size, private URL, expiry)', async (t) => {
  const { app, evan } = await setup();
  assert.equal((await post(app, evan, { name: 'x', format: 'video', tracks: [T('a', 'A')] })).statusCode, 400);
  assert.equal((await post(app, evan, { name: 'x', format: 'mp3', tracks: [] })).statusCode, 400);
  const many = Array.from({ length: 201 }, (_, i) => T('a', `T${i}`));
  assert.equal((await post(app, evan, { name: 'x', format: 'mp3', tracks: many })).json().code, 'TOO_MANY');
  assert.equal((await post(app, evan, { name: 'x', format: 'mp3', tracks: many.slice(0, 200) })).statusCode, 200);
  for (const url of ['http://127.0.0.1/a', 'http://192.168.1.2/a', 'file:///etc/passwd', 'http://localhost/a']) {
    assert.equal((await post(app, evan, { name: 'x', format: 'mp3', tracks: [{ url, title: 'x' }] })).statusCode, 400, url);
  }
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { id } = (await post(app, evan, { name: 'x', format: 'audio', tracks: [T('a', 'A')] })).json();
  t.mock.timers.tick(10 * 60 * 1000 + 1);
  assert.equal((await app.inject({ url: `/api/download/batch/${id}`, headers: { cookie: evan } })).statusCode, 404);
});

test('batch download: archive cap stops cleanly and lists the rest', async () => {
  const { app, evan } = await setup({ zipLimit: 4000 });
  const { id } = (await post(app, evan, { name: 'gros', format: 'mp3', tracks: [T('big', 'Un'), T('big', 'Deux'), T('big', 'Trois'), T('big', 'Quatre')] })).json();
  const res = await app.inject({ url: `/api/download/batch/${id}`, headers: { cookie: evan } });
  const entries = readZip(res.rawPayload);
  const report = entries.at(-1).data.toString('utf8');
  assert.match(report, /coupé : archive pleine/);
  assert.match(report, /Quatre \(archive pleine/);
  pythonCheck(res.rawPayload);
});

test('batch download: client leaving kills the running download and frees the account', async () => {
  const { app, evan } = await setup();
  await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    const { id } = (await post(app, evan, { name: 'lent', format: 'mp3', tracks: [T('slow', 'Lent'), T('a', 'Après')] })).json();
    const { port } = app.server.address();
    await new Promise((resolve, reject) => {
      const req = http.get({ port, host: '127.0.0.1', path: `/api/download/batch/${id}`, headers: { cookie: evan } }, (res) => {
        assert.equal(res.statusCode, 200);
        res.once('data', () => req.destroy());
        res.on('error', () => {});
        res.on('close', resolve);
      });
      req.on('error', () => {});
      setTimeout(() => reject(new Error('timeout')), 5000);
    });
    for (let i = 0; i < 50 && !killed.includes('slow'); i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.ok(killed.includes('slow'), 'processus arrêté');
    let again;
    for (let i = 0; i < 50; i += 1) {
      again = await post(app, evan, { name: 'x', format: 'mp3', tracks: [T('a', 'A')] });
      if (again.statusCode !== 409) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(again.statusCode, 200);
  } finally {
    await app.close();
  }
});
