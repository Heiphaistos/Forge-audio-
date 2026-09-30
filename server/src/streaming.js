/**
 * Streaming-service links (Spotify, Deezer, Apple Music). These services are DRM-protected, so — like the
 * HeiphaisBot music module this is ported from — we read the track metadata from their public pages / APIs
 * (no key needed) and play each title from its best YouTube match, found only when it is about to play.
 */
import { runYtdlp, buildListArgs, parseYtdlpJson } from './ytdlp.js';
import { HttpError, TtlCache } from './util.js';
import { searchDailymotion } from './search.js';

const TIMEOUT = 10_000;
const UA = 'ForgeAudio/0.1 (+https://github.com/Heiphaistos/Forge-audio-)';

export async function getJson(url, service) {
  let res;
  try {
    res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (err) {
    throw new HttpError(`${service} ne répond pas (${err?.name === 'TimeoutError' ? 'délai dépassé' : err.message})`, 502, 'UPSTREAM_ERROR');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    throw new HttpError(res.status === 404 || data?.error?.code === 800 ? `Contenu introuvable sur ${service} (lien privé ou supprimé ?)` : `${service} : erreur ${res.status}`, 502, 'UPSTREAM_ERROR');
  }
  return data;
}

/** Identify a streaming-service link: { service, kind, id, url } or null. */
export function detectService(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'open.spotify.com' || host === 'play.spotify.com') {
    const p = parts[0]?.startsWith('intl-') ? parts.slice(1) : parts; // /intl-fr/track/…
    const i = p.findIndex((x) => ['track', 'album', 'playlist', 'artist'].includes(x));
    if (i >= 0 && p[i + 1]) return { service: 'spotify', kind: p[i], id: p[i + 1], url: `https://open.spotify.com/${p[i]}/${p[i + 1]}` };
  }
  if (host === 'spotify.link' || host === 'spotify.app.link') return { service: 'spotify', kind: 'short', id: null, url: u.href };
  if (host.endsWith('deezer.com')) {
    const i = parts.findIndex((x) => ['track', 'album', 'playlist', 'artist'].includes(x));
    if (i >= 0 && /^\d+$/.test(parts[i + 1] || '')) return { service: 'deezer', kind: parts[i], id: parts[i + 1], url: `https://www.deezer.com/${parts[i]}/${parts[i + 1]}` };
  }
  if (host === 'deezer.page.link' || host === 'link.deezer.com') return { service: 'deezer', kind: 'short', id: null, url: u.href };
  if (host === 'music.apple.com' || host === 'itunes.apple.com') {
    const song = u.searchParams.get('i');
    const id = parts.filter((x) => /^\d+$/.test(x) || /^id\d+$/.test(x)).pop()?.replace(/^id/, '');
    const kind = song ? 'song' : ['album', 'song', 'playlist', 'artist'].find((k) => parts.includes(k));
    if (kind) return { service: 'apple', kind, id: song || id || null, url: u.href };
  }
  if (host.startsWith('music.amazon.') || host === 'tidal.com' || host === 'listen.tidal.com') return { service: 'unsupported', kind: 'any', id: null, url: u.href };
  return null;
}

/** Follow a short link (spotify.link, deezer.page.link) to its canonical URL. */
async function expandShortLink(url) {
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT) });
    const final = detectService(res.url);
    if (final && final.kind !== 'short') return final;
    const m = (await res.text()).match(/https:\/\/(?:open\.spotify\.com|www\.deezer\.com)\/[^"'\s<>]+/);
    const d = m && detectService(m[0]);
    if (d && d.kind !== 'short') return d;
  } catch { /* handled below */ }
  throw new HttpError('Lien raccourci impossible à ouvrir : collez le lien complet (open.spotify.com / deezer.com)');
}

/** Track in the Forge Audio shape; `url` stays the service link, matched on YouTube at playback. */
function track({ title, artists, durationMs, thumbnail, url, source }) {
  const author = (artists || []).filter(Boolean).join(', ') || null;
  return {
    id: url, title: String(title || 'Titre inconnu').slice(0, 300), url, author, album: null, source,
    duration: durationMs > 0 ? Math.round(durationMs / 1000) : null, thumbnail: thumbnail || null, isLive: false, views: null,
  };
}

