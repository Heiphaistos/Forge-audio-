import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { runYtdlp, buildListArgs, parseYtdlpJson } from './ytdlp.js';
import { search, suggest, radio, SOURCES } from './search.js';
import { MediaService } from './stream.js';
import { findLyrics } from './lyrics.js';
import { resolveStreamingLink, playableUrl } from './streaming.js';
import { HttpError, isPublicUrl, clampInt, TtlCache } from './util.js';

export const VERSION = '0.2.0';

const IMAGE_HOSTS = /(^|\.)(ytimg\.com|ggpht\.com|googleusercontent\.com|sndcdn\.com|dmcdn\.net|dailymotion\.com|bcbits\.com|vimeocdn\.com|jtvnw\.net|scdn\.co|spotifycdn\.com|dzcdn\.net|mzstatic\.com)$/i;

function requirePublicUrl(url) {
  const u = String(url || '').trim();
  if (!u) throw new HttpError('Paramètre url manquant');
  if (!isPublicUrl(u)) throw new HttpError('Adresse non autorisée : seules les URL publiques http(s) sont acceptées');
  return u;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/**
 * Build the Forge Audio HTTP server.
 * @param {object} opts
 * @param {string} [opts.ytdlp] yt-dlp binary
 * @param {string} [opts.ffmpeg] ffmpeg binary
 * @param {string|null} [opts.webRoot] folder of the built web app (served with SPA fallback)
 * @param {string|null} [opts.accessToken] when set, the API requires this password
 * @param {boolean|object} [opts.logger]
 */
export function createApp({ ytdlp = 'yt-dlp', ffmpeg = 'ffmpeg', webRoot = null, accessToken = null, logger = true } = {}) {
  const app = Fastify({ logger, trustProxy: true, disableRequestLogging: true });
  const media = new MediaService({ ytdlp, ffmpeg, log: app.log });
  const listCache = new TtlCache({ ttlMs: 10 * 60 * 1000, max: 300 });

  app.setErrorHandler((err, request, reply) => {
    if (err.userFacing) return reply.code(err.status || 400).send({ error: err.message, code: err.code });
    if (err.validation) return reply.code(400).send({ error: err.message, code: 'BAD_REQUEST' });
    if (err.name === 'AbortError') return reply.code(499).send();
    request.log.error({ err }, 'Erreur serveur');
    return reply.code(500).send({ error: 'Erreur interne du serveur', code: 'INTERNAL' });
  });

  // ---------- Optional password protection ----------
  const authed = (request) => {
    if (!accessToken) return true;
    const given = request.headers['x-forge-token'] || readCookie(request.headers.cookie, 'forge_token');
    return !!given && safeEqual(given, accessToken);
  };

  app.addHook('onRequest', async (request, reply) => {
    const p = request.url.split('?')[0];
    if (!p.startsWith('/api/') || p === '/api/health' || p === '/api/login') return;
    if (!authed(request)) return reply.code(401).send({ error: 'Mot de passe requis', code: 'AUTH_REQUIRED' });
  });

  app.post('/api/login', async (request, reply) => {
    if (!accessToken) return { ok: true };
    const token = request.body?.token;
    if (!token || !safeEqual(token, accessToken)) throw new HttpError('Mot de passe incorrect', 401, 'AUTH_FAILED');
    const secure = request.protocol === 'https' ? '; Secure' : '';
    reply.header('set-cookie', `forge_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`);
    return { ok: true };
  });

  // ---------- API ----------
  app.get('/api/health', async (request) => {
    let ytdlpVersion = null;
    try {
      ytdlpVersion = (await listCache.wrap('ytdlp-version', () => runYtdlp(ytdlp, ['--version'], { timeoutMs: 15_000 }), 10 * 60 * 1000)).trim();
    } catch {
      ytdlpVersion = null;
    }
    return { ok: true, version: VERSION, ytdlp: ytdlpVersion, authRequired: !!accessToken, authenticated: authed(request), sources: SOURCES };
  });

  app.get('/api/search', async (request) => {
    const { q, source = 'all' } = request.query;
    const limit = clampInt(request.query.limit, 1, 50, 20);
    const key = `s|${source}|${limit}|${String(q || '').trim().toLowerCase()}`;
    return listCache.wrap(key, () => search(ytdlp, q, { source, limit }));
  });

  app.get('/api/suggest', async (request) => ({ suggestions: await suggest(request.query.q) }));

  app.get('/api/resolve', async (request) => {
    const url = requirePublicUrl(request.query.url);
    const limit = clampInt(request.query.limit, 1, 500, 200);
    return listCache.wrap(`r|${limit}|${url}`, async () => {
      const streaming = await resolveStreamingLink(url, { maxEntries: limit });
      if (streaming) return streaming;
      const raw = await runYtdlp(ytdlp, buildListArgs(url, { maxEntries: limit }), { timeoutMs: 120_000 });
      const res = parseYtdlpJson(raw, { maxEntries: limit });
      if (!res.tracks.length) throw new HttpError('Aucune piste lisible à cette adresse', 404, 'NOT_FOUND');
      return res;
    });
  });

  app.get('/api/radio', async (request) => {
    const { url, title = '', author = '', source = 'youtube' } = request.query;
    const track = { url: await playableUrl(ytdlp, requirePublicUrl(url)), title: String(title), author: String(author), source: String(source) };
    const limit = clampInt(request.query.limit, 1, 50, 25);
    return listCache.wrap(`radio|${limit}|${track.url}`, async () => ({ tracks: await radio(ytdlp, track, { limit }) }));
  });

  app.get('/api/playback', async (request) => {
    const kind = request.query.kind === 'video' ? 'video' : 'audio';
    return media.playback(await playableUrl(ytdlp, requirePublicUrl(request.query.url)), kind, request.query.pref);
  });

  app.get('/api/stream/:kind', async (request, reply) => {
    const kind = request.params.kind === 'video' ? 'video' : 'audio';
    const start = Math.max(0, Number(request.query.start) || 0);
    return media.stream(request, reply, await playableUrl(ytdlp, requirePublicUrl(request.query.url)), kind, { start, pref: request.query.pref });
  });

  app.get('/api/download', async (request, reply) => {
    const format = ['mp3', 'audio', 'video'].includes(request.query.format) ? request.query.format : 'mp3';
    return media.download(request, reply, await playableUrl(ytdlp, requirePublicUrl(request.query.url)), format);
  });

  app.get('/api/lyrics', async (request) => {
    const { title, author } = request.query;
    const duration = Number(request.query.duration) || null;
    return findLyrics({ title, author, duration });
  });

  // Same-origin image proxy so the UI can read cover colors from a <canvas>.
  app.get('/api/image', async (request, reply) => {
    const url = requirePublicUrl(request.query.url);
    if (!IMAGE_HOSTS.test(new URL(url).hostname)) throw new HttpError('Hôte d\'image non autorisé', 403, 'FORBIDDEN');
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.startsWith('image/')) throw new HttpError('Image indisponible', 502, 'UPSTREAM_ERROR');
    reply.header('content-type', type);
    reply.header('cache-control', 'public, max-age=86400');
    return reply.send(Readable.fromWeb(res.body));
  });

  app.all('/api/*', async () => { throw new HttpError('Route inconnue', 404, 'NOT_FOUND'); });

  // ---------- Web app ----------
  if (webRoot && fs.existsSync(path.join(webRoot, 'index.html'))) {
    app.register(fastifyStatic, { root: webRoot, wildcard: false, index: ['index.html'] });
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== 'GET' || request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Introuvable' });
      const file = request.url.split('?')[0];
      if (/\.[a-z0-9]+$/i.test(file)) return reply.code(404).send('Introuvable');
      return reply.type('text/html').sendFile('index.html');
    });
  } else {
    app.get('/', async () => ({ name: 'Forge Audio API', version: VERSION, web: 'non compilée : lancez `npm run build`' }));
  }

  return app;
}
