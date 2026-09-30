// node --experimental-strip-types --test web/src/lib/merge.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge, type SyncData } from './merge.ts';

const track = (n: number, addedAt = 0) => ({ id: `t${n}`, title: `Titre ${n}`, url: `https://youtu.be/${n}`, duration: 100, thumbnail: null, author: 'A', source: 'youtube', addedAt });

function doc(lib: Partial<SyncData['library']>): SyncData {
  return { library: { playlists: [], deletedPlaylists: {}, liked: [], history: [], playCounts: {}, ...lib }, settings: {}, player: null };
}

test('likes from both devices are kept, newest first', () => {
  const r = merge(doc({ liked: [track(1, 300)] }), doc({ liked: [track(2, 200), track(1, 300)] }));
  assert.deepEqual(r.library.liked.map((t) => t.id), ['t1', 't2']);
});

test('an unlike on this device is not undone by the server copy', () => {
  const r = merge(doc({ liked: [], unliked: { 'https://youtu.be/1': 500 } }), doc({ liked: [track(1, 300)] }));
  assert.equal(r.library.liked.length, 0);
});

test('an unlike on another device removes the track here too', () => {
  const r = merge(doc({ liked: [track(1, 300)] }), doc({ liked: [], unliked: { 'https://youtu.be/1': 500 } }));
  assert.equal(r.library.liked.length, 0);
});

test('liking again after an unlike wins over the old tombstone', () => {
  const r = merge(doc({ liked: [track(1, 900)] }), doc({ liked: [], unliked: { 'https://youtu.be/1': 500 } }));
  assert.deepEqual(r.library.liked.map((t) => t.id), ['t1']);
  assert.equal(r.library.unliked!['https://youtu.be/1'], 500);
});

test('old likes without a date are dropped only when unliked', () => {
  const r = merge(doc({ liked: [track(1)] }), doc({ liked: [track(2)] }));
  assert.equal(r.library.liked.length, 2);
});

test('followed artists merge like likes (case-insensitive key)', () => {
  const r = merge(
    doc({ followedArtists: [{ name: 'Daft Punk', thumbnail: null, at: 100 }] }),
    doc({ followedArtists: [{ name: 'daft  punk', thumbnail: null, at: 50 }, { name: 'Justice', thumbnail: null, at: 60 }], unfollowed: { justice: 90 } }),
  );
  assert.deepEqual(r.library.followedArtists!.map((a) => a.name), ['Daft Punk']);
});