/** Spotify's public embed page carries the metadata (and up to 100 titles of a list), no API key needed. */
async function resolveSpotify(ref) {
  let html;
  try {
    const res = await fetch(`https://open.spotify.com/embed/${ref.kind}/${ref.id}`, { headers: { 'user-agent': UA, 'accept-language': 'fr' }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) { throw new HttpError(`Spotify ne répond pas (${err.message})`, 502, 'UPSTREAM_ERROR'); }
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]+?)<\/script>/);
  const entity = m ? JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity : null;
  if (!entity) throw new HttpError('Contenu Spotify introuvable (lien privé ou supprimé ?)', 404, 'NOT_FOUND');
  const cover = entity.visualIdentity?.image?.[0]?.url || entity.coverArt?.sources?.[0]?.url || null;
  if (ref.kind === 'track') {
    return { title: null, tracks: [track({ title: entity.name || entity.title, artists: (entity.artists || []).map((a) => a.name), durationMs: entity.duration, thumbnail: cover, url: ref.url, source: 'spotify' })] };
  }
  const tracks = (entity.trackList || []).map((t) => track({
    title: t.title, artists: [t.subtitle], durationMs: t.duration, thumbnail: cover, source: 'spotify',
    url: t.uri?.startsWith('spotify:track:') ? `https://open.spotify.com/track/${t.uri.split(':')[2]}` : null,
  })).filter((t) => t.url);
  return { title: [entity.name || entity.title, entity.subtitle].filter(Boolean).join(' — '), tracks };
}

export const dzTrack = (t, album) => (t?.id && t.readable !== false ? track({
  title: t.title, artists: [t.artist?.name], durationMs: (t.duration || 0) * 1000, source: 'deezer',
  thumbnail: (album || t.album)?.cover_medium || null, url: t.link || `https://www.deezer.com/track/${t.id}`,
}) : null);

export async function deezerPaged(first, max, map) {
  const out = [];
  let next = first;
  while (next && out.length < max) {
    const page = await getJson(next, 'Deezer');
    for (const item of page.data || []) { const t = map(item); if (t) out.push(t); }
    next = page.next;
  }
  return out.slice(0, max);
}

async function resolveDeezer(ref, max) {
  const base = 'https://api.deezer.com';
  if (ref.kind === 'track') return { title: null, tracks: [dzTrack(await getJson(`${base}/track/${ref.id}`, 'Deezer'))].filter(Boolean) };
  if (ref.kind === 'album') {
    const a = await getJson(`${base}/album/${ref.id}`, 'Deezer');
    return { title: `${a.title} — ${a.artist?.name || ''}`, tracks: await deezerPaged(`${base}/album/${ref.id}/tracks?limit=100`, max, (t) => dzTrack(t, a)) };
  }
  if (ref.kind === 'playlist') {
    const p = await getJson(`${base}/playlist/${ref.id}`, 'Deezer');
    return { title: p.title, tracks: await deezerPaged(`${base}/playlist/${ref.id}/tracks?limit=100`, max, (t) => dzTrack(t)) };
  }
  const a = await getJson(`${base}/artist/${ref.id}`, 'Deezer');
  return { title: `Titres populaires de ${a.name}`, tracks: await deezerPaged(`${base}/artist/${ref.id}/top?limit=50`, max, (t) => dzTrack(t)) };
}

