import { spawn } from 'node:child_process';
import { HttpError, isHttpUrl } from './util.js';

/**
 * yt-dlp helpers: argument builders, process runner and JSON normalization.
 * Adapted from the HeiphaisBot music module (src/modules/music/sources.js).
 */

export const YTDLP_MISSING_MESSAGE = 'yt-dlp est introuvable : installez-le (https://github.com/yt-dlp/yt-dlp#installation, ex. `pip install -U yt-dlp`) ou indiquez son chemin avec la variable YTDLP_PATH.';

/** Run yt-dlp and resolve with stdout. Rejects with an HttpError on missing binary, timeout or failure. */
export function runYtdlp(bin, args, { timeoutMs = 45_000, maxBuffer = 48 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(bin || 'yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      reject(err.code === 'ENOENT' ? new HttpError(YTDLP_MISSING_MESSAGE, 503, 'YTDLP_MISSING') : err);
      return;
    }
    const out = [];
    let size = 0;
    let stderr = '';
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(v);
    };
    const kill = () => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } };
    const timer = setTimeout(() => {
      kill();
      finish(reject, new HttpError('La source a mis trop de temps à répondre, réessayez.', 504, 'YTDLP_TIMEOUT'));
    }, timeoutMs);
    proc.stdout.on('data', (d) => {
      size += d.length;
      if (size > maxBuffer) {
        kill();
        finish(reject, new HttpError('Réponse de yt-dlp trop volumineuse', 502, 'YTDLP_ERROR'));
        return;
      }
      out.push(d);
    });
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
    proc.on('error', (err) => finish(reject, err.code === 'ENOENT'
      ? new HttpError(YTDLP_MISSING_MESSAGE, 503, 'YTDLP_MISSING')
      : new HttpError(`Erreur yt-dlp : ${err.message}`, 502, 'YTDLP_ERROR')));
    proc.on('close', (code) => {
      if (code === 0) return finish(resolve, Buffer.concat(out).toString('utf8'));
      finish(reject, new HttpError(`Impossible de lire ce contenu : ${ytdlpErrorMessage(stderr) || `code ${code}`}`, 502, 'YTDLP_ERROR'));
    });
  });
}

/** Extract a readable error line from yt-dlp stderr. */
export function ytdlpErrorMessage(stderr = '') {
  const lines = String(stderr).split('\n').map((l) => l.trim()).filter(Boolean);
  const err = lines.reverse().find((l) => l.startsWith('ERROR')) || lines[0] || '';
  return err.replace(/^ERROR:\s*/, '').replace(/\[[^\]]+\]\s*[\w-]+:\s*/, '').slice(0, 300);
}

/** Arguments to list entries (search results, playlists) without resolving each one. */
export function buildListArgs(target, { maxEntries = 100 } = {}) {
  return ['--dump-single-json', '--flat-playlist', '--no-warnings', '--playlist-end', String(Math.max(1, maxEntries)), '--', target];
}

/** Arguments to fully resolve one media (formats, direct URLs, headers). */
export function buildInfoArgs(url, format) {
  const args = ['--dump-single-json', '--no-playlist', '--no-warnings'];
  if (format) args.push('-f', format);
  args.push('--', url);
  return args;
}

/** Arguments to stream a media on stdout (used for HLS/DASH sources that cannot be proxied byte-for-byte). */
export function buildPipeArgs(url, format, ffmpegPath) {
  const args = ['-f', format, '-o', '-', '--no-playlist', '--no-warnings', '--quiet', '--no-part', '--no-cache-dir'];
  if (ffmpegPath) args.push('--ffmpeg-location', ffmpegPath);
  args.push('--', url);
  return args;
}

// ---------- JSON normalization ----------
const YT_ID = /^[\w-]{11}$/;

function bestThumbnail(e) {
  if (e.thumbnail) return e.thumbnail;
  if (Array.isArray(e.thumbnails) && e.thumbnails.length) {
    const sorted = [...e.thumbnails].filter((t) => t?.url).sort((a, b) => (a.width || a.preference || 0) - (b.width || b.preference || 0));
    const pick = sorted.at(-1);
    if (pick) return pick.url;
  }
  const ie = String(e.ie_key || e.extractor_key || '').toLowerCase();
  if ((ie.includes('youtube') || !ie) && YT_ID.test(e.id || '')) return `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`;
  return null;
}

function entryUrl(e) {
  const ie = String(e.ie_key || e.extractor_key || e.extractor || '').toLowerCase();
  if (e.webpage_url) return e.webpage_url;
  if (e.url && isHttpUrl(e.url)) return e.url;
  if (e.original_url) return e.original_url;
  if (e.id && YT_ID.test(e.id) && (ie.includes('youtube') || !ie)) return `https://www.youtube.com/watch?v=${e.id}`;
  return null;
}

