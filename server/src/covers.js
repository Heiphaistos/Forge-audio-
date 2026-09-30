import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './util.js';

/**
 * Playlist covers uploaded by users (« Changer l'image »): JPEG, PNG or WebP up to 2 MB, recognised
 * by their first bytes (the declared type is not trusted). Stored in <data>/covers/<user>/, served to
 * signed-in users only (shared playlists show them to every member).
 */
const MAX = 2 * 1024 * 1024;
const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

export function registerCovers(app, { dataDir }) {
  if (!dataDir) return;
  const root = path.join(dataDir, 'covers');
  app.addContentTypeParser(['image/jpeg', 'image/png', 'image/webp'], { parseAs: 'buffer', bodyLimit: MAX }, (req, body, done) => done(null, body));

  app.post('/api/me/covers', async (request) => {
    const buf = request.body;
    if (!Buffer.isBuffer(buf) || !buf.length) throw new HttpError('Envoyez une image JPEG, PNG ou WebP', 400);
    const ext = sniff(buf);
    if (!ext) throw new HttpError('Format d\'image non reconnu (JPEG, PNG ou WebP)', 415);
    const dir = path.join(root, request.user.username);
    fs.mkdirSync(dir, { recursive: true });
    // ponytail: no cleanup of replaced covers; each is ≤ 2 MB and users are few.
    const name = `${crypto.randomBytes(12).toString('base64url')}.${ext}`;
    fs.writeFileSync(path.join(dir, name), buf, { mode: 0o600 });
    return { url: `/api/covers/${request.user.username}/${name}` };
  });

  app.get('/api/covers/:user/:file', async (request, reply) => {
    const { user, file } = request.params;
    const m = String(file).match(/^[A-Za-z0-9_-]{8,40}\.(jpg|png|webp)$/);
    if (!m || !/^[a-z0-9][a-z0-9._-]{1,31}$/.test(user)) throw new HttpError('Image introuvable', 404);
    const full = path.join(root, user, file);
    if (!fs.existsSync(full)) throw new HttpError('Image introuvable', 404);
    reply.header('content-type', TYPES[m[1]]).header('cache-control', 'private, max-age=31536000, immutable').header('x-content-type-options', 'nosniff');
    return reply.send(fs.createReadStream(full));
  });
}