/** Apple Music: public iTunes lookup API (albums, songs, artists; playlists are not public). */
async function resolveApple(ref, max) {
  if (!ref.id || ref.kind === 'playlist') throw new HttpError('Les playlists Apple Music ne sont pas publiques : utilisez un lien d\'album ou de titre');
  const data = await getJson(`https://itunes.apple.com/lookup?id=${encodeURIComponent(ref.id)}&entity=song&limit=200&country=fr`, 'Apple Music');
  const songs = (data.results || []).filter((r) => r.wrapperType === 'track');
  if (!songs.length) throw new HttpError('Contenu Apple Music introuvable', 404, 'NOT_FOUND');
  const coll = (data.results || []).find((r) => r.wrapperType === 'collection' || r.wrapperType === 'artist');
  const map = (s) => track({ title: s.trackName, artists: [s.artistName], durationMs: s.trackTimeMillis, thumbnail: s.artworkUrl100?.replace('100x100', '300x300'), url: s.trackViewUrl || ref.url, source: 'apple' });
  const pick = ref.kind === 'song' ? songs.filter((s) => String(s.trackId) === ref.id).concat(songs).slice(0, 1) : songs.slice(0, max);
  return { title: coll ? coll.collectionName || coll.artistName : null, tracks: pick.map(map) };
}

/**
 * Resolve a streaming-service link into tracks, or null when the input is not one (yt-dlp handles it).
 * @returns {Promise<{ type, title, url, thumbnail, tracks } | null>}
 */
export async function resolveStreamingLink(input, { maxEntries = 200 } = {}) {
  let ref = detectService(input);
  if (!ref) return null;
  if (ref.kind === 'short') ref = await expandShortLink(ref.url);
  if (ref.service === 'unsupported') throw new HttpError('Amazon Music et Tidal n\'ont pas d\'accès public : cherchez le titre, ou collez un lien Spotify, Deezer, Apple Music ou YouTube');
  const res = ref.service === 'spotify' ? await resolveSpotify(ref) : ref.service === 'deezer' ? await resolveDeezer(ref, maxEntries) : await resolveApple(ref, maxEntries);
  const tracks = res.tracks.filter(Boolean).slice(0, maxEntries);
  if (!tracks.length) throw new HttpError('Aucun titre lisible dans ce lien', 404, 'NOT_FOUND');
  const single = ref.kind === 'track' || ref.kind === 'song';
  return { type: single ? 'track' : 'playlist', title: res.title, url: ref.url, thumbnail: tracks[0].thumbnail, tracks };
}

/**
 * Choose the YouTube result that best matches a track: closest duration, official audio preferred,
 * covers / live / remixes penalized unless the original title says so.
 */
