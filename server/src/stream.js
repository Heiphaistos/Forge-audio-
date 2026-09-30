import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { runYtdlp, buildInfoArgs, buildPipeArgs, pickDirectFormat, mimeFor } from './ytdlp.js';
import { HttpError, TtlCache } from './util.js';

/**
 * Media resolution and delivery.
 * - Progressive (plain HTTP) formats are proxied byte-for-byte with Range support, so the browser can seek.
 * - HLS/DASH formats (Dailymotion, some live streams) are remuxed/transcoded on the fly by ffmpeg;
 *   those are not seekable by Range, the client restarts them with `?start=<seconds>` instead.
 */

/**
 * yt-dlp format selectors per stream kind and container preference.
 * `webm` (Opus / VP9) suits Chromium and Firefox builds without proprietary codecs,
 * `mp4` (AAC / H.264) suits Safari; the client says which one it can play.
 */
export const FORMATS = {
  audio: {
    webm: 'bestaudio[ext=webm]/bestaudio[acodec=opus]/bestaudio[ext=m4a]/bestaudio/best',
    mp4: 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio/best',
  },
  video: {
    webm: 'bestvideo[height<=1080][ext=webm]/bestvideo[height<=1080][ext=mp4]/bestvideo[height<=1080]/best[height<=1080]/best',
    mp4: 'bestvideo[ext=mp4][height<=1080][vcodec^=avc1]/bestvideo[ext=mp4][height<=1080]/bestvideo[height<=1080]/best[height<=1080]/best',
  },
};

export const PREFS = ['webm', 'mp4'];

/**
 * Stream quality (« Qualité du flux », data saver): caps the audio bitrate. `high` = best available
 * (Opus ~160 kbit/s on YouTube), `normal` ≈ 128 kbit/s, `low` ≈ 50-70 kbit/s (mobile data).
 */
export const QUALITIES = ['high', 'normal', 'low'];
const ABR = { normal: 130, low: 72 };
function capAudio(selector, q) {
  const max = ABR[q];
  if (!max) return selector;
  const capped = selector.split('/').filter((s) => s.startsWith('bestaudio')).map((s) => `${s}[abr<=${max}]`);
  return [...capped, 'worstaudio[abr>=40]', selector].join('/');
}

// Re-encoding to MP3 overshoots full scale on loud masters (+0.8 dB measured on Dailymotion), which crackles:
// a -1 dBFS limiter keeps the peaks in range.
const MP3_LIMIT = ['-af', 'alimiter=limit=0.891:level=disabled'];

function formatFor(kind, pref, quality = 'high') {
  const f = FORMATS[kind];
  if (!f) throw new HttpError(`Type de flux inconnu : ${kind}`);
  const base = f[PREFS.includes(pref) ? pref : 'webm'];
  return kind === 'audio' && QUALITIES.includes(quality) ? capAudio(base, quality) : base;
}

/**
 * googlevideo refuses (403) any range over ~1 MiB since 2026-09-30 (checked: 0-1 MiB and 2-2.5 MB pass, 0-2 MB
 * does not): every upstream request is at most one chunk, the player asks for the next ones as it plays.
 */
const CHUNK = 1024 * 1024;
const RESOLVE_TTL = 2 * 60 * 60 * 1000;

function headerString(headers = {}) {
  return Object.entries(headers)
    .filter(([k]) => !/^(accept-encoding|range)$/i.test(k))
    .map(([k, v]) => `${k}: ${v}\r\n`).join('');
}

/** Turn an incoming Range header into the one sent upstream (open-ended ranges get bounded). */
export function upstreamRange(range) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(String(range || 'bytes=0-').trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : start + CHUNK - 1;
  return `bytes=${start}-${Math.min(end, start + CHUNK - 1)}`;
}

export class MediaService {
  constructor({ ytdlp, ffmpeg, log }) {
    this.ytdlp = ytdlp;
    this.ffmpeg = ffmpeg;
    this.log = log;
    this.cache = new TtlCache({ ttlMs: RESOLVE_TTL, max: 400 });
  }

