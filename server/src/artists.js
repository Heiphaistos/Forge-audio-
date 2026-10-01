import { HttpError, TtlCache, clampInt } from './util.js';
import { dz, genrePlaylists } from './catalog.js';

/**
 * Artist directory (« Artistes » page), from Deezer's public API through catalog.js's cached,
 * throttled `dz` (no key, called by the server only):
 *   - all: Deezer's artist chart; genre:<id>: the artists of the genre's official (curated) playlists,
 *     most frequent first (Deezer's /genre/<id>/artists and /chart/<id>/artists ignore the genre);
 *     country:<playlist>: the artists of Deezer Charts' « Top <country> » playlist;
 *   - then, endlessly, the artists similar to those already listed (breadth-first, no duplicates),
 *     so every list keeps going instead of stopping at the 100 of a chart;
 *   - q: Deezer's artist search, paginated.
 */

const CHARTS_USER = 637006841; // « Deezer Charts »: one « Top <Country> » playlist per country
const PAGE = 48;
const MAX = 2000; // ponytail: a directory stops growing at 2 000 artists (≈ 40 pages); search covers the rest
const STEPS = 30; // similar-artist lookups per request at most (≈ 4 s at Deezer's pace)
const dirs = new TtlCache({ ttlMs: 24 * 3600 * 1000, max: 300 });

const card = (a) => ({ id: a.id, name: a.name, picture: a.picture_big || a.picture_medium || null, fans: a.nb_fan ?? null });

// Deezer Charts names countries in English: map them to ISO codes (French name + flag) with ICU.
const EN = new Intl.DisplayNames(['en'], { type: 'region' });
const FR = new Intl.DisplayNames(['fr'], { type: 'region' });
const CODES = new Map([['usa', 'US'], ['uk', 'GB'], ['czech republic', 'CZ'], ['ivory coast', 'CI'], ['russia', 'RU'], ['turkey', 'TR'], ['brasil', 'BR']]);
for (let i = 0; i < 26 * 26; i++) {
  const code = String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26));
  try {
    const n = EN.of(code);
    // Skip retired codes (DD « Germany » before DE, FX…): ICU canonicalises them to the current one.
    if (n && n !== code && new Intl.Locale(`und-${code}`).region === code && !CODES.has(n.toLowerCase())) CODES.set(n.toLowerCase(), code);
  } catch { /* not a region */ }
}
const flag = (code) => String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

export async function scopes() {
  const [genres, lists] = await Promise.all([dz('/genre'), dz(`/user/${CHARTS_USER}/playlists?limit=300`)]);
  const countries = [];
  for (const p of lists.data || []) {
    const name = String(p.title || '').match(/^Top ([A-Za-z][A-Za-z .'-]+)$/)?.[1];
    const code = name && CODES.get(name.toLowerCase());
    if (code && !countries.some((c) => c.code === code)) countries.push({ id: p.id, code, name: FR.of(code) || name, flag: flag(code) });
  }
  return {
    // 0 = « Tous », 457 = audiobooks: not artists anyone browses for.
    genres: (genres.data || []).filter((g) => g.id > 0 && g.id !== 457).map((g) => ({ id: g.id, name: g.name, picture: g.picture_big || g.picture_medium || null })),
    countries: countries.sort((a, b) => a.name.localeCompare(b.name, 'fr')),
  };
}

async function seedsOf(scope) {
  const [kind, id] = scope.split(':');
  if (kind === 'all') return (await dz('/chart/0/artists?limit=100')).data || [];
  if (kind === 'genre') {
    const g = ((await dz('/genre')).data || []).find((x) => String(x.id) === id && x.id > 0 && x.id !== 457);
    if (!g) throw new HttpError('Genre inconnu', 404, 'NOT_FOUND');
    const { playlists } = await genrePlaylists(g.id, g.name.split('/').map((s) => s.trim()));
    const lists = await Promise.all(playlists.slice(0, 4).map((p) => dz(`/playlist/${p.id}/tracks?limit=100`).catch(() => ({ data: [] }))));
    const count = new Map();
    for (const t of lists.flatMap((l) => l.data || [])) if (t.artist?.id) count.set(t.artist.id, { a: t.artist, n: (count.get(t.artist.id)?.n || 0) + 1 });
    return [...count.values()].sort((x, y) => y.n - x.n).map((x) => x.a);
  }
  // Country: only Deezer Charts' own playlists, not any playlist id a client sends.
  if (!(await scopes()).countries.some((c) => String(c.id) === id)) throw new HttpError('Pays inconnu', 404, 'NOT_FOUND');
  return ((await dz(`/playlist/${id}/tracks?limit=100`)).data || []).map((t) => t.artist).filter(Boolean);
}

/** One page of a directory, growing it with similar artists when the page is past its end. */
export async function directory(scope, index = 0) {
  if (!/^(all|genre:\d{1,6}|country:\d{1,15})$/.test(scope)) throw new HttpError('Catégorie inconnue', 400, 'BAD_SCOPE');
  let d = dirs.get(scope);
  if (!d) dirs.set(scope, (d = { list: [], seen: new Set(), next: 0, seeded: false, done: false, run: Promise.resolve() }));
  const add = (artists) => {
    for (const a of artists) {
      if (!a?.id || d.seen.has(a.id) || d.list.length >= MAX) continue;
      d.seen.add(a.id);
      d.list.push(card(a));
    }
  };
  // One growth at a time per directory: two viewers of the same page never fetch it twice.
  const job = d.run.then(async () => {
    if (!d.seeded) { add(await seedsOf(scope)); d.seeded = true; }
    for (let steps = 0; d.list.length < index + PAGE && !d.done && steps < STEPS; steps++) {
      if (d.next >= d.list.length || d.list.length >= MAX) { d.done = true; break; }
      const a = d.list[d.next++];
      add((await dz(`/artist/${a.id}/related?limit=20`).catch(() => ({ data: [] }))).data || []);
    }
  });
  d.run = job.catch(() => {});
  await job;
  const artists = d.list.slice(index, index + PAGE);
  // A short page (growth capped by STEPS) continues right after its last artist.
  const next = index + artists.length;
  return { artists, next: artists.length && (next < d.list.length || !d.done) ? next : null };
}

export async function searchArtists(q, index = 0) {
  const query = String(q || '').trim().slice(0, 200);
  if (!query) throw new HttpError('Recherche vide', 400);
  const res = await dz(`/search/artist?q=${encodeURIComponent(query)}&index=${index}&limit=${PAGE}`);
  const end = index + PAGE;
  return { artists: (res.data || []).map(card), next: end < (res.total || 0) && (res.data || []).length ? end : null };
}

export function registerArtists(app) {
  app.get('/api/catalog/artists/scopes', async () => scopes());
  app.get('/api/catalog/artists', async (request) => {
    const { q, scope = 'all', index } = request.query;
    const i = clampInt(index, 0, MAX, 0);
    return q ? searchArtists(q, i) : directory(String(scope), i);
  });
}
