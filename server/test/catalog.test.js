import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artistPage, recommendations } from '../src/catalog.js';

// Fake Deezer + Wikipedia: the CI never calls the real services.
const artists = {
  1: { id: 1, name: 'Justice', nb_fan: 800000, nb_album: 5, picture_big: 'https://e.test/1.jpg' },
  2: { id: 2, name: 'Justice', nb_fan: 1000 },
  3: { id: 3, name: 'Cassius', nb_fan: 90000 },
  4: { id: 4, name: 'Masqué', nb_fan: 5000 },
};
const trackOf = (id, n) => ({ id: id * 100 + n, title: `${artists[id].name} ${n}`, duration: 200, readable: true, artist: { id, name: artists[id].name }, album: { cover_medium: null } });

function fakeFetch() {
  return async (url) => {
    const u = new URL(url);
    const json = (body, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => body });
    if (u.hostname.endsWith('wikipedia.org')) return json({ type: 'standard', description: 'groupe de musique électronique', extract: 'Justice est un groupe français.', content_urls: { desktop: { page: 'https://fr.wikipedia.org/wiki/Justice' } } });
    const p = u.pathname;
    if (p === '/search/artist') return json({ data: [artists[2], artists[1]] });
    let m;
    if ((m = p.match(/^\/artist\/(\d+)$/))) return json(artists[m[1]]);
    if ((m = p.match(/^\/artist\/(\d+)\/top$/))) return json({ data: Array.from({ length: 6 }, (_, i) => trackOf(Number(m[1]), i)) });
    if ((m = p.match(/^\/artist\/(\d+)\/related$/))) return json({ data: [artists[3], artists[4]] });
    if ((m = p.match(/^\/artist\/(\d+)\/albums$/))) return json({ data: [{ id: 10, title: 'Hyperdrama', release_date: '2024-04-26', record_type: 'album', nb_tracks: 13 }, { id: 11, title: 'Generator', release_date: '2023-11-02', record_type: 'single', nb_tracks: 1 }] });
    return json({ error: { message: 'not found' } }, false);
  };
}

test('artist page: the most followed homonym, top tracks, albums vs singles, similar artists, bio', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = fakeFetch();
  try {
    const a = await artistPage({ name: 'justice' });
    assert.equal(a.artist.id, 1, 'Justice (800 000 fans), not the 1 000-fan homonym');
    assert.equal(a.top.length, 6);
    assert.match(a.top[0].url, /^https:\/\/www\.deezer\.com\/track\/\d+$/, 'played through the YouTube match like any Deezer link');
    assert.deepEqual([a.albums.map((x) => x.title), a.singles.map((x) => x.title)], [['Hyperdrama'], ['Generator']]);
    assert.deepEqual(a.related.map((r) => r.name), ['Cassius', 'Masqué']);
    assert.match(a.bio.text, /groupe/);

    const r = await recommendations({ top: ['Justice'], followed: [], known: ['Justice'], hiddenArtists: ['masqué'], hiddenTracks: [] });
    assert.equal(r.mixes.length, 1);
    assert.ok(r.mixes[0].tracks.every((t) => t.author !== 'Masqué'), 'hidden artists never recommended');
    assert.ok(!r.discover || r.discover.tracks.every((t) => t.author === 'Cassius'), 'discoveries = artists not already in the library');
  } finally {
    globalThis.fetch = real;
  }
});
