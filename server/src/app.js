import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { runYtdlp, buildListArgs, parseYtdlpJson } from './ytdlp.js';
import { search, suggest, radio, SOURCES } from './search.js';
import { MediaService } from './stream.js';
import { findLyrics } from './lyrics.js';
import { resolveStreamingLink, playableUrl, withDrmFallback, withBotFallback } from './streaming.js';
import { HttpError, isPublicUrl, clampInt, TtlCache } from './util.js';
import { Accounts, Sessions, LoginLimiter } from './accounts.js';
import { UserData } from './userdata.js';
import { registerSocial } from './social.js';
import { registerCovers } from './covers.js';
import { registerCatalog } from './catalog.js';
import { registerLoudness } from './loudness.js';

export const VERSION = '0.12.3';

const IMAGE_HOSTS = /(^|\.)(ytimg\.com|ggpht\.com|googleusercontent\.com|sndcdn\.com|dmcdn\.net|dailymotion\.com|bcbits\.com|vimeocdn\.com|jtvnw\.net|scdn\.co|spotifycdn\.com|dzcdn\.net|mzstatic\.com)$/i;

function requirePublicUrl(url) {
  const u = String(url || '').trim();
  if (!u) throw new HttpError('Paramètre url manquant');
  if (!isPublicUrl(u)) throw new HttpError('Adresse non autorisée : seules les URL publiques http(s) sont acceptées');
  return u;
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
 * @param {string|null} [opts.dataDir] where sessions and per-user libraries are saved (null: memory only)
 * @param {string|null} [opts.accountsFile] accounts JSON; no account = single-user local mode without login
 * @param {boolean|object} [opts.logger]
 */
export function createApp({ ytdlp = 'yt-dlp', ffmpeg = 'ffmpeg', webRoot = null, dataDir = null, accountsFile = null, logger = true } = {}) {
  const app = Fastify({ logger, trustProxy: 'loopback,uniquelocal', disableRequestLogging: true, bodyLimit: 10 * 1024 * 1024 });
  const accounts = new Accounts(accountsFile);
  const sessions = new Sessions(dataDir ? path.join(dataDir, 'sessions.json') : null);
  const limiter = new LoginLimiter();
  const userData = dataDir ? new UserData(dataDir) : null;
  const LOCAL_USER = { username: 'local', displayName: 'Moi' };
  const media = new MediaService({ ytdlp, ffmpeg, log: app.log });
  const listCache = new TtlCache({ ttlMs: 10 * 60 * 1000, max: 300 });

  app.setErrorHandler((err, request, reply) => {
    if (err.userFacing) return reply.code(err.status || 400).send({ error: err.message, code: err.code, ...(err.current ? { current: err.current } : {}) });
    if (err.validation) return reply.code(400).send({ error: err.message, code: 'BAD_REQUEST' });
    if (err.name === 'AbortError') return reply.code(499).send();
    request.log.error({ err }, 'Erreur serveur');
    return reply.code(500).send({ error: 'Erreur interne du serveur', code: 'INTERNAL' });
  });

  // ---------- Accounts ----------
  const COOKIE = 'forge_session';

  /** The signed-in user, or the implicit local user when no account is configured. */
  const userOf = (request) => {
    if (!accounts.enabled) return LOCAL_USER;
    const s = sessions.get(readCookie(request.headers.cookie, COOKIE));
    const u = s && accounts.get(s.username);
    // A password change (accounts-cli passwd) signs out every older session.
    return u && s.created >= u.since ? { username: u.username, displayName: u.displayName } : null;
  };

  const PUBLIC = new Set(['/api/health', '/api/login', '/api/logout']);
  app.addHook('onRequest', async (request, reply) => {
    const p = request.url.split('?')[0];
    if (!p.startsWith('/api/')) return;
    request.user = userOf(request);
    // /api/bot/*: HeiphaisBot, authenticated by its bearer token (social.js), not by a session.
    if (!request.user && !PUBLIC.has(p) && !p.startsWith('/api/bot/')) return reply.code(401).send({ error: 'Connexion requise', code: 'AUTH_REQUIRED' });
  });

  const cookie = (request, value, maxAge) => {
    const secure = request.protocol === 'https' ? '; Secure' : '';
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  };

  app.post('/api/login', async (request, reply) => {
    if (!accounts.enabled) return { ok: true, user: LOCAL_USER };
    const wait = limiter.blocked(request.ip);
    if (wait) throw new HttpError(`Trop de tentatives, réessayez dans ${wait} min`, 429, 'RATE_LIMITED');
    const { username, password } = request.body || {};
    const user = await accounts.authenticate(String(username || ''), String(password || ''));
    if (!user) {
      limiter.fail(request.ip);
      throw new HttpError('Identifiant ou mot de passe incorrect', 401, 'AUTH_FAILED');
    }
    limiter.reset(request.ip);
    const token = sessions.create(user.username);
    reply.header('set-cookie', cookie(request, token, 180 * 24 * 3600));
    return { ok: true, user };
  });

  app.post('/api/logout', async (request, reply) => {
    sessions.destroy(readCookie(request.headers.cookie, COOKIE));
    reply.header('set-cookie', cookie(request, '', 0));
    return { ok: true };
  });

  app.get('/api/me', async (request) => ({ user: request.user, local: !accounts.enabled, sync: !!userData }));

  // Library saved on the server (metadata only: local audio files never leave the device).
  app.get('/api/me/data', async (request) => {
    if (!userData) return { rev: 0, updatedAt: null, data: null };
    return userData.get(request.user.username);
  });

  const saveData = async (request) => {
    if (!userData) throw new HttpError('Sauvegarde serveur désactivée', 501, 'NO_STORAGE');
    const { baseRev, data } = request.body || {};
    try {
      return userData.put(request.user.username, baseRev, data);
    } catch (err) {
      if (err.code === 'CONFLICT') {
        const e = new HttpError(err.message, 409, 'CONFLICT');
        e.current = err.current;
        throw e;
      }
      throw err;
    }
  };
  app.put('/api/me/data', saveData);
  // sendBeacon (page closing) can only POST.
  app.post('/api/me/data', saveData);

  // Shared playlists, Jam, live events, link with the Discord bot.
  registerSocial(app, { accounts, userData, dataDir });
  registerCovers(app, { dataDir });
  registerCatalog(app);
  registerLoudness(app, { media, ffmpeg, ytdlp });

  // ---------- API ----------
  app.get('/api/health', async (request, reply) => {
    // Readable from the mobile apps' server setup screen (another origin); contains nothing private.
    reply.header('access-control-allow-origin', '*');
    let ytdlpVersion = null;
    try {
      ytdlpVersion = (await listCache.wrap('ytdlp-version', () => runYtdlp(ytdlp, ['--version'], { timeoutMs: 15_000 }), 10 * 60 * 1000)).trim();
    } catch {
      ytdlpVersion = null;
    }
    return { ok: true, version: VERSION, ytdlp: ytdlpVersion, authRequired: accounts.enabled, authenticated: !!request.user, user: request.user, sync: !!userData, sources: SOURCES };
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
    const url = await playableUrl(ytdlp, requirePublicUrl(request.query.url));
    const wanted = request.query.t ? { title: String(request.query.t).slice(0, 300), author: request.query.a ? String(request.query.a).slice(0, 200) : null, duration: Number(request.query.d) || null } : null;
    return withBotFallback(ytdlp, url, wanted, (u) => withDrmFallback(ytdlp, u, (v) => media.playback(v, kind, request.query.pref, request.query.q)));
  });

  app.get('/api/stream/:kind', async (request, reply) => {
    const kind = request.params.kind === 'video' ? 'video' : 'audio';
    const start = Math.max(0, Number(request.query.start) || 0);
    return media.stream(request, reply, await playableUrl(ytdlp, requirePublicUrl(request.query.url)), kind, { start, pref: request.query.pref, quality: request.query.q });
  });

  app.get('/api/download', async (request, reply) => {
    const format = ['mp3', 'audio', 'video'].includes(request.query.format) ? request.query.format : 'mp3';
    const url = await playableUrl(ytdlp, requirePublicUrl(request.query.url));
    return withDrmFallback(ytdlp, url, (u) => media.download(request, reply, u, format));
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
