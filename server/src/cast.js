import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, isPublicUrl } from './util.js';
import { LoginLimiter } from './accounts.js';

/**
 * Signed stream links for a cast device (Chromecast, AirPlay speaker): it fetches the audio itself,
 * without the session cookie. A link is good for ONE track and expires: HMAC-SHA256 of
 * `audio|<url>|<expiry>` with a server secret (FORGE_CAST_SECRET, or a random key kept in
 * data/cast-secret). It reveals nothing of the session; once expired it is refused.
 */

export const CAST_TTL_MS = 3 * 3600 * 1000;
export const CAST_PATH = '/api/cast/stream';

export function castSecret(dataDir, env = process.env.FORGE_CAST_SECRET) {
  if (env && env.length >= 32) return env;
  if (!dataDir) return crypto.randomBytes(32).toString('hex');
  const file = path.join(dataDir, 'cast-secret');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch { /* first start: created below */ }
  const s = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

const mac = (secret, url, exp) => crypto.createHmac('sha256', secret).update(`audio|${url}|${exp}`).digest('base64url');

export function signCast(secret, url, now = Date.now()) {
  const exp = Math.floor((now + CAST_TTL_MS) / 1000);
  return { url, exp, sig: mac(secret, url, exp) };
}

/** True when `sig` is the server's signature of this url and the link has not expired. */
export function verifyCast(secret, { url, exp, sig }, now = Date.now()) {
  const e = Number(exp);
  if (!url || !Number.isInteger(e) || e * 1000 <= now || typeof sig !== 'string') return false;
  const want = Buffer.from(mac(secret, String(url), e));
  const got = Buffer.from(sig);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** `stream(request, reply, url)` plays an already checked public url (app.js: /api/stream/audio). */
export function registerCast(app, { dataDir, stream }) {
  const secret = castSecret(dataDir);
  const links = new LoginLimiter({ max: 120, windowMs: 3600_000 });
  const fetches = new LoginLimiter({ max: 600, windowMs: 3600_000 });

  app.post('/api/cast/link', async (request) => {
    const url = String(request.body?.url || '').trim();
    if (!isPublicUrl(url)) throw new HttpError('Titre non diffusable', 400, 'BAD_URL');
    const wait = links.blocked(request.user.username);
    if (wait) throw new HttpError(`Trop de diffusions, réessayez dans ${wait} min`, 429, 'RATE_LIMITED');
    links.fail(request.user.username);
    const s = signCast(secret, url);
    const qs = new URLSearchParams({ url: s.url, exp: String(s.exp), sig: s.sig });
    return { src: `${request.protocol}://${request.host}${CAST_PATH}?${qs}`, expiresAt: s.exp * 1000 };
  });

  // No session here (the cast device has none): the signature is the authorization.
  app.get(CAST_PATH, async (request, reply) => {
    const wait = fetches.blocked(request.ip);
    if (wait) throw new HttpError('Trop de requêtes', 429, 'RATE_LIMITED');
    fetches.fail(request.ip);
    if (!verifyCast(secret, request.query)) throw new HttpError('Lien de diffusion invalide ou expiré', 403, 'BAD_SIGNATURE');
    return stream(request, reply, String(request.query.url));
  });
}