  /** Resolve (and cache) the direct media for a page URL. */
  resolve(url, kind = 'audio', pref = 'webm', quality = 'high') {
    const format = formatFor(kind, pref, quality);
    return this.cache.wrap(`${kind}|${format}|${url}`, async () => {
      const raw = await runYtdlp(this.ytdlp, buildInfoArgs(url, format), { timeoutMs: 60_000 });
      let info;
      try { info = JSON.parse(raw); } catch { throw new HttpError('Réponse de yt-dlp illisible', 502, 'YTDLP_ERROR'); }
      const direct = pickDirectFormat(info);
      const isLive = info.is_live === true || info.live_status === 'is_live';
      return {
        kind,
        format,
        pageUrl: url,
        direct,
        isLive,
        seekable: !!direct?.progressive && !isLive,
        duration: Number(info.duration) > 0 ? Number(info.duration) : null,
        title: info.track || info.title || null,
        artist: info.artist || info.uploader || info.channel || null,
      };
    });
  }

  invalidate(url, kind, pref, quality) {
    this.cache.delete(`${kind}|${formatFor(kind, pref, quality)}|${url}`);
  }

  /** Describe how the client should play a URL. */
  async playback(url, kind, pref, quality) {
    const media = await this.resolve(url, kind, pref, quality);
    const qs = new URLSearchParams({ url });
    if (pref && pref !== 'webm') qs.set('pref', pref);
    if (kind === 'audio' && QUALITIES.includes(quality) && quality !== 'high') qs.set('q', quality);
    return {
      src: `/api/stream/${kind}?${qs}`,
      seekable: media.seekable,
      duration: media.duration,
      isLive: media.isLive,
      mime: media.seekable ? media.direct.mime : (kind === 'video' ? 'video/mp4' : 'audio/mpeg'),
    };
  }

  /** Fastify handler body for /api/stream/:kind. */
  async stream(request, reply, url, kind, { start = 0, pref = 'webm', quality = 'high' } = {}) {
    let media = await this.resolve(url, kind, pref, quality);
    if (media.seekable) {
      let res = await this.fetchUpstream(request, reply, media);
      if (res.status === 403 || res.status === 410) {
        // Signed URLs expire or get bound to another client: resolve again once.
        res.body?.cancel().catch(() => {});
        this.invalidate(url, kind, pref, quality);
        media = await this.resolve(url, kind, pref, quality);
        res = await this.fetchUpstream(request, reply, media);
      }
      if (!res.ok) {
        res.body?.cancel().catch(() => {});
        throw new HttpError(`La source a refusé la lecture (${res.status})`, 502, 'UPSTREAM_ERROR');
      }
      reply.code(res.status);
      const type = res.headers.get('content-type');
      reply.header('content-type', type && !/octet-stream|text\/plain/.test(type) ? type : media.direct.mime);
      for (const h of ['content-length', 'content-range']) if (res.headers.get(h)) reply.header(h, res.headers.get(h));
      reply.header('accept-ranges', 'bytes');
      reply.header('cache-control', 'no-store');
      return reply.send(Readable.fromWeb(res.body));
    }
    const proc = this.transcode(media, { start, video: kind === 'video' });
    reply.raw.on('close', () => proc.kill());
    reply.header('content-type', kind === 'video' ? 'video/mp4' : 'audio/mpeg');
    reply.header('cache-control', 'no-store');
    return reply.send(proc.stdout);
  }

  async fetchUpstream(request, reply, media) {
    const controller = new AbortController();
    // The response's 'close' (not the request's) tells us the client went away.
    reply.raw.on('close', () => controller.abort());
    const headers = { ...media.direct.headers };
    delete headers['Accept-Encoding'];
    const range = upstreamRange(request.headers.range);
    if (range) headers.Range = range;
    return fetch(media.direct.url, { headers, signal: controller.signal, redirect: 'follow' });
  }

  /** ffmpeg input arguments reading a resolved media (direct URL or yt-dlp pipe). */
  inputArgs(media, start = 0) {
    const args = [];
    const seek = start > 0 && !media.isLive ? ['-ss', String(start)] : [];
    // googlevideo refuses ffmpeg's single open-ended request (> 1 MiB, see CHUNK): yt-dlp downloads it in small parts.
    const googlevideo = /(^|\.)googlevideo\.com$/.test(new URL(media.direct?.url || 'http://x').hostname);
    if (media.direct && !googlevideo && (media.direct.progressive || media.direct.protocol.startsWith('m3u8'))) {
      const hdr = headerString(media.direct.headers);
      if (hdr) args.push('-headers', hdr);
      args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', ...seek, '-i', media.direct.url);
      return { args, pipe: null };
    }
    return { args: ['-i', 'pipe:0', ...seek], pipe: buildPipeArgs(media.pageUrl, media.format, this.ffmpeg) };
  }

