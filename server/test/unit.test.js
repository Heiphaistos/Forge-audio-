import { detectService, pickBestMatch } from '../src/streaming.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYtdlpJson, normalizeEntry, canonicalUrl, pickDirectFormat, ytdlpErrorMessage, sourceOf } from '../src/ytdlp.js';
import { isPublicUrl, TtlCache } from '../src/util.js';
import { interleave, searchTarget } from '../src/search.js';
import { cleanTrack, parseLrc } from '../src/lyrics.js';
import { upstreamRange, safeFilename } from '../src/stream.js';

test('parseYtdlpJson: search results drop deleted videos and build YouTube URLs', () => {
  const res = parseYtdlpJson({ _type: 'playlist', extractor: 'youtube:search', entries: [
    { ie_key: 'Youtube', id: 'dQw4w9WgXcQ', title: 'Song', duration: 200.4, uploader: 'Artist' },
    { ie_key: 'Youtube', id: 'xxxxxxxxxxx', title: '[Private video]' },
  ] });
  assert.equal(res.type, 'search');
  assert.equal(res.tracks.length, 1);
  assert.deepEqual(
    { url: res.tracks[0].url, duration: res.tracks[0].duration, author: res.tracks[0].author, source: res.tracks[0].source, thumb: res.tracks[0].thumbnail },
    { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', duration: 200, author: 'Artist', source: 'youtube', thumb: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' },
  );
});

test('parseYtdlpJson: playlists keep their title, single videos become one track', () => {
  const pl = parseYtdlpJson({ _type: 'playlist', extractor: 'youtube:tab', title: 'Mix', entries: [{ ie_key: 'Youtube', id: 'aaaaaaaaaaa', title: 'A' }] });
  assert.equal(pl.type, 'playlist');
  assert.equal(pl.title, 'Mix');
  const one = parseYtdlpJson(JSON.stringify({ id: 'x', title: 'Solo', webpage_url: 'https://soundcloud.com/a/b', extractor: 'soundcloud', is_live: true, duration: 30 }));
  assert.equal(one.type, 'track');
  assert.equal(one.tracks[0].isLive, true);
  assert.equal(one.tracks[0].duration, null);
  assert.equal(one.tracks[0].source, 'soundcloud');
  assert.throws(() => parseYtdlpJson('{nope'), /illisible/);
});

test('normalizeEntry prefers track/artist metadata (YouTube Music)', () => {
  const t = normalizeEntry({ id: 'aaaaaaaaaaa', track: 'Titre', title: 'Artiste - Titre (Clip)', artist: 'Artiste', webpage_url: 'https://music.youtube.com/watch?v=aaaaaaaaaaa&list=X' });
  assert.equal(t.title, 'Titre');
  assert.equal(t.author, 'Artiste');
  assert.equal(t.url, 'https://www.youtube.com/watch?v=aaaaaaaaaaa');
  assert.equal(t.source, 'ytmusic');
});