export function pickBestMatch(candidates, wanted) {
  const title = String(wanted.title || '').toLowerCase();
  const penalize = ['live', 'cover', 'remix', 'karaoke', 'instrumental', 'reaction', 'sped up', 'slowed', 'nightcore', '8d'].filter((w) => !title.includes(w));
  let best = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    if (c.isLive) continue;
    const t = String(c.title || '').toLowerCase();
    let score = 0;
    if (wanted.duration && c.duration) {
      const diff = Math.abs(c.duration - wanted.duration);
      score -= diff > 30 ? 40 + diff / 10 : diff;
    }
    if (/official audio|audio officiel|\(audio\)|topic$/i.test(`${c.title} ${c.author || ''}`)) score += 12;
    if (/official (music )?video|clip officiel/i.test(c.title || '')) score += 4;
    for (const w of penalize) if (t.includes(w)) score -= 25;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

const matches = new TtlCache({ ttlMs: 6 * 3600_000, max: 2000 });

async function youtubeMatch(ytdlp, wanted) {
  const query = `${wanted.author ? `${wanted.author} - ` : ''}${wanted.title}`.slice(0, 200);
  const raw = await runYtdlp(ytdlp, buildListArgs(`ytsearch6:${query}`, { maxEntries: 6 }));
  const best = pickBestMatch(parseYtdlpJson(raw, { maxEntries: 6 }).tracks, wanted);
  if (!best) throw new HttpError(`Introuvable sur YouTube : ${query}`, 404, 'NOT_FOUND');
  return best.url;
}

/** SoundCloud Go+ titles are DRM-protected: find the same title on YouTube (title from the public oEmbed). */
async function soundcloudFallback(ytdlp, url) {
  const data = await getJson(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`, 'SoundCloud');
  const full = String(data.title || ''); // "Minor Swing by Django Reinhardt"
  const cut = full.lastIndexOf(' by ');
  const [title, author] = cut > 0 ? [full.slice(0, cut), full.slice(cut + 4)] : [full, null];
  if (!title) throw new HttpError('Titre SoundCloud protégé (DRM) et introuvable', 404, 'NOT_FOUND');
  return matches.wrap(`drm|${url}`, () => youtubeMatch(ytdlp, { title, author: author || data.author_name || null, duration: null }));
}

/** Run `fn(url)`; if the source refuses because of DRM (SoundCloud Go+), retry with the YouTube equivalent. */
export async function withDrmFallback(ytdlp, url, fn) {
  try {
    return await fn(url);
  } catch (err) {
    if (!/DRM/i.test(err?.message || '') || !/(^|\.)soundcloud\.com$/.test(new URL(url).hostname)) throw err;
    return fn(await soundcloudFallback(ytdlp, url));
  }
}

/** YouTube refuses the server's address (« Sign in to confirm you're not a bot »): an IP block, every client gets it. */
export const isBotCheck = (err) => /confirm you.?re not a bot|sign in to confirm/i.test(err?.message || '');
const isYoutube = (url) => { try { return /(^|\.)(youtube\.com|youtu\.be)$/.test(new URL(url).hostname); } catch { return false; } };
/** « Daft Punk - Instant Crush (Official Video) ft. X » -> « Daft Punk - Instant Crush ft. X » for another site's search. */
export const cleanSearchTitle = (t) => String(t || '')
  .replace(/[([][^)\]]*(official|officiel|video|vid[ée]o|audio|lyrics?|paroles|clip|visualizer|hd|4k|remaster(ed)?)[^)\]]*[)\]]/gi, ' ')
  .replace(/\s+/g, ' ').trim();

/** Same title on SoundCloud (its 30 s previews of Go+ titles skipped), else Dailymotion. */
async function alternativeMatch(ytdlp, wanted) {
  const title = cleanSearchTitle(wanted.title);
  const author = String(wanted.author || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
  const query = (title.toLowerCase().includes(author.toLowerCase()) || !author ? title : `${author} - ${title}`).slice(0, 200);
  const sources = [
    async () => parseYtdlpJson(await runYtdlp(ytdlp, buildListArgs(`scsearch8:${query}`, { maxEntries: 8 })), { maxEntries: 8 }).tracks,
    () => searchDailymotion(query, 6),
  ];
  for (const find of sources) {
    let tracks = [];
    try { tracks = await find(); } catch { continue; }
    const full = tracks.filter((c) => !(c.duration && c.duration <= 31) || (wanted.duration && wanted.duration <= 45));
    const best = pickBestMatch(full, wanted);
    if (best) return best.url;
  }
  throw new HttpError(`YouTube bloque le serveur et « ${query} » est introuvable ailleurs`, 502, 'YOUTUBE_BLOCKED');
}

/**
 * Run `fn(url)`; when YouTube blocks the server, play the same title from SoundCloud / Dailymotion instead.
 * `wanted` = { title, author, duration } sent by the client (the blocked server cannot read the YouTube page).
 * The result says so (`fallback`), so the app can tell the listener.
 */
export async function withBotFallback(ytdlp, url, wanted, fn) {
  try {
    return await fn(url);
  } catch (err) {
    if (!isBotCheck(err) || !isYoutube(url) || !wanted?.title) throw err;
    const alt = await matches.wrap(`alt|${url}`, () => alternativeMatch(ytdlp, wanted));
    return { ...(await fn(alt)), fallback: { url: alt, source: /soundcloud/.test(alt) ? 'soundcloud' : 'dailymotion' } };
  }
}

/** Playable URL for any link: streaming-service titles are replaced by their YouTube match. */
export function playableUrl(ytdlp, url) {
  if (!detectService(url)) return Promise.resolve(url);
  return matches.wrap(url, async () => {
    const [wanted] = (await resolveStreamingLink(url, { maxEntries: 1 })).tracks;
    return youtubeMatch(ytdlp, wanted);
  });
}
