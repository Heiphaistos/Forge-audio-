import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

/**
 * Station logos, found by the server and kept on disk (found: 30 days, nothing found: 7 days).
 *  1. the directory's favicon (or the logo of the hand-picked list);
 *  2. if it fails or is tiny, the station's home page: <link rel="apple-touch-icon">, icon, shortcut icon,
 *     og:image, the web manifest's icons, then /favicon.ico;
 *  3. the largest reasonable square picture wins.
 * Every request goes through radio.js `open` (public URL, every DNS answer public, redirects re-checked).
 * Pictures are typed by their first bytes: PNG, JPEG, WebP, GIF, ICO (turned into PNG when simple). Never SVG.
 */

const IMAGE_MAX = 300 * 1024;
const PAGE_MAX = 512 * 1024; // home page read up to this, the rest ignored
const MANIFEST_MAX = 64 * 1024;
const OK_TTL = 30 * 24 * 3600 * 1000;
const FAIL_TTL = 7 * 24 * 3600 * 1000;
const FETCHES = 6; // pictures tried on a home page
const GOOD = 128; // a square picture this big ends the search
const BUDGET_MS = 20_000; // whole search for one station
const PARALLEL = 8; // stations searched at the same time

/** Image type from its first bytes; null for anything else (SVG included: it could run script on this origin). */
export function imageType(buf) {
  const head = buf.subarray(0, 12).toString('latin1');
  if (head.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (head.startsWith('\xff\xd8\xff')) return 'image/jpeg';
  if (head.startsWith('GIF8')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  if (head.startsWith('\x00\x00\x01\x00')) return 'image/x-icon';
  return null;
}

/** Width and height read from the picture's header, null when unreadable. */
export function imageSize(buf, type = imageType(buf)) {
  try {
    if (type === 'image/png') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (type === 'image/gif') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (type === 'image/webp') {
      const chunk = buf.toString('latin1', 12, 16);
      if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return { w: 1 + (b & 0x3fff), h: 1 + ((b >>> 14) & 0x3fff) }; }
      if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
    if (type === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length && buf[i] === 0xff) {
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        i += m === 0xff ? 1 : (m >= 0xd0 && m <= 0xd9) || m === 0x01 ? 2 : 2 + buf.readUInt16BE(i + 2);
      }
    }
    if (type === 'image/x-icon') {
      let w = 0;
      for (let k = 0; k < buf.readUInt16LE(4) && 22 + 16 * k <= buf.length; k++) w = Math.max(w, buf[6 + 16 * k] || 256);
      return w ? { w, h: w } : null;
    }
  } catch { /* truncated header */ }
  return null;
}

// ---------- ICO -> PNG ----------
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(zlib.crc32(body), body.length + 4);
  return out;
}

