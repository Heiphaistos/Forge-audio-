import crypto from 'node:crypto';
import { HttpError, TtlCache } from './util.js';
import { getJson, dzTrack } from './streaming.js';
import { registerArtists } from './artists.js';

/**
 * Catalogue from Deezer's public API (no key, free): artist pages (top tracks, discography, similar
 * artists), albums, search by type, and recommendations built from the listener's own artists.
 * Deezer tracks play through the existing YouTube match (streaming.js playableUrl).
 * Biographies: Wikipedia summaries (fr, then en).
 *
 * Deezer allows ~50 requests / 5 s per IP: calls go through a small queue and are cached 24 h.
 */

const BASE = 'https://api.deezer.com';
const cache = new TtlCache({ ttlMs: 24 * 3600 * 1000, max: 5000 });
const recoCache = new TtlCache({ ttlMs: 6 * 3600 * 1000, max: 200 });

// ponytail: one global queue, 8 requests/s; per-IP limits are Deezer's, a single server is one IP.
let chain = Promise.resolve();
const GAP_MS = 125;
function throttled(fn) {
  const run = chain.then(() => new Promise((r) => setTimeout(r, GAP_MS))).then(fn);
  chain = run.catch(() => {});
  return run;
}

export async function dz(path) {
  const hit = cache.get(path);
  if (hit !== undefined) return hit;
  const data = await throttled(() => getJson(`${BASE}${path}`, 'Deezer'));
  cache.set(path, data);
  return data;
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const year = (d) => (d && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : null);
const pic = (a) => a?.picture_xl || a?.picture_big || a?.picture_medium || null;
const cover = (a) => a?.cover_xl || a?.cover_big || a?.cover_medium || null;

const artistCard = (a) => ({ id: a.id, name: a.name, picture: a.picture_big || a.picture_medium || null, fans: a.nb_fan ?? null });
const albumCard = (a, artist) => ({
  id: a.id, title: a.title, cover: a.cover_big || a.cover_medium || null, year: year(a.release_date), releaseDate: a.release_date || null,
  type: a.record_type || 'album', artist: (a.artist || artist) ? { id: (a.artist || artist).id, name: (a.artist || artist).name } : null,
  tracks: a.nb_tracks ?? null,
});

/** Best Deezer artist for a name: exact (accent/case-insensitive) match first, else the most followed of the first results. */
export async function findArtist(name) {
  const q = String(name || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
  if (!q) return null;
  const res = await dz(`/search/artist?q=${encodeURIComponent(q)}&limit=10`);
  const list = res.data || [];
  // Homonyms are common (« Justice »): among exact names, the most followed one.
  const byFans = (x, y) => (y.nb_fan || 0) - (x.nb_fan || 0);
  return list.filter((a) => norm(a.name) === norm(q)).sort(byFans)[0] || [...list].sort(byFans)[0] || null;
}

const MUSIC_WORDS = /chanteu|rappeu|groupe|musicien|compositeu|disc-jockey|\bdj\b|artiste|interpr|singer|band|musician|rapper|producer|duo|orchestre/i;
async function wikipedia(name) {
  const tries = [['fr', name], ['fr', `${name} (groupe)`], ['fr', `${name} (chanteur)`], ['fr', `${name} (musicien)`], ['en', name], ['en', `${name} (band)`]];
  for (const [lang, title] of tries) {
    const key = `wiki:${lang}:${title}`;
    let data = cache.get(key);
    if (data === undefined) {
      try {
        const res = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`, { headers: { accept: 'application/json', 'user-agent': 'ForgeAudio/1.0 (https://forgeaudio.heiphaistos.org)' }, signal: AbortSignal.timeout(6000) });
        data = res.ok ? await res.json() : null;
      } catch { data = null; }
      cache.set(key, data);
    }
    if (data?.type === 'standard' && data.extract && MUSIC_WORDS.test(`${data.description || ''} ${data.extract.slice(0, 300)}`)) {
      return { text: data.extract, url: data.content_urls?.desktop?.page || null, lang };
    }
  }
  return null;
}

export async function artistPage({ id, name }) {
  const a = id ? await dz(`/artist/${Number(id)}`) : await findArtist(name);
  if (!a?.id) throw new HttpError('Artiste introuvable dans le catalogue', 404, 'NOT_FOUND');
  const [full, top, albums, related, bio] = await Promise.all([
    a.nb_fan === undefined ? dz(`/artist/${a.id}`) : a,
    dz(`/artist/${a.id}/top?limit=25`),
    dz(`/artist/${a.id}/albums?limit=100`),
    dz(`/artist/${a.id}/related?limit=12`),
    wikipedia(a.name),
  ]);
  const discography = (albums.data || []).map((x) => albumCard(x, full)).sort((x, y) => String(y.releaseDate).localeCompare(String(x.releaseDate)));
  return {
    artist: { id: full.id, name: full.name, picture: pic(full), fans: full.nb_fan ?? null, albums: full.nb_album ?? null },
    top: (top.data || []).map((t) => dzTrack(t)).filter(Boolean),
    albums: discography.filter((x) => x.type === 'album'),
    singles: discography.filter((x) => x.type !== 'album'),
    related: (related.data || []).map(artistCard),
    bio,
  };
}

export async function albumPage(id) {
  const a = await dz(`/album/${Number(id)}`);
  if (!a?.id) throw new HttpError('Album introuvable', 404, 'NOT_FOUND');
  const tracks = (a.tracks?.data || []).map((t) => dzTrack(t, a)).filter(Boolean).map((t) => ({ ...t, album: a.title }));
  return {
    album: { ...albumCard(a), cover: cover(a), duration: a.duration ?? null, label: a.label || null, genres: (a.genres?.data || []).map((g) => g.name) },
    tracks,
  };
}

export async function searchCatalog(q) {
  const query = encodeURIComponent(String(q || '').trim());
  if (!query) throw new HttpError('Recherche vide', 400);
  const [artists, albums, playlists] = await Promise.all([
    dz(`/search/artist?q=${query}&limit=16`), dz(`/search/album?q=${query}&limit=16`), dz(`/search/playlist?q=${query}&limit=16`),
  ]);
  return {
    artists: (artists.data || []).map(artistCard),
    albums: (albums.data || []).map((x) => albumCard(x)),
    playlists: (playlists.data || []).map(playlistCard),
  };
}

const playlistCard = (p) => ({ id: p.id, title: p.title, cover: p.picture_big || p.picture_medium || null, tracks: p.nb_tracks ?? null, by: p.user?.name || null, url: p.link || `https://www.deezer.com/playlist/${p.id}` });
/** Deezer's own curators (« Narjes - Deezer Rap & R&B Editrice France », « Deezer Best Of », « Alexandre - Pop & Hits Editor »). */
export const isEditorial = (p) => /deezer|\beditor\b|[ée]ditrice|[ée]diteur/i.test(p?.user?.name || '');

/**
 * Official playlists of a genre (Home genre cards): the genre's chart of playlists plus editorial
 * playlists found by keyword, curators' only (community playlists stay in the regular search).
 */
export async function genrePlaylists(genreId, queries = []) {
  const id = Number.isInteger(Number(genreId)) && Number(genreId) >= 0 ? Number(genreId) : null;
  const qs = queries.map((q) => String(q).trim()).filter(Boolean).slice(0, 4);
  // Keyword matches first (on topic), then the genre chart (popular but broader: « 00s Hits » under rap).
  const lists = await Promise.all([
    ...qs.map((q) => dz(`/search/playlist?q=${encodeURIComponent(q)}&limit=100`).catch(() => ({ data: [] }))),
    id === null ? { data: [] } : dz(`/chart/${id}/playlists?limit=50`).catch(() => ({ data: [] })),
  ]);
  const seen = new Set();
  const out = [];
  for (const p of lists.flatMap((l) => l.data || [])) {
    if (!isEditorial(p) || seen.has(p.id) || !(p.nb_tracks > 0)) continue;
    seen.add(p.id);
    out.push(playlistCard(p));
  }
  return { playlists: out.slice(0, 60) };
}

// ---------------------------------------------------------------- recommendations
/** Stable pseudo-random order for a given seed (same mixes all day, new discoveries each week). */
function shuffled(list, seed) {
  const out = [...list];
  let h = crypto.createHash('sha256').update(seed).digest().readUInt32BE(0);
  for (let i = out.length - 1; i > 0; i--) {
    h = (h * 1664525 + 1013904223) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const WEEK = () => Math.floor(Date.now() / (7 * 86400000));
const DAY = () => new Date().toISOString().slice(0, 10);

/**
 * @param {{ top: string[], followed: string[], known: string[], hiddenArtists: string[], hiddenTracks: string[] }} input
 *   top: the listener's most played / liked artists (most first); known: every artist in their library.
 */
export async function recommendations(input) {
  const top = [...new Set([...(input.followed || []), ...(input.top || [])].map((s) => String(s).trim()).filter(Boolean))].slice(0, 8);
  if (!top.length) return { mixes: [], discover: null, radar: [], seeds: [] };
  const hiddenA = new Set((input.hiddenArtists || []).map(norm));
  const hiddenT = new Set(input.hiddenTracks || []);
  const knownA = new Set([...(input.known || []), ...top].map(norm));
  const key = crypto.createHash('sha1').update(JSON.stringify([top, [...hiddenA], [...hiddenT].length, DAY()])).digest('hex');
  const hit = recoCache.get(key);
  if (hit) return hit;
  const ok = (t) => t && !hiddenT.has(t.url) && !hiddenA.has(norm(t.author));

  const seeds = [];
  for (const name of top) {
    try {
      const a = await findArtist(name);
      if (!a || hiddenA.has(norm(a.name))) continue;
      const [tops, rel] = await Promise.all([dz(`/artist/${a.id}/top?limit=10`), dz(`/artist/${a.id}/related?limit=8`)]);
      seeds.push({ artist: a, top: (tops.data || []).map((t) => dzTrack(t)).filter(ok), related: (rel.data || []).filter((r) => !hiddenA.has(norm(r.name))) });
    } catch { /* one artist unavailable: skip it */ }
  }

  const topOf = async (a, n) => ((await dz(`/artist/${a.id}/top?limit=${n}`)).data || []).map((t) => dzTrack(t)).filter(ok).slice(0, n);

  // « Mix du jour »: one per favourite artist (4 max), their hits mixed with close artists.
  const mixes = [];
  for (const s of seeds.slice(0, 4)) {
    const others = s.related.slice(0, 4);
    const extra = (await Promise.all(others.map((r) => topOf(r, 4).catch(() => [])))).flat();
    const tracks = shuffled([...s.top.slice(0, 8), ...extra], `${DAY()}:${s.artist.id}`).slice(0, 25);
    if (tracks.length >= 6) {
      mixes.push({ id: `mix-${s.artist.id}`, title: `Mix ${s.artist.name}`, subtitle: `${[s.artist.name, ...others.map((o) => o.name)].slice(0, 4).join(', ')}`, cover: pic(s.artist), tracks });
    }
  }

  // « Découvertes de la semaine »: artists close to yours that are not in your library yet.
  const counts = new Map();
  for (const s of seeds) for (const r of s.related) if (!knownA.has(norm(r.name))) counts.set(r.id, { a: r, n: (counts.get(r.id)?.n || 0) + 1 });
  const fresh = shuffled([...counts.values()].sort((x, y) => y.n - x.n).slice(0, 24), `w${WEEK()}`).slice(0, 15).map((x) => x.a);
  const found = (await Promise.all(fresh.map((a) => topOf(a, 2).catch(() => [])))).flat();
  const discover = found.length >= 6 ? { id: `discover-${WEEK()}`, title: 'Découvertes de la semaine', subtitle: fresh.slice(0, 4).map((a) => a.name).join(', '), cover: pic(fresh[0]), tracks: shuffled(found, `w${WEEK()}t`).slice(0, 30) } : null;

  // « Radar des sorties »: releases of the last 90 days from your artists.
  const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const radar = [];
  for (const s of seeds) {
    try {
      const albums = await dz(`/artist/${s.artist.id}/albums?limit=15`);
      for (const x of albums.data || []) if ((x.release_date || '') >= since) radar.push(albumCard(x, s.artist));
    } catch { /* skip */ }
  }
  radar.sort((x, y) => String(y.releaseDate).localeCompare(String(x.releaseDate)));

  const out = { mixes, discover, radar: radar.slice(0, 12), seeds: seeds.map((s) => artistCard(s.artist)) };
  recoCache.set(key, out);
  return out;
}

export function registerCatalog(app) {
  registerArtists(app);
  app.get('/api/catalog/artist', async (request) => artistPage({ id: request.query.id, name: request.query.name }));
  app.get('/api/catalog/album/:id', async (request) => albumPage(request.params.id));
  app.get('/api/catalog/search', async (request) => searchCatalog(request.query.q));
  app.get('/api/catalog/genre', async (request) => genrePlaylists(request.query.id, [].concat(request.query.q || [])));
  app.post('/api/reco', async (request) => {
    const b = request.body || {};
    const list = (v, n) => (Array.isArray(v) ? v.slice(0, n).map((x) => String(x).slice(0, 200)) : []);
    return recommendations({ top: list(b.top, 20), followed: list(b.followed, 20), known: list(b.known, 3000), hiddenArtists: list(b.hiddenArtists, 2000), hiddenTracks: list(b.hiddenTracks, 5000) });
  });
}
