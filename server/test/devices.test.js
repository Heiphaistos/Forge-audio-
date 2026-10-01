import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createApp } from '../src/app.js';
import { Accounts, generatePassword } from '../src/accounts.js';
import { signCast, verifyCast, castSecret, CAST_TTL_MS } from '../src/cast.js';

const track = (n) => ({ id: `t${n}`, title: `Titre ${n}`, url: `https://www.youtube.com/watch?v=${n}`, duration: 200, author: 'A', source: 'youtube' });

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-devices-'));
  const accountsFile = path.join(dir, 'accounts.json');
  const accounts = new Accounts(accountsFile);
  const pw = {};
  for (const u of ['evan', 'polo']) { pw[u] = generatePassword(80); await accounts.set(u, u, pw[u]); }
  const app = createApp({ ytdlp: 'forge-ytdlp-absent', ffmpeg: 'forge-ffmpeg-absent', logger: false, dataDir: dir, accountsFile });
  const base = await app.listen({ port: 0, host: '127.0.0.1' });
  const cookie = {};
  for (const u of Object.keys(pw)) {
    const res = await app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: pw[u] } });
    cookie[u] = res.headers['set-cookie'].split(';')[0];
  }
  const call = (u) => async (method, url, payload) => {
    const res = await app.inject({ method, url, payload, headers: u ? { cookie: cookie[u] } : {} });
    return { status: res.statusCode, body: res.json() };
  };
  /** Open a device: a real live-event stream; `events` collects what it receives. */
  const open = async (u, device, name) => {
    const ctl = new AbortController();
    const res = await fetch(`${base}/api/events?device=${device}&name=${encodeURIComponent(name)}`, { headers: { cookie: cookie[u] }, signal: ctl.signal });
    const events = [];
    const reader = res.body.getReader();
    (async () => {
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += Buffer.from(value).toString();
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6)));
          }
        }
      } catch { /* aborted */ }
    })();
    const wait = async (pred) => {
      for (let k = 0; k < 100; k++) { const e = events.find(pred); if (e) return e; await new Promise((r) => setTimeout(r, 20)); }
      throw new Error('event not received');
    };
    await wait((e) => e.type === 'hello');
    return { events, wait, close: () => ctl.abort() };
  };
  return { app, dir, evan: call('evan'), polo: call('polo'), anon: call(null), open };
}