/** 24/32-bit uncompressed bitmap of an .ico entry -> RGBA PNG; null for anything else (palettes…). */
function bmpToPng(d) {
  if (d.length < 40) return null;
  const hs = d.readUInt32LE(0), w = d.readInt32LE(4), h = d.readInt32LE(8) / 2, bpp = d.readUInt16LE(14);
  if (hs < 40 || d.readUInt32LE(16) !== 0 || (bpp !== 32 && bpp !== 24) || !Number.isInteger(h) || w < 1 || h < 1 || w > 256 || h > 256) return null;
  const stride = ((w * bpp + 31) >> 5) * 4;
  const maskStride = ((w + 31) >> 5) * 4;
  const maskAt = hs + stride * h;
  if (maskAt > d.length) return null;
  const hasMask = maskAt + maskStride * h <= d.length;
  const row = w * 4 + 1;
  const raw = Buffer.alloc(row * h);
  let alpha = false;
  for (let y = 0; y < h; y++) {
    const src = hs + stride * (h - 1 - y); // bottom-up rows
    for (let x = 0; x < w; x++) {
      const p = src + x * (bpp / 8), o = row * y + 1 + x * 4;
      raw[o] = d[p + 2]; raw[o + 1] = d[p + 1]; raw[o + 2] = d[p];
      raw[o + 3] = bpp === 32 ? d[p + 3] : 255;
      if (bpp === 32 && d[p + 3]) alpha = true;
    }
  }
  if (!alpha) {
    // No alpha channel in use: transparency comes from the AND mask (1 = transparent).
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const bit = hasMask ? d[maskAt + maskStride * (h - 1 - y) + (x >> 3)] & (0x80 >> (x & 7)) : 0;
        raw[row * y + 1 + x * 4 + 3] = bit ? 0 : 255;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bits, RGBA
  return Buffer.concat([PNG_SIG, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

/** Largest picture of an .ico as PNG (PNG entries as they are, 24/32-bit bitmaps converted); null if none is simple. */
export function icoToPng(buf) {
  if (buf.length < 6) return null;
  const entries = [];
  for (let k = 0; k < buf.readUInt16LE(4) && 22 + 16 * k <= buf.length; k++) {
    const e = 6 + 16 * k;
    const size = buf.readUInt32LE(e + 8), off = buf.readUInt32LE(e + 12);
    if (size >= 8 && off + size <= buf.length) entries.push({ w: buf[e] || 256, data: buf.subarray(off, off + size) });
  }
  for (const { data } of entries.sort((a, b) => b.w - a.w)) {
    const png = imageType(data) === 'image/png' ? Buffer.from(data) : bmpToPng(data);
    if (png) return png;
  }
  return null;
}

/** A downloaded picture ready to serve: { buf, type, w, h }, or null when it is not one we accept. */
export function toLogo(buf) {
  let type = imageType(buf);
  if (type === 'image/x-icon') {
    const png = icoToPng(buf);
    if (png) [buf, type] = [png, 'image/png'];
  }
  if (!type) return null;
  const size = imageSize(buf, type) || { w: 48, h: 48 };
  if (!size.w || !size.h) return null;
  return { buf, type, ...size };
}

/** Square-ish (at most 5:4) and at least 32 px beats any other shape; then the larger, up to 512 px. */
export function logoScore({ w, h }) {
  const side = Math.min(w, h, 512);
  return Math.max(w, h) / Math.min(w, h) <= 1.25 && side >= 32 ? 10_000 + side : side;
}
const isGood = (l) => l && logoScore(l) >= 10_000 + GOOD;

// ---------- home page ----------
const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'));
  return m ? (m[1] ?? m[2] ?? m[3]).replace(/&amp;/gi, '&').trim() : null;
};
const declared = (sizes) => Math.max(0, ...String(sizes || '').toLowerCase().split(/\s+/).map((s) => Number(s.split('x')[0]) || 0));
const isSvg = (href, type) => /svg/i.test(type || '') || /\.svgz?([?#]|$)/i.test(href);

/** Pictures a home page declares, plus its manifest's address. Sizes are what the page claims (checked later). */
export function pageIcons(html, baseUrl) {
  const icons = [];
  let manifest = null;
  const abs = (href) => {
    try {
      const u = new URL(href, baseUrl);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    } catch { return null; }
  };
  for (const [tag] of html.matchAll(/<(?:link|meta)\b[^>]*>/gi)) {
    if (/^<link/i.test(tag)) {
      const rel = String(attr(tag, 'rel') || '').toLowerCase().split(/\s+/);
      const href = attr(tag, 'href');
      if (!href) continue;
      if (rel.includes('manifest')) { manifest ??= abs(href); continue; }
      const touch = rel.some((r) => r.startsWith('apple-touch-icon'));
      if (!touch && !rel.includes('icon')) continue;
      if (isSvg(href, attr(tag, 'type'))) continue;
      const url = abs(href);
      if (url) icons.push({ url, size: declared(attr(tag, 'sizes')) || (touch ? 180 : 32) });
    } else {
      const prop = String(attr(tag, 'property') || attr(tag, 'name') || '').toLowerCase();
      const content = attr(tag, 'content');
      if (!content || !/^(og:image(:url|:secure_url)?|twitter:image)$/.test(prop) || isSvg(content)) continue;
      const url = abs(content);
      if (url) icons.push({ url, size: 64 }); // often a wide banner: tried after the icons
    }
  }
  return { icons, manifest };
}

/** Icons of a web manifest (JSON text). */
export function manifestIcons(text, baseUrl) {
  let doc;
  try { doc = JSON.parse(text); } catch { return []; }
  return (Array.isArray(doc?.icons) ? doc.icons : []).flatMap((i) => {
    if (typeof i?.src !== 'string' || isSvg(i.src, i.type) || /monochrome/.test(String(i.purpose || ''))) return [];
    try { return [{ url: new URL(i.src, baseUrl).href, size: declared(i.sizes) || 48 }]; } catch { return []; }
  });
}

// ---------- resolver ----------
async function readUpTo(res, max, truncate) {
  const parts = [];
  let size = 0;
  for await (const c of res) {
    size += c.length;
    if (size > max) {
      res.destroy();
      if (!truncate) return null;
      parts.push(c.subarray(0, c.length - (size - max)));
      break;
    }
    parts.push(c);
  }
  return Buffer.concat(parts);
}

/**
 * @param {object} o
 * @param {(url: string, opts: object) => Promise<import('node:http').IncomingMessage>} o.open guarded GET (radio.js)
 * @param {string|null} o.dir cache directory (null: no cache)
 */
export function logoResolver({ open, dir }) {
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const pending = new Map();
  let running = 0;
  const queue = [];
  const slot = () => (running < PARALLEL ? Promise.resolve(running++) : new Promise((r) => queue.push(r)));
  const free = () => { const next = queue.shift(); if (next) next(); else running--; }; // a waiter takes the slot over

  const fetchLogo = async (url, signal) => {
    try {
      const buf = await readUpTo(await open(url, { signal, timeoutMs: 8000, headers: { accept: 'image/*,*/*;q=0.5' } }), IMAGE_MAX, false);
      return buf && toLogo(buf);
    } catch { return null; }
  };
  const fetchText = async (url, max, signal, accept) => {
    const res = await open(url, { signal, timeoutMs: 8000, headers: { accept } });
    return { text: (await readUpTo(res, max, true)).toString('utf8'), url: res.finalUrl || url };
  };

  /** Best picture of a home page, or null. */
  const fromHomepage = async (homepage, signal) => {
    let page;
    try { page = await fetchText(homepage, PAGE_MAX, signal, 'text/html,application/xhtml+xml'); } catch { page = null; }
    const found = page ? pageIcons(page.text, page.url) : { icons: [], manifest: null };
    if (found.manifest) {
      try {
        const m = await fetchText(found.manifest, MANIFEST_MAX, signal, 'application/manifest+json,application/json');
        found.icons.push(...manifestIcons(m.text, m.url));
      } catch { /* no manifest */ }
    }
    // Declared sizes, largest first (above 512 px counts as 512: big enough, heavier).
    const seen = new Set();
    const list = found.icons.filter((i) => !seen.has(i.url) && seen.add(i.url))
      .sort((a, b) => Math.min(b.size, 512) - Math.min(a.size, 512));
    const ico = new URL('/favicon.ico', page?.url || homepage).href;
    if (!seen.has(ico)) list.push({ url: ico });
    let best = null;
    for (const { url } of list.slice(0, FETCHES)) {
      if (signal.aborted) break;
      const logo = await fetchLogo(url, signal);
      if (logo && (!best || logoScore(logo) > logoScore(best))) best = logo;
      if (isGood(best)) break;
    }
    return best;
  };

  /** `trusted`: a logo chosen by hand (radio-stations.js) is used whatever its shape. */
  const resolve = async ({ favicon, homepage, trusted = false }) => {
    const signal = AbortSignal.timeout(BUDGET_MS);
    const first = favicon ? await fetchLogo(favicon, signal) : null;
    if (isGood(first) || (trusted && first) || !homepage) return first;
    const other = await fromHomepage(homepage, signal).catch(() => null);
    return [first, other].filter(Boolean).sort((a, b) => logoScore(b) - logoScore(a))[0] || null;
  };

  // ----- disk cache: <key> = the picture, <key>.none = nothing found; age = file date -----
  const fresh = (file, ttl) => {
    try { return Date.now() - fs.statSync(file).mtimeMs < ttl; } catch { return false; }
  };
  const save = (file, buf) => {
    try { fs.writeFileSync(`${file}.tmp`, buf); fs.renameSync(`${file}.tmp`, file); } catch { /* read-only disk */ }
  };

  /**
   * Logo of a station: { buf, type } or null. `key` names the station and the source of its logo;
   * `source()` is called only on a cache miss (it may hit the directory).
   * ponytail: expired files are replaced when asked again, never swept; add a sweep if data/radio-logos grows.
   */
  return async function logo(key, source) {
    const file = dir ? path.join(dir, crypto.createHash('sha256').update(key).digest('hex').slice(0, 40)) : null;
    if (file && fresh(file, OK_TTL)) {
      const buf = fs.readFileSync(file);
      const type = imageType(buf);
      if (type) return { buf, type };
    }
    if (file && fresh(`${file}.none`, FAIL_TTL)) return null;
    if (pending.has(key)) return pending.get(key);
    const job = (async () => {
      await slot();
      try {
        const found = await resolve(await source());
        if (file) {
          if (found) { save(file, found.buf); fs.rmSync(`${file}.none`, { force: true }); } else save(`${file}.none`, Buffer.alloc(0));
        }
        return found && { buf: found.buf, type: found.type };
      } finally {
        free();
        pending.delete(key);
      }
    })();
    pending.set(key, job);
    return job;
  };
}
