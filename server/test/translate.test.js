import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { createTranslator, chunkLines, looksFrench, decodeEntities } from '../src/translate.js';

/** Fake MyMemory: « Hello » → « [fr]Hello », records every request. */
function fakeApi(handler) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    const call = { q: u.searchParams.get('q'), pair: u.searchParams.get('langpair'), de: u.searchParams.get('de') };
    calls.push(call);
    const body = handler ? handler(call) : {
      responseStatus: 200,
      responseData: { translatedText: call.q.split('\n').map((l) => `[fr]${l}`).join('\n'), ...(call.pair.startsWith('autodetect') ? { detectedLanguage: 'en-GB' } : {}) },
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

test('helpers: chunking, French detection, entities', () => {
  assert.deepEqual(chunkLines(['aaa', 'bbb', 'ccc'], 8), [['aaa', 'bbb'], ['ccc']]);
  assert.equal(chunkLines(Array(100).fill('x'.repeat(40))).every((c) => Buffer.byteLength(c.join('\n')) <= 480), true);
  assert.equal(looksFrench(['Je suis malade, complètement malade', 'Comme quand ma mère sortait le soir']), true);
  assert.equal(looksFrench(['I wanna dance with somebody', 'I wanna feel the heat with somebody']), false);
  assert.equal(looksFrench(['Te quiero mucho, mi amor', 'La vida es una canción que no se acaba']), false);
  assert.equal(decodeEntities('l&#39;amour &amp; toi &quot;x&quot; &#x263A;'), 'l\'amour & toi "x" ☺');
});

test('translator: dedupes lines, detects the language once, caches on disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-tr-'));
  const api = fakeApi();
  const t = createTranslator({ dataDir: dir, fetchImpl: api.fetchImpl, email: 'contact@example.org', gapMs: 0 });
  const lines = ['Hello', '', 'Hello', '♪', 'a'.repeat(300), 'b'.repeat(400)];
  const r = await t.translate(lines, 'fr');
  assert.deepEqual(r, { lang: 'en', same: false, lines: ['[fr]Hello', '', '[fr]Hello', '', `[fr]${'a'.repeat(300)}`, `[fr]${'b'.repeat(300)}`] });
  assert.equal(api.calls.length, 2); // two chunks (500-byte limit), « Hello » sent once
  assert.equal(api.calls[0].pair, 'autodetect|fr');
  assert.equal(api.calls[1].pair, 'en|fr'); // detected language reused
  assert.equal(api.calls[0].de, 'contact@example.org');
  // Another process (fresh memory) reads the disk cache: no new request.
  const again = createTranslator({ dataDir: dir, fetchImpl: api.fetchImpl, gapMs: 0 });
  assert.deepEqual(await again.translate(lines, 'fr'), r);
  assert.equal(api.calls.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('translator: French lyrics and same-language answers cost nothing or stop early', async () => {
  const api = fakeApi(() => ({ responseStatus: '403', responseDetails: 'PLEASE SELECT TWO DISTINCT LANGUAGES', responseData: { translatedText: 'PLEASE SELECT TWO DISTINCT LANGUAGES' } }));
  const t = createTranslator({ fetchImpl: api.fetchImpl, gapMs: 0 });
  assert.deepEqual(await t.translate(['Je suis malade, complètement malade', 'Comme quand ma mère sortait le soir'], 'fr'), { lang: 'fr', same: true, lines: [] });
  assert.equal(api.calls.length, 0);
  assert.deepEqual(await t.translate(['Hello there my friend'], 'en'), { lang: 'en', same: true, lines: [] });
  assert.equal(api.calls.length, 1);
});

test('translator: merged lines fall back to one request per line', async () => {
  const api = fakeApi((c) => ({ responseStatus: 200, responseData: { translatedText: c.q.includes('\n') ? 'tout fusionné' : `<${c.q}>`, detectedLanguage: 'en' } }));
  const t = createTranslator({ fetchImpl: api.fetchImpl, gapMs: 0 });
  assert.deepEqual((await t.translate(['One', 'Two'], 'fr')).lines, ['<One>', '<Two>']);
  assert.equal(api.calls.length, 3);
});

test('translator: daily budget and upstream quota answer 503 without calling again', async () => {
  const api = fakeApi();
  const t = createTranslator({ fetchImpl: api.fetchImpl, gapMs: 0, dailyChars: 10 });
  await assert.rejects(t.translate(['This line is too long for the budget'], 'fr'), { status: 503, code: 'QUOTA' });
  assert.equal(api.calls.length, 0);
  const quota = fakeApi(() => ({ responseStatus: 429, quotaFinished: true, responseData: { translatedText: 'MYMEMORY WARNING' } }));
  const q = createTranslator({ fetchImpl: quota.fetchImpl, gapMs: 0 });
  await assert.rejects(q.translate(['Hello'], 'fr'), { status: 503 });
  await assert.rejects(q.translate(['Other'], 'fr'), { status: 503 });
  assert.equal(quota.calls.length, 1); // blocked until midnight UTC
  const down = createTranslator({ fetchImpl: async () => { throw new Error('timeout'); }, gapMs: 0 });
  await assert.rejects(down.translate(['Hello'], 'fr'), { status: 502, code: 'UPSTREAM_ERROR' });
});

test('POST /api/lyrics/translate validates its input', async () => {
  const api = fakeApi();
  const app = createApp({ ytdlp: 'yt-dlp', logger: false, translate: { fetchImpl: api.fetchImpl, gapMs: 0 } });
  const post = (payload) => app.inject({ method: 'POST', url: '/api/lyrics/translate', payload });
  assert.equal((await post({ lines: ['Hi'], to: 'xx' })).statusCode, 400);
  assert.equal((await post({ lines: [], to: 'fr' })).statusCode, 400);
  assert.equal((await post({ lines: [1, 2], to: 'fr' })).statusCode, 400);
  assert.equal((await post({ lines: Array(401).fill('a'), to: 'fr' })).statusCode, 400);
  assert.equal((await post({ lines: ['x'.repeat(20001)], to: 'fr' })).statusCode, 400);
  const ok = await post({ lines: ['Hello', 'World'], to: 'fr' });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json().lines, ['[fr]Hello', '[fr]World']);
});
