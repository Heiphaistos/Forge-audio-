import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planOffline, formatBytes } from './offline-plan.ts';
import type { Track } from './types.ts';

const t = (n: number, extra: Partial<Track> = {}): Track => ({ id: String(n), title: `T${n}`, url: `https://www.youtube.com/watch?v=${n}`, duration: 200, thumbnail: null, author: 'A', source: 'youtube', ...extra });
const rec = (track: Track, pins: string[], stored = true) => ({ url: track.url, track, pins, stored });

test('marking a collection downloads its eligible tracks only', () => {
  const live = t(3, { isLive: true });
  const local = t(4, { url: 'blob:x', source: 'local' });
  const p = planOffline(['liked'], { liked: [t(1), t(2), live, local] }, []);
  assert.deepEqual(p.download.map((d) => d.track.id), ['1', '2']);
  assert.deepEqual(p.download[0].pins, ['liked']);
});

test('a track kept by two reasons survives losing one of them', () => {
  const a = t(1);
  const p = planOffline(['pl:x'], { liked: [a], 'pl:x': [a] }, [rec(a, ['liked', 'pl:x'])]);
  assert.deepEqual(p.update, [{ url: a.url, pins: ['pl:x'] }]);
  assert.deepEqual(p.remove, []);
});

test('unmarking deletes what nothing keeps; single pins stay', () => {
  const a = t(1);
  const b = t(2);
  const p = planOffline([], { liked: [a, b] }, [rec(a, ['liked']), rec(b, ['liked', 'track'])]);
  assert.deepEqual(p.remove, [a.url]);
  assert.deepEqual(p.update, [{ url: b.url, pins: ['track'] }]);
});

test('a deleted playlist drops out and its tracks go', () => {
  const a = t(1);
  const p = planOffline(['pl:gone'], { liked: [] }, [rec(a, ['pl:gone'])]);
  assert.deepEqual(p.sets, []);
  assert.deepEqual(p.remove, [a.url]);
});

test('a pending single track is downloaded, an up-to-date one untouched', () => {
  const a = t(1);
  const b = t(2);
  const p = planOffline(['liked'], { liked: [b] }, [rec(a, ['track'], false), rec(b, ['liked'])]);
  assert.deepEqual(p.download, [{ track: a, pins: ['track'] }]);
  assert.deepEqual(p.update, []);
  assert.deepEqual(p.remove, []);
});

test('formatBytes', () => {
  assert.equal(formatBytes(340 * 1024 ** 2), '340 Mo');
  assert.equal(formatBytes(1.25 * 1024 ** 3).replace(/\s/g, ' '), '1,3 Go');
});
