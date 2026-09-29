import { TtlCache } from './util.js';

/**
 * Lyrics from LRCLIB (https://lrclib.net), a free and open lyrics database with synced (LRC) lyrics.
 */

const cache = new TtlCache({ ttlMs: 6 * 60 * 60 * 1000, max: 500 });
const UA = 'ForgeAudio/0.1 (+https://github.com/Heiphaistos/Forge-audio-)';

const NOISE = /\s*[([](official|officiel|clip|lyrics?|paroles|audio|video|vidéo|visuali[sz]er|hd|hq|4k|remaster(ed)?|live|explicit|mv|m\/v|full album)[^)\]]*[)\]]/gi;

/** "Artist - Title (Official Video) ft. X" → { artist, title } */
export function cleanTrack(title = '', author = '') {
  let t = String(title).replace(NOISE, '').replace(/\s*[|｜].*$/, '').replace(/\s+/g, ' ').trim();
  let artist = String(author || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
  const dash = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) {
    artist = dash[1].trim();
    t = dash[2].trim();
  }
  t = t.replace(/\s+(ft\.?|feat\.?|featuring)\s+.*$/i, '').replace(/["“”]/g, '').trim();
  return { artist, title: t };
}

async function lrclib(path) {
  const res = await fetch(`https://lrclib.net/api/${path}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`LRCLIB ${res.status}`);
  return res.json();
}

/** Parse LRC text into [{ time (s), text }] sorted by time. */
export function parseLrc(lrc) {
  const lines = [];
  for (const raw of String(lrc || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const s of stamps) lines.push({ time: Number(s[1]) * 60 + Number(s[2]), text });
  }
  return lines.sort((a, b) => a.time - b.time);
}

/**
 * Find lyrics for a track. Never throws: returns { found: false } when nothing matches.
 */
export async function findLyrics({ title, author, duration }) {
  const q = cleanTrack(title, author);
  if (!q.title) return { found: false };
  const key = `${q.artist}|${q.title}|${duration || ''}`.toLowerCase();
  return cache.wrap(key, async () => {
    try {
      let hit = null;
      if (q.artist) {
        const params = new URLSearchParams({ artist_name: q.artist, track_name: q.title });
        if (duration) params.set('duration', String(Math.round(duration)));
        hit = await lrclib(`get?${params}`);
      }
      if (!hit) {
        const results = await lrclib(`search?${new URLSearchParams({ q: [q.artist, q.title].filter(Boolean).join(' ') })}`);
        if (Array.isArray(results) && results.length) {
          hit = results.find((r) => r.syncedLyrics && (!duration || Math.abs((r.duration || 0) - duration) < 8)) || results.find((r) => r.syncedLyrics) || results[0];
        }
      }
      if (!hit || (!hit.syncedLyrics && !hit.plainLyrics)) return { found: false, query: q };
      return {
        found: true,
        query: q,
        artist: hit.artistName,
        title: hit.trackName,
        instrumental: !!hit.instrumental,
        synced: hit.syncedLyrics ? parseLrc(hit.syncedLyrics) : null,
        plain: hit.plainLyrics || null,
      };
    } catch {
      return { found: false, query: q, error: true };
    }
  });
}
