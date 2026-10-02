import crypto from 'node:crypto';
import path from 'node:path';
import { LoginLimiter } from './accounts.js';
import { safeFilename } from './stream.js';
import { playableUrl, withDrmFallback } from './streaming.js';
import { HttpError, isPublicUrl } from './util.js';
import { ZipWriter, ZIP32_LIMIT } from './zip.js';

/**
 * Whole-playlist download as ONE zip, streamed track by track (zip.js): POST /api/download/batch registers
 * the list and answers an id, GET /api/download/batch/:id streams the archive, so a plain link works
 * (browser, Electron, Android WebView). Audio only: 200 videos would blow the 4 GiB ZIP32 limit.
 */
export const MAX_TRACKS = 200;
const TTL = 10 * 60 * 1000;
const FORMATS = ['mp3', 'audio'];

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

/** « Daft Punk - Instant Crush » without repeating the artist, made safe for Windows (trailing dots/spaces). */
export function entryName(index, width, track, ext) {
  const author = track.author.replace(/\s*-\s*Topic$/i, '');
  const [t, a] = [track.title.toLowerCase(), author.toLowerCase()];
  const label = a && t !== a && !t.startsWith(`${a} `) ? `${author} - ${track.title}` : track.title;
  const base = safeFilename(`${String(index + 1).padStart(width, '0')} - ${label}`).slice(0, 120).replace(/[. ]+$/, '');
  return `${base}${ext}`;
}

function parseBatch(body) {
  const { name, format, tracks } = body || {};
  if (!FORMATS.includes(format)) throw new HttpError('Format invalide : mp3 ou audio (la vidéo n\'est pas proposée en lot)');
  if (!Array.isArray(tracks) || !tracks.length) throw new HttpError('Aucun titre à télécharger');
  if (tracks.length > MAX_TRACKS) throw new HttpError(`${MAX_TRACKS} titres maximum par archive`, 400, 'TOO_MANY');
  return {
    name: clean(name, 100) || 'Forge Audio',
    format,
    tracks: tracks.map((t) => {
      const url = String(t?.url || '').trim();
      if (!isPublicUrl(url)) throw new HttpError('Adresse non autorisée : seules les URL publiques http(s) sont acceptées');
      return { url, title: clean(t.title, 200) || 'Sans titre', author: clean(t.author, 100) };
    }),
  };
}

export function registerBatchDownload(app, { media, ytdlp, zipLimit = ZIP32_LIMIT }) {
  const jobs = new Map(); // id -> { username, expires, name, format, tracks }
  const running = new Set(); // usernames with a zip being streamed
  const limiter = new LoginLimiter({ max: 20, windowMs: 60 * 60 * 1000 });

  app.post('/api/download/batch', async (request) => {
    const username = request.user.username;
    const wait = limiter.blocked(username);
    if (wait) throw new HttpError(`Trop de téléchargements, réessayez dans ${wait} min`, 429, 'RATE_LIMITED');
    if (running.has(username)) throw new HttpError('Un téléchargement de playlist est déjà en cours', 409, 'BUSY');
    const job = parseBatch(request.body);
    limiter.fail(username);
    const now = Date.now();
    for (const [id, j] of jobs) if (j.username === username || j.expires < now) jobs.delete(id); // one pending job per account
    const id = crypto.randomBytes(18).toString('base64url');
    jobs.set(id, { ...job, username, expires: now + TTL });
    return { id, count: job.tracks.length };
  });

  app.get('/api/download/batch/:id', async (request, reply) => {
    const job = jobs.get(request.params.id);
    // Unknown, expired and someone else's id look the same.
    if (!job || job.expires < Date.now() || job.username !== request.user.username) throw new HttpError('Lien de téléchargement expiré ou inconnu', 404, 'NOT_FOUND');
    if (running.has(job.username)) throw new HttpError('Un téléchargement de playlist est déjà en cours', 409, 'BUSY');
    jobs.delete(request.params.id); // single use
    running.add(job.username);

    const abort = new AbortController();
    const zip = new ZipWriter({ limit: zipLimit, signal: abort.signal });
    zip.stream.on('error', () => {}); // destroyed when the client leaves
    let current = null;
    reply.raw.on('close', () => { abort.abort(); current?.kill(); });
    const filename = `${safeFilename(job.name)}.zip`;
    reply.header('content-type', 'application/zip');
    reply.header('content-disposition', `attachment; filename="${filename.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    reply.header('cache-control', 'no-store');

    (async () => {
      const failed = [];
      const width = Math.max(2, String(job.tracks.length).length);
      for (const [i, t] of job.tracks.entries()) {
        if (abort.signal.aborted) return;
        const label = `${t.author ? `${t.author} - ` : ''}${t.title}`;
        if (zip.full) { failed.push(`${label} (archive pleine : 4 Gio maximum)`); continue; }
        try {
          const url = await playableUrl(ytdlp, t.url);
          const dl = await withDrmFallback(ytdlp, url, (u) => media.openDownload(u, job.format));
          current = dl.proc;
          if (abort.signal.aborted) { dl.proc.kill(); return; }
          const res = await zip.add(entryName(i, width, t, path.extname(dl.filename)), dl.proc.stdout);
          if (res.truncated) dl.proc.kill();
          const code = await dl.proc.exited;
          current = null;
          if (!res.size) failed.push(`${label} (aucune donnée reçue)`);
          else if (res.truncated) failed.push(`${label} (coupé : archive pleine, 4 Gio maximum)`);
          else if (code !== 0) failed.push(`${label} (incomplet)`);
        } catch (err) {
          if (abort.signal.aborted) return;
          failed.push(`${label} (${err.userFacing ? err.message : 'erreur'})`);
        }
      }
      if (failed.length) {
        const text = `Titres non téléchargés ou incomplets (${failed.length}/${job.tracks.length}) :\r\n\r\n${failed.join('\r\n')}\r\n`;
        await zip.add('titres-non-telecharges.txt', [Buffer.from(text, 'utf8')], { capped: false });
      }
      await zip.finish();
    })().catch((err) => {
      if (!abort.signal.aborted) request.log.error({ err }, 'Archive de playlist interrompue');
      current?.kill();
      zip.stream.destroy(err);
    }).finally(() => {
      running.delete(job.username);
      if (abort.signal.aborted) zip.stream.destroy();
    });

    return reply.send(zip.stream);
  });
}