/** Map an extractor name to one of the sources the UI knows about. */
export function sourceOf(e, url = '') {
  const raw = String(e.ie_key || e.extractor_key || e.extractor || '').toLowerCase();
  const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  if (host.startsWith('music.youtube.')) return 'ytmusic';
  if (raw.includes('youtube') || /(^|\.)youtu(\.be|be\.com)$/.test(host)) return 'youtube';
  if (raw.includes('soundcloud') || host.endsWith('soundcloud.com')) return 'soundcloud';
  if (raw.includes('dailymotion') || host.endsWith('dailymotion.com')) return 'dailymotion';
  if (raw.includes('bandcamp') || host.endsWith('bandcamp.com')) return 'bandcamp';
  if (raw.includes('vimeo') || host.endsWith('vimeo.com')) return 'vimeo';
  if (raw.includes('twitch') || host.endsWith('twitch.tv')) return 'twitch';
  return raw.split(':')[0] || 'web';
}

/** Canonical YouTube watch URL: strips playlist/radio parameters so the same video always has the same key. */
export function canonicalUrl(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)youtube\.com$/.test(u.hostname) && u.searchParams.get('v')) return `https://www.youtube.com/watch?v=${u.searchParams.get('v')}`;
    if (u.hostname === 'youtu.be') return `https://www.youtube.com/watch?v=${u.pathname.slice(1)}`;
    return url;
  } catch {
    return url;
  }
}

/** Normalize a yt-dlp entry into a track (duration in seconds). */
export function normalizeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const rawUrl = entryUrl(e);
  if (!rawUrl) return null;
  const url = canonicalUrl(rawUrl);
  const isLive = e.is_live === true || e.live_status === 'is_live';
  return {
    id: e.id ? String(e.id) : url,
    title: String(e.track || e.title || e.fulltitle || url).slice(0, 300),
    url,
    duration: !isLive && Number(e.duration) > 0 ? Math.round(Number(e.duration)) : null,
    thumbnail: bestThumbnail(e),
    author: e.artist || e.artists?.[0] || e.uploader || e.channel || e.creator || null,
    album: e.album || null,
    source: sourceOf(e, rawUrl),
    isLive,
    views: Number(e.view_count) > 0 ? Number(e.view_count) : null,
  };
}

/**
 * Parse `--dump-single-json` output.
 * @returns {{ type: 'search'|'playlist'|'track', title: string|null, url: string|null, thumbnail: string|null, tracks: object[] }}
 */
export function parseYtdlpJson(raw, { maxEntries = 100 } = {}) {
  let json;
  try {
    json = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new HttpError('Réponse de yt-dlp illisible', 502, 'YTDLP_ERROR');
  }
  if (!json || typeof json !== 'object') throw new HttpError('Réponse de yt-dlp vide', 502, 'YTDLP_ERROR');
  const isPlaylist = json._type === 'playlist' || Array.isArray(json.entries);
  if (isPlaylist) {
    const extractor = String(json.extractor || json.extractor_key || json.ie_key || '').toLowerCase();
    const isSearch = extractor.includes('search');
    const tracks = (json.entries || [])
      .flatMap((e) => (e && Array.isArray(e.entries) ? e.entries : [e]))
      .map(normalizeEntry)
      .filter(Boolean)
      .filter((t) => !/^\[(private|deleted) video\]$/i.test(t.title))
      .slice(0, maxEntries);
    return {
      type: isSearch ? 'search' : 'playlist',
      title: isSearch ? null : (json.title || null),
      url: json.webpage_url || json.original_url || null,
      thumbnail: isSearch ? null : bestThumbnail(json) || tracks[0]?.thumbnail || null,
      tracks,
    };
  }
  const t = normalizeEntry(json);
  return { type: 'track', title: t?.title || null, url: t?.url || null, thumbnail: t?.thumbnail || null, tracks: t ? [t] : [] };
}

/**
 * Pick the direct media URL out of a fully resolved yt-dlp info JSON (after `-f`).
 * Returns { url, headers, protocol, ext, mime } or null when the selection is a merge of several streams.
 */
export function pickDirectFormat(info) {
  if (!info || typeof info !== 'object') return null;
  if (Array.isArray(info.requested_formats) && info.requested_formats.length > 1) return null;
  const fmt = info.requested_formats?.[0] || info;
  if (!fmt.url) return null;
  const protocol = String(fmt.protocol || '').toLowerCase();
  const ext = fmt.ext || info.ext || null;
  return {
    url: fmt.url,
    headers: fmt.http_headers || info.http_headers || {},
    protocol,
    ext,
    mime: mimeFor(ext, fmt.vcodec === 'none' || fmt.vcodec === undefined),
    progressive: protocol === 'https' || protocol === 'http',
    duration: Number(info.duration) > 0 ? Number(info.duration) : null,
  };
}

export function mimeFor(ext, audioOnly = true) {
  switch (ext) {
    case 'm4a': return 'audio/mp4';
    case 'mp4': return audioOnly ? 'audio/mp4' : 'video/mp4';
    case 'webm': return audioOnly ? 'audio/webm' : 'video/webm';
    case 'mp3': return 'audio/mpeg';
    case 'ogg': case 'opus': return 'audio/ogg';
    case 'aac': return 'audio/aac';
    case 'flac': return 'audio/flac';
    case 'wav': return 'audio/wav';
    default: return audioOnly ? 'audio/mpeg' : 'video/mp4';
  }
}