test('devices: same account lists, controls and transfers; another account cannot', async () => {
  const { app, evan, polo, open } = await setup();
  const a = await open('evan', 'deviceAAAA', 'Edge sur Windows');
  const b = await open('evan', 'deviceBBBB', 'Téléphone <b>');
  const p = await open('polo', 'devicePPPP', 'Chez Polo');

  const list = (await evan('GET', '/api/devices')).body.devices;
  assert.deepEqual(list.map((d) => d.id).sort(), ['deviceAAAA', 'deviceBBBB']);
  assert.equal(list.find((d) => d.id === 'deviceBBBB').name, 'Téléphone b', 'name cleaned');
  assert.deepEqual((await polo('GET', '/api/devices')).body.devices.map((d) => d.id), ['devicePPPP'], 'polo sees only his own');

  // B reports its state; A receives it live.
  assert.equal((await evan('POST', '/api/devices/deviceBBBB/state', { state: { track: track(1), playing: true, position: 42, volume: 2 } })).status, 200);
  const ev = await a.wait((e) => e.type === 'devices' && e.devices.some((d) => d.state?.track?.title === 'Titre 1'));
  const st = ev.devices.find((d) => d.id === 'deviceBBBB').state;
  assert.equal(st.position, 42);
  assert.equal(st.volume, 1, 'volume clamped');
  assert.ok(!p.events.some((e) => e.type === 'devices' && e.devices.some((d) => d.id === 'deviceBBBB')), 'polo never receives evan devices');

  // A pauses B: delivered to B only.
  assert.equal((await evan('POST', '/api/devices/deviceBBBB/command', { action: 'pause', from: 'deviceAAAA' })).status, 200);
  const cmd = await b.wait((e) => e.type === 'device-command');
  assert.equal(cmd.action, 'pause');
  assert.equal(cmd.from, 'deviceAAAA');
  assert.ok(!a.events.some((e) => e.type === 'device-command'), 'command not sent to the other devices');

  // Validation.
  assert.equal((await evan('POST', '/api/devices/deviceBBBB/command', { action: 'rm -rf' })).status, 400);
  assert.equal((await evan('POST', '/api/devices/deviceBBBB/command', { action: 'seek', position: 'x' })).status, 400);
  assert.equal((await evan('POST', '/api/devices/deviceBBBB/command', { action: 'load', tracks: [{ url: 'javascript:alert(1)', title: 'x' }] })).status, 400);
  assert.equal((await evan('POST', '/api/devices/deviceBBBB/command', { action: 'handoff', target: 'deviceBBBB' })).status, 400);
  const load = await evan('POST', '/api/devices/deviceAAAA/command', { action: 'load', tracks: [track(1), track(2)], index: 9, position: 30 });
  assert.equal(load.status, 200);
  const l = await a.wait((e) => e.type === 'device-command' && e.action === 'load');
  assert.equal(l.index, 1, 'index clamped to the queue');
  assert.equal(l.tracks.length, 2);

  // Ownership: polo cannot see, report for, command or hand off to evan's devices (same 404 as unknown).
  assert.equal((await polo('POST', '/api/devices/deviceBBBB/command', { action: 'pause' })).status, 404);
  assert.equal((await polo('POST', '/api/devices/deviceBBBB/state', { state: { playing: false } })).status, 404);
  assert.equal((await polo('POST', '/api/devices/devicePPPP/command', { action: 'handoff', target: 'deviceAAAA' })).status, 404);
  assert.equal((await evan('POST', '/api/devices/devicePPPP/command', { action: 'pause' })).status, 404);

  // A device in an écoute partagée is not remote-controlled.
  await evan('POST', '/api/devices/deviceBBBB/state', { state: { track: track(1), playing: true, jam: true } });
  assert.equal((await evan('POST', '/api/devices/deviceBBBB/command', { action: 'next' })).status, 409);

  // Closing B removes it from the list (A is told).
  b.close();
  for (let k = 0; k < 100 && (await evan('GET', '/api/devices')).body.devices.length !== 1; k++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual((await evan('GET', '/api/devices')).body.devices.map((d) => d.id), ['deviceAAAA']);
  assert.ok(a.events.at(-1).type === 'devices' && a.events.at(-1).devices.length === 1, 'A told B left');
  assert.equal((await evan('POST', '/api/devices/deviceBBBB/command', { action: 'play' })).status, 404);
  a.close(); p.close();
  await app.close();
});

test('devices: routes need a session, commands are rate limited', async () => {
  const { app, evan, anon, open } = await setup();
  assert.equal((await anon('GET', '/api/devices')).status, 401);
  assert.equal((await anon('POST', '/api/devices/deviceAAAA/command', { action: 'pause' })).status, 401);
  assert.equal((await anon('POST', '/api/cast/link', { url: track(1).url })).status, 401);
  const a = await open('evan', 'deviceAAAA', 'A');
  let last = 0;
  for (let i = 0; i < 125; i++) last = (await evan('POST', '/api/devices/deviceAAAA/command', { action: 'play' })).status;
  assert.equal(last, 429);
  a.close();
  await app.close();
});

test('cast links: signed, one track, expiring, no session', async () => {
  const { app, dir, evan } = await setup();
  const res = await evan('POST', '/api/cast/link', { url: track(1).url });
  assert.equal(res.status, 200);
  const u = new URL(res.body.src);
  assert.equal(u.pathname, '/api/cast/stream');
  assert.ok(!u.search.includes('forge_session'), 'no session in the link');
  assert.equal((await evan('POST', '/api/cast/link', { url: 'http://127.0.0.1/admin' })).status, 400, 'private address refused');

  const secret = castSecret(dir);
  assert.ok(verifyCast(secret, Object.fromEntries(u.searchParams)), 'server secret persisted in data/');
  const now = Date.now();
  const s = signCast(secret, track(1).url, now);
  assert.ok(verifyCast(secret, s, now));
  assert.ok(!verifyCast(secret, { ...s, url: track(2).url }, now), 'another track refused');
  assert.ok(!verifyCast(secret, { ...s, exp: s.exp + 60 }, now), 'expiry cannot be extended');
  assert.ok(!verifyCast(secret, { ...s, sig: s.sig.slice(0, -2) + 'AA' }, now), 'forged signature refused');
  assert.ok(!verifyCast('x'.repeat(64), s, now), 'other secret refused');
  assert.ok(!verifyCast(secret, s, now + CAST_TTL_MS + 1000), 'expired link refused');

  // Through HTTP, without cookie: bad or expired signature = 403 before any fetch.
  const q = (o) => `/api/cast/stream?${new URLSearchParams(o)}`;
  assert.equal((await app.inject(q({ ...s, sig: 'AAAA' }))).statusCode, 403);
  const old = signCast(secret, track(1).url, now - CAST_TTL_MS - 5000);
  assert.equal((await app.inject(q(old))).statusCode, 403);
  assert.equal((await app.inject('/api/cast/stream')).statusCode, 403);
  // A valid link is accepted (passes auth + signature; the stream itself then needs yt-dlp).
  const ok = await app.inject(q(s));
  assert.notEqual(ok.statusCode, 401);
  assert.notEqual(ok.statusCode, 403);
  await app.close();
});
