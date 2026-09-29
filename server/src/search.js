import { runYtdlp, buildListArgs, parseYtdlpJson } from './ytdlp.js';
import { HttpError } from './util.js';

export const SOURCES = ['all', 'youtube', 'ytmusic', 'soundcloud', 'dailymotion'];

const FETCH_TIMEOUT = 15_000;

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), headers: { 'user-agent': 'ForgeAudio/0.1 (+https://github.com/Heiphaistos/Forge-audio-)' } });
  if (!res.ok) throw new HttpError(`La source a répondu ${res.status}`, 502, 'UPSTREAM_ERROR');
  return res.json();
}

/** Dailymotion has no yt-dlp search prefix, so use its public REST API. */
export async function searchDailymotion(query, limit) {
  const params = new URLSearchParams({
    search: query,
    limit: String(limit),
    fields: 'id,title,duration,thumbnail_360_url,owner.screenname,url,views_total',
  });
  const json = await fetchJson(`https://api.dailymotion.com/videos?${params}`);
  return (json.list || []).map((v) => ({
    id: String(v.id),
    title: String(v.title || v.id).slice(0, 300),
    url: v.url || `https://www.dailymotion.com/video/${v.id}`,
    duration: Number(v.duration) > 0 ? Math.round(Number(v.duration)) : null,
    thumbnail: v.thumbnail_360_url || null,
    author: v['owner.screenname'] || null,
    album: null,
    source: 'dailymotion',
    isLive: false,
    views: Number(v.views_total) > 0 ? Number(v.views_total) : null,
  }));
}

/** yt-dlp search target for a source. */
export function searchTarget(source, query, limit) {
  switch (source) {
    case 'youtube': return `ytsearch${limit}:${query}`;
    case 'soundcloud': return `scsearch${limit}:${query}`;
    case 'ytmusic': return `https://music.youtube.com/search?q=${encodeURIComponent(query)}#songs`;
    default: throw new HttpError(`Source inconnue : ${source}`);
  }
}

async function searchOne(ytdlp, source, query, limit) {
  if (source === 'dailymotion') return searchDailymotion(query, limit);
  const raw = await runYtdlp(ytdlp, buildListArgs(searchTarget(source, query, limit), { maxEntries: limit }));
  return parseYtdlpJson(raw, { maxEntries: limit }).tracks.map((t) => (source === 'ytmusic' ? { ...t, source: 'ytmusic' } : t));
}

/** Round-robin merge of several result lists, skipping duplicate URLs. */
export function interleave(lists) {
  const out = [];
  const seen = new Set();
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i += 1) {
    for (const list of lists) {
      const t = list[i];
      if (t && !seen.has(t.url)) {
        seen.add(t.url);
        out.push(t);
      }
    }
  }
  return out;
}

/**
 * Search one source, or all of them in parallel (failures of a single source are tolerated).
 * @returns {{ tracks: object[], errors: Record<string,string> }}
 */
export async function search(ytdlp, query, { source = 'youtube', limit = 20 } = {}) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) throw new HttpError('Précisez un titre, un artiste ou une URL');
  if (!SOURCES.includes(source)) throw new HttpError(`Source inconnue : ${source}`);
  if (source !== 'all') return { tracks: await searchOne(ytdlp, source, q, limit), errors: {} };

  const parts = ['youtube', 'soundcloud', 'dailymotion'];
  const per = Math.max(3, Math.ceil(limit / 2));
  const settled = await Promise.allSettled(parts.map((s) => searchOne(ytdlp, s, q, per)));
  const errors = {};
  const lists = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    errors[parts[i]] = r.reason?.message || 'erreur';
    return [];
  });
  if (settled.every((r) => r.status === 'rejected')) throw settled[0].reason;
  return { tracks: interleave(lists).slice(0, limit * 2), errors };
}

/** Search-as-you-type suggestions (YouTube flavoured). Never throws: returns [] on failure. */
export async function suggest(query) {
  const q = String(query || '').trim().slice(0, 100);
  if (!q) return [];
  try {
    const json = await fetchJson(`https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(q)}`);
    return Array.isArray(json?.[1]) ? json[1].slice(0, 8).map(String) : [];
  } catch {
    return [];
  }
}

const YT_WATCH = /^https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})$/;

/**
 * "Radio" for a track: YouTube's own mix playlist when available, otherwise a search on the artist.
 */
export async function radio(ytdlp, track, { limit = 25 } = {}) {
  const m = YT_WATCH.exec(String(track.url || ''));
  if (m) {
    try {
      const raw = await runYtdlp(ytdlp, buildListArgs(`https://www.youtube.com/watch?v=${m[1]}&list=RD${m[1]}`, { maxEntries: limit + 1 }));
      const tracks = parseYtdlpJson(raw, { maxEntries: limit + 1 }).tracks.filter((t) => t.url !== track.url);
      if (tracks.length) return tracks.slice(0, limit);
    } catch {
      // Some videos have no mix: fall back to a search.
    }
  }
  const seed = [track.author, track.author ? '' : track.title].filter(Boolean).join(' ') || track.title;
  if (!seed) return [];
  const { tracks } = await search(ytdlp, `${seed} mix`, { source: track.source === 'soundcloud' ? 'soundcloud' : 'youtube', limit });
  return tracks.filter((t) => t.url !== track.url);
}