test('canonicalUrl and sourceOf', () => {
  assert.equal(canonicalUrl('https://youtu.be/dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(canonicalUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDx&index=2'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(canonicalUrl('https://soundcloud.com/a/b'), 'https://soundcloud.com/a/b');
  assert.equal(sourceOf({ extractor: 'dailymotion' }), 'dailymotion');
  assert.equal(sourceOf({}, 'https://artist.bandcamp.com/track/x'), 'bandcamp');
});

test('pickDirectFormat distinguishes progressive, HLS and merged selections', () => {
  const p = pickDirectFormat({ url: 'https://x/a.m4a', protocol: 'https', ext: 'm4a', vcodec: 'none', duration: 10 });
  assert.equal(p.progressive, true);
  assert.equal(p.mime, 'audio/mp4');
  assert.equal(pickDirectFormat({ url: 'https://x/a.m3u8', protocol: 'm3u8_native', ext: 'mp4' }).progressive, false);
  assert.equal(pickDirectFormat({ requested_formats: [{ url: 'a' }, { url: 'b' }] }), null);
});

test('ytdlpErrorMessage keeps the last ERROR line', () => {
  assert.equal(ytdlpErrorMessage('WARNING: x\nERROR: [youtube] abc: Video unavailable\n'), 'Video unavailable');
});

test('isPublicUrl blocks local and private targets', () => {
  for (const bad of ['http://localhost:8787/', 'http://127.0.0.1/', 'http://10.1.2.3/x', 'http://192.168.1.1', 'http://172.20.0.1', 'http://[::1]/', 'http://169.254.169.254/latest', 'file:///etc/passwd', 'ftp://x.org', 'nope']) {
    assert.equal(isPublicUrl(bad), false, bad);
  }
  for (const good of ['https://www.youtube.com/watch?v=x', 'https://soundcloud.com/a', 'http://8.8.8.8/']) assert.equal(isPublicUrl(good), true, good);
});

test('TtlCache.wrap shares in-flight promises and forgets failures', async () => {
  const cache = new TtlCache({ ttlMs: 1000 });
  let calls = 0;
  const producer = async () => { calls += 1; return 42; };
  const [a, b] = await Promise.all([cache.wrap('k', producer), cache.wrap('k', producer)]);
  assert.equal(a + b, 84);
  assert.equal(calls, 1);
  await assert.rejects(cache.wrap('bad', async () => { throw new Error('boom'); }));
  assert.equal(cache.get('bad'), undefined);
});

test('interleave merges round-robin without duplicates', () => {
  const r = interleave([[{ url: 'a' }, { url: 'b' }], [{ url: 'c' }, { url: 'a' }], [{ url: 'd' }]]);
  assert.deepEqual(r.map((t) => t.url), ['a', 'c', 'd', 'b']);
  assert.equal(searchTarget('youtube', 'x y', 5), 'ytsearch5:x y');
  assert.match(searchTarget('ytmusic', 'x y', 5), /music\.youtube\.com\/search\?q=x%20y#songs/);
});

test('cleanTrack extracts artist and title from video titles', () => {
  assert.deepEqual(cleanTrack('Daft Punk - One More Time (Official Video)', 'Daft Punk'), { artist: 'Daft Punk', title: 'One More Time' });
  assert.deepEqual(cleanTrack('Get Lucky ft. Pharrell [HD]', 'Daft Punk - Topic'), { artist: 'Daft Punk', title: 'Get Lucky' });
});

test('parseLrc handles multiple timestamps per line', () => {
  const lines = parseLrc('[00:12.50]Bonjour\n[01:00.00][00:05.00]Refrain\nno stamp');
  assert.deepEqual(lines, [{ time: 5, text: 'Refrain' }, { time: 12.5, text: 'Bonjour' }, { time: 60, text: 'Refrain' }]);
});

test('upstreamRange bounds open-ended ranges', () => {
  assert.equal(upstreamRange(undefined), 'bytes=0-10485759');
  assert.equal(upstreamRange('bytes=100-'), 'bytes=100-10485859');
  assert.equal(upstreamRange('bytes=0-99'), 'bytes=0-99');
  assert.equal(upstreamRange('bytes=-500'), null);
  assert.equal(safeFilename('a/b:c?"d"'), 'a b c d');
});

test('detectService recognizes streaming links', () => {
  assert.deepEqual(detectService('https://open.spotify.com/intl-fr/track/0DiWol3AO6WpXZgp0goxAV?si=x'),
    { service: 'spotify', kind: 'track', id: '0DiWol3AO6WpXZgp0goxAV', url: 'https://open.spotify.com/track/0DiWol3AO6WpXZgp0goxAV' });
  assert.equal(detectService('https://www.deezer.com/fr/album/302127').kind, 'album');
  const apple = detectService('https://music.apple.com/fr/album/discovery/697194953?i=697195787');
  assert.deepEqual([apple.service, apple.kind, apple.id], ['apple', 'song', '697195787']);
  assert.equal(detectService('https://spotify.link/abc').kind, 'short');
  assert.equal(detectService('https://tidal.com/browse/track/1').service, 'unsupported');
  assert.equal(detectService('https://www.youtube.com/watch?v=abc'), null);
  assert.equal(detectService('pas un lien'), null);
});

test('pickBestMatch prefers the closest duration and penalizes covers', () => {
  const wanted = { title: 'One More Time', duration: 320 };
  const best = pickBestMatch([
    { title: 'One More Time (cover)', duration: 320 },
    { title: 'Daft Punk - One More Time (Official Video)', duration: 322 },
    { title: 'One More Time live', duration: 400, isLive: true },
    { title: 'One More Time 1 hour', duration: 3600 },
  ], wanted);
  assert.equal(best.title, 'Daft Punk - One More Time (Official Video)');
});

test('password policy and generator', async () => {
  const { checkPasswordPolicy, generatePassword, hashPassword, verifyPassword } = await import('../src/accounts.js');
  for (let i = 0; i < 20; i += 1) assert.deepEqual(checkPasswordPolicy(generatePassword()), []);
  assert.ok(generatePassword().length >= 75);
  assert.equal(checkPasswordPolicy('Short1!').length > 0, true);
  assert.deepEqual(checkPasswordPolicy('a'.repeat(80)), ['une majuscule', 'un chiffre', 'un symbole']);
  const h = await hashPassword('Secret-1');
  assert.equal(await verifyPassword('Secret-1', h), true);
  assert.equal(await verifyPassword('Secret-2', h), false);
});
