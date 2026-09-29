import net from 'node:net';

/** Error whose message can be shown to the user as-is. */
export class HttpError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') {
    super(message);
    this.status = status;
    this.code = code;
    this.userFacing = true;
  }
}

export function isHttpUrl(str) {
  try {
    const u = new URL(String(str).trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const PRIVATE_V4 = [
  [0x0a000000, 8], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12], [0xc0a80000, 16], [0x00000000, 8], [0x64400000, 10],
];

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, p) => (acc << 8) + Number(p), 0) >>> 0;
}

/**
 * Reject URLs that point at the local machine or a private network (basic SSRF guard):
 * the server resolves user-supplied URLs through yt-dlp, which would happily fetch them.
 */
export function isPublicUrl(str) {
  if (!isHttpUrl(str)) return false;
  const host = new URL(String(str).trim()).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (net.isIPv4(host)) {
    const n = ipv4ToInt(host);
    return !PRIVATE_V4.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
  }
  if (net.isIPv6(host)) {
    return !(host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80') || host.startsWith('::ffff:'));
  }
  return true;
}

/** Small in-memory cache with per-entry TTL and a size cap (oldest evicted first). */
export class TtlCache {
  constructor({ ttlMs = 60_000, max = 500 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.map = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return value;
  }

  delete(key) {
    this.map.delete(key);
  }

  /** Memoize an async producer; concurrent calls for the same key share one promise. */
  async wrap(key, producer, ttlMs = this.ttlMs) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const promise = producer();
    this.set(key, promise, ttlMs);
    try {
      return await promise;
    } catch (err) {
      this.delete(key);
      throw err;
    }
  }
}

export function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