  /** Spawn ffmpeg (optionally fed by yt-dlp) and return a handle with stdout and kill(). */
  spawnFfmpeg(inputs, outputArgs) {
    const procs = [];
    const ffArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    let feeder = null;
    for (const input of inputs) {
      ffArgs.push(...input.args);
      if (input.pipe) feeder = input.pipe;
    }
    ffArgs.push(...outputArgs, 'pipe:1');
    const ff = spawn(this.ffmpeg, ffArgs, { stdio: [feeder ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
    procs.push(ff);
    ff.on('error', (err) => this.log?.error({ err: err.message }, 'ffmpeg introuvable ou en erreur'));
    ff.stderr.on('data', (d) => this.log?.debug({ ffmpeg: d.toString().trim() }));
    if (feeder) {
      const yt = spawn(this.ytdlp, feeder, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      procs.push(yt);
      yt.on('error', (err) => this.log?.error({ err: err.message }, 'yt-dlp en erreur'));
      yt.stdout.pipe(ff.stdin).on('error', () => {});
    }
    return {
      stdout: ff.stdout,
      kill: () => procs.forEach((p) => { try { p.kill('SIGKILL'); } catch { /* gone */ } }),
    };
  }

  transcode(media, { start = 0, video = false } = {}) {
    const out = video
      ? ['-an', '-c:v', 'copy', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof']
      : ['-vn', ...MP3_LIMIT, '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3'];
    return this.spawnFfmpeg([this.inputArgs(media, start)], out);
  }

  /**
   * Download as a file: mp3 (transcoded, tagged), m4a/opus original audio, or mp4 video with sound.
   */
  async download(request, reply, url, format) {
    const audio = await this.resolve(url, 'audio', format === 'video' ? 'mp4' : 'webm');
    // YouTube titles often already start with the artist ("Daft Punk - Instant Crush"): don't repeat it.
    const titleHasArtist = audio.artist && audio.title?.toLowerCase().startsWith(audio.artist.toLowerCase());
    const base = safeFilename([titleHasArtist ? '' : audio.artist, audio.title].filter(Boolean).join(' - ') || 'forge-audio');
    const meta = ['-metadata', `title=${audio.title || ''}`, '-metadata', `artist=${audio.artist || ''}`];
    let proc;
    let filename;
    let type;
    if (format === 'mp3') {
      proc = this.spawnFfmpeg([this.inputArgs(audio)], ['-vn', ...meta, ...MP3_LIMIT, '-c:a', 'libmp3lame', '-b:a', '320k', '-id3v2_version', '3', '-f', 'mp3']);
      filename = `${base}.mp3`;
      type = 'audio/mpeg';
    } else if (format === 'audio') {
      const ext = audio.direct?.ext === 'webm' ? 'opus' : 'm4a';
      proc = this.spawnFfmpeg([this.inputArgs(audio)], ['-vn', ...meta, '-c:a', 'copy', '-f', ext === 'opus' ? 'ogg' : 'ipod', ...(ext === 'm4a' ? ['-movflags', 'frag_keyframe+empty_moov'] : [])]);
      filename = `${base}.${ext}`;
      type = mimeFor(ext);
    } else if (format === 'video') {
      const video = await this.resolve(url, 'video', 'mp4');
      const inputs = [this.inputArgs(video)];
      const audioIn = this.inputArgs(audio);
      // Only one input can come from a pipe: if both need yt-dlp, fall back to the video stream alone.
      const twoInputs = !(inputs[0].pipe && audioIn.pipe);
      if (twoInputs) inputs.push(audioIn);
      const map = twoInputs ? ['-map', '0:v:0', '-map', '1:a:0'] : [];
      proc = this.spawnFfmpeg(inputs, [...map, ...meta, '-c', 'copy', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov']);
      filename = `${base}.mp4`;
      type = 'video/mp4';
    } else {
      throw new HttpError('Format de téléchargement inconnu (mp3, audio ou video)');
    }
    reply.raw.on('close', () => proc.kill());
    reply.header('content-type', type);
    reply.header('content-disposition', `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    return reply.send(proc.stdout);
  }
}

export function safeFilename(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'forge-audio';
}
