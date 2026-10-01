import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline, Transform, PassThrough } from 'node:stream';
import { HttpError, isPublicUrl, isHttpUrl, clampInt, TtlCache } from './util.js';
import { readJson, writeJsonAtomic } from './accounts.js';
import { FEATURED, FEATURED_BY_ID } from './radio-stations.js';

/**
 * Radios: hand-picked French stations (radio-stations.js) + the free, open Radio Browser directory
 * (https://www.radio-browser.info, ~55 000 stations, no key). Everything goes through this server:
 * the browser never calls Radio Browser nor the stations.
 *
 * - Directory calls: User-Agent « ForgeAudio/<version> », mirrors listed by all.api.radio-browser.info,
 *   lists (countries, languages, tags) cached 24 h (memory + disk), searches 10 min. A listen is reported
 *   to Radio Browser (/json/url/<uuid>, their « click » counter) once per user and station per hour.
 * - Streams are relayed (an http:// stream cannot play in an https:// page, and HLS needs remuxing):
 *   only URLs of the directory or of the hand-picked list, never one sent by the client. Each hop
 *   (redirects, playlists, HLS segments, logos) is re-checked: public http(s) URL, every DNS answer a
 *   public address, and the connection made to the address that was checked (no DNS rebinding).
 *   Audio types only, streamed with back-pressure (nothing buffered without bound), closed when the
 *   listener leaves, at most PER_USER streams per account.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PER_USER = 3;
const MAX_TOTAL = 60;
const LOGO_MAX = 300 * 1024;
const TEXT_MAX = 256 * 1024;
const SEGMENT_MAX = 8 * 1024 * 1024;
const AUDIO_TYPES = /^(audio\/[a-z0-9.+-]+|application\/ogg)$/;
const PLAYLIST_TYPES = /^(audio\/(x-)?mpegurl|application\/(x-)?mpegurl|application\/vnd\.apple\.mpegurl|audio\/x-scpls|application\/pls\+xml|audio\/scpls)$/;

/** Genres = groups of close Radio Browser tags. */
export const GENRES = [
  { id: 'pop', label: 'Pop', tags: ['pop'] },
  { id: 'hits', label: 'Hits & Top 40', tags: ['top 40', 'hits', 'charts', 'top40'] },
  { id: 'rock', label: 'Rock', tags: ['rock', 'classic rock', 'hard rock'] },
  { id: 'indie', label: 'Indé & alternatif', tags: ['indie', 'alternative'] },
  { id: 'metal', label: 'Metal', tags: ['metal', 'heavy metal'] },
  { id: 'rap', label: 'Rap & hip-hop', tags: ['hiphop', 'hip-hop', 'hip hop', 'rap', 'french rap'] },
  { id: 'rnb', label: 'R&B, soul & funk', tags: ['rnb', 'r&b', 'soul', 'funk'] },
  { id: 'electro', label: 'Électro & dance', tags: ['electronic', 'dance', 'house', 'techno', 'electro', 'trance'] },
  { id: 'jazz', label: 'Jazz & blues', tags: ['jazz', 'blues', 'smooth jazz'] },
  { id: 'classique', label: 'Classique', tags: ['classical', 'classique', 'baroque', 'opera'] },
  { id: 'chill', label: 'Chill & lounge', tags: ['chillout', 'lounge', 'ambient', 'chill', 'lofi', 'lo-fi'] },
  { id: '80s', label: 'Années 80', tags: ['80s', "80's", '1980s', '80er'] },
  { id: '90s', label: 'Années 90', tags: ['90s', "90's", '1990s', '90er'] },
  { id: 'oldies', label: 'Oldies, 60s & 70s', tags: ['oldies', '60s', '70s'] },
  { id: 'chanson', label: 'Chanson française', tags: ['chansons françaises', 'chanson', 'french chansons', 'chanson française', 'french', 'french music'] },
  { id: 'reggae', label: 'Reggae & ska', tags: ['reggae', 'dancehall', 'ska'] },
  { id: 'latino', label: 'Latino', tags: ['latin pop', 'latino', 'latin', 'latin music', 'musica latina', 'salsa'] },
  { id: 'world', label: 'Musiques du monde', tags: ['world music', 'world', 'african music', 'arabic', 'african'] },
  { id: 'country', label: 'Country & folk', tags: ['country', 'folk'] },
  { id: 'info', label: 'Info', tags: ['news', 'news talk', 'information', 'info'] },
  { id: 'talk', label: 'Talk & culture', tags: ['talk', 'talk radio', 'culture', 'public radio'] },
  { id: 'sport', label: 'Sport', tags: ['sports', 'sport', 'sports talk', 'live sports'] },
  { id: 'soundtrack', label: 'Musiques de films', tags: ['soundtracks', 'soundtrack', 'film', 'film music', 'movie soundtracks'] },
  { id: 'asia', label: 'K-pop, J-pop & anime', tags: ['kpop', 'k-pop', 'jpop', 'j-pop', 'anime'] },
  { id: 'kids', label: 'Enfants', tags: ['kids', 'children', 'childrens music'] },
  { id: 'religion', label: 'Spiritualité', tags: ['christian', 'religious', 'gospel', 'islam'] },
];
const GENRE_BY_ID = new Map(GENRES.map((g) => [g.id, g]));

// ---------- safe outgoing HTTP ----------

/** Public unicast address (no loopback, private, link-local, CGNAT, multicast…). */
export function isPublicIp(ip) {
  if (net.isIPv4(ip)) return Number(ip.split('.')[0]) < 224 && isPublicUrl(`http://${ip}/`);
  if (net.isIPv6(ip)) return !/^(ff|2001:db8:|64:ff9b:)/i.test(ip) && isPublicUrl(`http://[${ip}]/`);
  return false;
}

/** dns.lookup that refuses a name when ANY of its addresses is not public; the socket then connects to a checked address. */
export function safeLookup(hostname, options, cb) {
  if (typeof options === 'function') [cb, options] = [options, {}];
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => !isPublicIp(a.address))) {
      return cb(Object.assign(new Error(`Adresse non autorisée : ${hostname}`), { code: 'EBLOCKED' }));
    }
    if (options?.all) return cb(null, addrs);
    return cb(null, addrs[0].address, addrs[0].family);
  });
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

const contentType = (res) => String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();

/** Read a whole body, refusing more than `max` bytes. */
function readBody(res, max) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    res.on('data', (c) => {
      size += c.length;
      if (size > max) {
        res.destroy();
        reject(new HttpError('Réponse trop volumineuse', 502, 'UPSTREAM_ERROR'));
      } else parts.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(parts)));
    res.on('error', reject);
  });
}

// ---------- ICY metadata (« title in progress ») ----------

/** Removes the ICY metadata blocks interleaved every `metaint` bytes, reporting StreamTitle. */
export class IcyStrip extends Transform {
  constructor(metaint, onTitle) {
    super();
    this.metaint = metaint;
    this.left = metaint;
    this.meta = null;
    this.metaLeft = 0;
    this.onTitle = onTitle;
  }

  _transform(chunk, _enc, cb) {
    let i = 0;
    while (i < chunk.length) {
      if (this.left > 0) {
        const n = Math.min(this.left, chunk.length - i);
        this.push(chunk.subarray(i, i + n));
        i += n;
        this.left -= n;
      } else if (this.meta === null) {
        this.metaLeft = chunk[i++] * 16;
        if (this.metaLeft) this.meta = [];
        else this.left = this.metaint;
      } else {
        const n = Math.min(this.metaLeft, chunk.length - i);
        this.meta.push(chunk.subarray(i, i + n));
        i += n;
        this.metaLeft -= n;
        if (!this.metaLeft) {
          const title = icyTitle(Buffer.concat(this.meta));
          if (title !== null) this.onTitle(title);
          this.meta = null;
          this.left = this.metaint;
        }
      }
    }
    cb();
  }
}

export function icyTitle(buf) {
  const utf8 = buf.toString('utf8');
  const text = utf8.includes('�') ? buf.toString('latin1') : utf8;
  const m = text.match(/StreamTitle='(.*?)';/s);
  if (!m) return null;
  return m[1].replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
}

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

// ---------- module ----------

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {object} o
 * @param {string} o.version  for the User-Agent sent to Radio Browser and the stations
 * @param {string|null} [o.dataDir] disk cache of the 24 h lists
 * @param {string} [o.ffmpeg] remuxes HLS radios to MP3
 * @param {(path: string) => Promise<any>} [o.fetchJson] Radio Browser call (tests)
 * @param {(url: string) => boolean} [o.checkUrl] URL guard before each hop (tests)
 * @param {Function} [o.lookup] DNS guard (tests)
 */
export function registerRadio(app, { version, dataDir = null, ffmpeg = 'ffmpeg', fetchJson = null, checkUrl = isPublicUrl, lookup = safeLookup } = {}) {
  const UA = `ForgeAudio/${version} (+https://forgeaudio.heiphaistos.org)`;
  const lists = new TtlCache({ ttlMs: 24 * 3600 * 1000, max: 100 });
  const searches = new TtlCache({ ttlMs: 10 * 60 * 1000, max: 500 });
  const known = new TtlCache({ ttlMs: 24 * 3600 * 1000, max: 20000 });
  const nowPlaying = new TtlCache({ ttlMs: 10 * 60 * 1000, max: 2000 });
  const clicked = new TtlCache({ ttlMs: 3600 * 1000, max: 5000 });
  const logoFailed = new TtlCache({ ttlMs: 6 * 3600 * 1000, max: 5000 });
  const active = new Map(); // username -> open streams
  let total = 0;

  // ----- disk cache of the 24 h lists (deployments restart the server often) -----
  const diskFile = dataDir ? path.join(dataDir, 'radio-cache.json') : null;
  if (diskFile) {
    for (const [k, { at, value }] of Object.entries(readJson(diskFile, {}))) {
      const left = at + 24 * 3600 * 1000 - Date.now();
      if (left > 0) lists.set(k, value, left);
    }
  }
  const saveDisk = (key, value) => {
    if (!diskFile) return;
    const doc = readJson(diskFile, {});
    doc[key] = { at: Date.now(), value };
    try { writeJsonAtomic(diskFile, doc); } catch { /* read-only disk: memory only */ }
  };
  const longList = (key, producer) => lists.wrap(key, async () => {
    const value = await producer();
    saveDisk(key, value);
    return value;
  });

  // ----- Radio Browser -----
  const FALLBACK_SERVERS = ['de1.api.radio-browser.info', 'de2.api.radio-browser.info', 'fi1.api.radio-browser.info'];
  const getJson = async (url) => {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  const servers = () => lists.wrap('servers', async () => {
    try {
      const list = await getJson('https://all.api.radio-browser.info/json/servers');
      const names = [...new Set(list.map((s) => s.name).filter((n) => /^[a-z0-9.-]+\.radio-browser\.info$/.test(n)))];
      return names.length ? names : FALLBACK_SERVERS;
    } catch {
      return FALLBACK_SERVERS;
    }
  });
  const rb = fetchJson || (async (p) => {
    const list = [...await servers()].sort(() => Math.random() - 0.5);
    let last;
    for (const host of list.slice(0, 3)) {
      try { return await getJson(`https://${host}${p}`); } catch (err) { last = err; }
    }
    app.log.warn({ err: last?.message, path: p }, 'Radio Browser injoignable');
    throw new HttpError('Annuaire des radios injoignable, réessayez dans un instant', 502, 'UPSTREAM_ERROR');
  });

  // ----- stations -----
  const text = (s, max) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  const tagsOf = (s) => [...new Set(String(s || '').split(',').map((t) => text(t, 30).toLowerCase()).filter(Boolean))].slice(0, 6);

  const featuredCard = (f) => ({
    id: f.id, name: f.name, group: f.group, country: f.country, countryCode: f.countryCode, language: f.language, tags: f.tags,
    codec: f.codec, bitrate: f.bitrate, homepage: f.homepage, logo: f.logo ? `/api/radio/logo/${f.id}` : null, color: f.color, featured: true,
  });

  /** Keep what the relay needs (stream URL, favicon) server side; the client gets a card. */
  const remember = (s) => {
    const id = String(s?.stationuuid || '');
    if (!UUID.test(id)) return null;
    const url = isHttpUrl(s.url_resolved) ? s.url_resolved : isHttpUrl(s.url) ? s.url : null;
    if (!url) return null;
    const rec = {
      card: {
        id, name: text(s.name, 120) || 'Radio sans nom', country: text(s.country, 60) || null,
        countryCode: /^[A-Z]{2}$/.test(s.countrycode) ? s.countrycode : null, language: text(s.language, 60) || null,
        tags: tagsOf(s.tags), codec: text(s.codec, 12) || null, bitrate: Number(s.bitrate) > 0 ? Number(s.bitrate) : null,
        homepage: isHttpUrl(s.homepage) ? String(s.homepage).trim().slice(0, 500) : null,
        logo: isHttpUrl(s.favicon) ? `/api/radio/logo/${id}` : null,
        votes: Number(s.votes) || 0, clicks: Number(s.clickcount) || 0,
      },
      url: url.trim(),
      favicon: isHttpUrl(s.favicon) ? String(s.favicon).trim() : null,
      hls: Number(s.hls) === 1,
    };
    known.set(id, rec);
    return rec;
  };
  const cards = (list) => (Array.isArray(list) ? list : []).map(remember).filter(Boolean).map((r) => r.card);

  /** A station of the hand-picked list or of the directory, never a URL from the client. */
  const station = async (id) => {
    const f = FEATURED_BY_ID.get(id);
    if (f) return { card: featuredCard(f), url: f.url, favicon: f.logo, hls: false, featured: true };
    if (!UUID.test(id)) throw new HttpError('Radio inconnue', 404, 'NOT_FOUND');
    const hit = known.get(id);
    if (hit) return hit;
    const list = await searches.wrap(`uuid|${id}`, () => rb(`/json/stations/byuuid/${id}`));
    const rec = Array.isArray(list) && list[0] ? remember(list[0]) : null;
    if (!rec) throw new HttpError('Radio introuvable dans l’annuaire', 404, 'NOT_FOUND');
    return rec;
  };

  // ----- per-user request limit (fixed one-minute windows) -----
  const hits = new Map();
  const limited = (request, bucket, max) => {
    const key = `${bucket}|${request.user.username}`;
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) {
      if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      hits.set(key, { n: 1, reset: now + 60_000 });
      return;
    }
    if (++h.n > max) throw new HttpError('Trop de requêtes, patientez une minute', 429, 'RATE_LIMITED');
  };

  // ----- outgoing requests (relay, playlists, logos) -----
  /** GET with every hop re-checked; resolves the response (status 200 only) with its final URL. */
  const open = (url, { signal, timeoutMs = 15_000, headers = {} } = {}) => new Promise((resolve, reject) => {
    const go = (u, left) => {
      if (!checkUrl(u)) return reject(new HttpError('Adresse de flux non autorisée', 403, 'FORBIDDEN'));
      const lib = u.startsWith('https:') ? https : http;
      const req = lib.get(u, { headers: { 'user-agent': UA, accept: '*/*', ...headers }, lookup, signal, timeout: timeoutMs }, (res) => {
        const loc = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
          res.resume();
          if (!left) return reject(new HttpError('Trop de redirections', 502, 'UPSTREAM_ERROR'));
          let next;
          try { next = new URL(loc, u).href; } catch { return reject(new HttpError('Redirection invalide', 502, 'UPSTREAM_ERROR')); }
          return go(next, left - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new HttpError(`la radio répond ${res.statusCode}`, 502, 'UPSTREAM_ERROR'));
        }
        res.finalUrl = u;
        resolve(res);
      });
      // Idle socket (connection or a stalled stream): give up.
      req.on('timeout', () => req.destroy(new HttpError('la radio ne répond pas', 504, 'UPSTREAM_TIMEOUT')));
      req.on('error', (err) => {
        if (err.userFacing) return reject(err);
        if (err.code === 'EBLOCKED') return reject(new HttpError('Adresse de flux non autorisée', 403, 'FORBIDDEN'));
        reject(new HttpError('radio injoignable', 502, 'UPSTREAM_ERROR'));
      });
    };
    go(url, 5);
  });

  const isHlsText = (t) => /#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE)/.test(t);

  /**
   * Open a station's stream: plain audio (ICY metadata asked), or HLS / .pls / .m3u resolved here.
   * @returns {Promise<{ res?: import('node:http').IncomingMessage, hls?: { text: string, url: string } }>}
   */
  const openStream = async (url, signal, depth = 0) => {
    const res = await open(url, { signal, headers: { 'icy-metadata': '1' } });
    const type = contentType(res);
    const file = new URL(res.finalUrl).pathname.toLowerCase();
    const looksPlaylist = PLAYLIST_TYPES.test(type) || /\.(m3u8?|pls)$/.test(file);
    if (!looksPlaylist && AUDIO_TYPES.test(type)) return { res };
    if (!looksPlaylist) {
      res.destroy();
      throw new HttpError('ce n’est pas un flux audio', 502, 'NOT_AUDIO');
    }
    const body = (await readBody(res, TEXT_MAX)).toString('utf8');
    if (isHlsText(body)) return { hls: { text: body, url: res.finalUrl } };
    // .pls (File1=…) or .m3u (one URL per line): first stream listed.
    const next = body.split(/\r?\n/).map((l) => l.replace(/^File\d+=/i, '').trim()).find((l) => /^https?:\/\//i.test(l));
    if (!next || depth >= 2) throw new HttpError('liste de lecture illisible', 502, 'UPSTREAM_ERROR');
    return openStream(new URL(next, res.finalUrl).href, signal, depth + 1);
  };

  const fetchText = async (url, signal) => {
    const res = await open(url, { signal });
    return { text: (await readBody(res, TEXT_MAX)).toString('utf8'), url: res.finalUrl };
  };

  /** Media playlist of an HLS radio (a variant near 128-200 kbit/s when it offers several). */
  const hlsMedia = async ({ text: body, url }, signal) => {
    if (!body.includes('#EXT-X-STREAM-INF')) return { text: body, url };
    const lines = body.split(/\r?\n/);
    const variants = [];
    lines.forEach((l, i) => {
      if (!l.startsWith('#EXT-X-STREAM-INF')) return;
      const uri = lines.slice(i + 1).find((x) => x.trim() && !x.startsWith('#'));
      if (uri) variants.push({ bw: Number(l.match(/BANDWIDTH=(\d+)/)?.[1]) || 0, url: new URL(uri.trim(), url).href });
    });
    if (!variants.length) throw new HttpError('flux HLS illisible', 502, 'UPSTREAM_ERROR');
    variants.sort((a, b) => a.bw - b.bw);
    const pick = [...variants].reverse().find((v) => v.bw && v.bw <= 200_000) || variants[0];
    return fetchText(pick.url, signal);
  };

  const parseMedia = ({ text: body, url }) => {
    if (/#EXT-X-KEY:METHOD=(?!NONE)/.test(body)) throw new HttpError('radio chiffrée', 502, 'UNSUPPORTED');
    const lines = body.split(/\r?\n/).map((l) => l.trim());
    const seq = Number(body.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1]) || 0;
    const map = body.match(/#EXT-X-MAP:URI="([^"]+)"/)?.[1];
    const segments = lines.filter((l) => l && !l.startsWith('#')).map((l, i) => ({ n: seq + i, url: new URL(l, url).href }));
    if (!segments.length) throw new HttpError('flux HLS vide', 502, 'UPSTREAM_ERROR');
    return {
      segments,
      init: map ? new URL(map, url).href : null,
      target: Math.min(10, Math.max(1, Number(body.match(/#EXT-X-TARGETDURATION:(\d+)/)?.[1]) || 4)),
      ended: body.includes('#EXT-X-ENDLIST'),
    };
  };

  /** HLS: segments fetched here (each hop checked) and fed to ffmpeg's stdin, MP3 out. */
  const relayHls = (media, out, signal, done) => {
    const ff = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    ff.on('error', () => out.destroy());
    ff.stdin.on('error', () => {});
    pipeline(ff.stdout, out, () => { ff.kill('SIGKILL'); done(); });
    // Resolves on drain, or when ffmpeg is gone (listener left): the loop then sees the abort and stops.
    const write = (buf) => new Promise((resolve) => {
      if (ff.stdin.destroyed || ff.stdin.write(buf)) return resolve();
      ff.stdin.once('drain', resolve);
      ff.stdin.once('close', resolve);
    });
    (async () => {
      let pl = media;
      let last = -1;
      let initDone = false;
      while (!signal.aborted) {
        const { segments, init, target, ended } = parseMedia(pl);
        // Join live: the last three segments only.
        const fresh = segments.filter((s) => s.n > last).slice(last < 0 ? -3 : 0);
        if (init && !initDone) {
          await write(await readBody(await open(init, { signal }), SEGMENT_MAX));
          initDone = true;
        }
        for (const s of fresh) {
          if (signal.aborted) return;
          await write(await readBody(await open(s.url, { signal }), SEGMENT_MAX));
          last = s.n;
        }
        if (ended && !fresh.length) break;
        if (!fresh.length) await sleep(target * 500, signal);
        if (signal.aborted) return;
        pl = await fetchText(pl.url, signal);
      }
      ff.stdin.end();
    })().catch(() => out.destroy());
  };

  // ---------- routes ----------
  const pageArgs = (q) => ({ limit: clampInt(q.limit, 1, 60, 48), offset: clampInt(q.offset, 0, 5000, 0) });

  app.get('/api/radio/featured', async (request) => {
    limited(request, 'list', 240);
    return { stations: FEATURED.map(featuredCard) };
  });

  app.get('/api/radio/countries', async (request) => {
    limited(request, 'list', 240);
    const countries = await longList('countries', async () => {
      const byCode = new Map();
      for (const c of await rb('/json/countries?hidebroken=true&order=stationcount&reverse=true')) {
        const code = String(c.iso_3166_1 || '').toUpperCase();
        if (!/^[A-Z]{2}$/.test(code) || !(c.stationcount > 0)) continue;
        const have = byCode.get(code);
        byCode.set(code, { code, name: have?.name || text(c.name, 60), count: (have?.count || 0) + Number(c.stationcount) });
      }
      return [...byCode.values()].sort((a, b) => b.count - a.count);
    });
    return { countries };
  });

  app.get('/api/radio/languages', async (request) => {
    limited(request, 'list', 240);
    const languages = await longList('languages', async () => (await rb('/json/languages?hidebroken=true&order=stationcount&reverse=true&limit=120'))
      .filter((l) => l.name && l.stationcount >= 20)
      .map((l) => ({ name: text(l.name, 40).toLowerCase(), code: /^[a-z]{2,3}$/.test(l.iso_639 || '') ? l.iso_639 : null, count: Number(l.stationcount) })));
    return { languages };
  });

  app.get('/api/radio/genres', async (request) => {
    limited(request, 'list', 240);
    const genres = await longList('genres', async () => {
      const counts = new Map((await rb('/json/tags?hidebroken=true&order=stationcount&reverse=true&limit=3000')).map((t) => [String(t.name).toLowerCase(), Number(t.stationcount) || 0]));
      // Approximate: a station tagged « rock, hard rock » counts twice.
      return GENRES.map((g) => ({ id: g.id, label: g.label, count: g.tags.reduce((n, t) => n + (counts.get(t) || 0), 0) }));
    });
    return { genres };
  });

  app.get('/api/radio/stations', async (request) => {
    limited(request, 'list', 240);
    const q = request.query;
    const { limit, offset } = pageArgs(q);
    const country = q.country ? String(q.country).toUpperCase() : null;
    if (country && !/^[A-Z]{2}$/.test(country)) throw new HttpError('Pays invalide');
    const language = q.language ? String(q.language).toLowerCase().trim() : null;
    if (language && !/^[a-z][a-z -]{1,39}$/.test(language)) throw new HttpError('Langue invalide');
    const genre = q.genre ? GENRE_BY_ID.get(String(q.genre)) : null;
    if (q.genre && !genre) throw new HttpError('Genre inconnu');
    const name = text(q.q, 80);
    const base = { hidebroken: 'true', order: 'clickcount', reverse: 'true' };
    if (country) base.countrycode = country;
    if (language) Object.assign(base, { language, languageExact: 'true' });
    if (name) base.name = name;

    if (genre) {
      // One query per tag of the genre, merged by popularity.
      const all = await searches.wrap(`g|${genre.id}|${country}|${language}|${name.toLowerCase()}`, async () => {
        const seen = new Set();
        const found = await Promise.all(genre.tags.map((tag) => rb(`/json/stations/search?${new URLSearchParams({ ...base, tag, tagExact: 'true', limit: '250' })}`)));
        return found.flat().filter((s) => s?.stationuuid && !seen.has(s.stationuuid) && seen.add(s.stationuuid))
          .sort((a, b) => (b.clickcount || 0) - (a.clickcount || 0));
      });
      return { stations: cards(all.slice(offset, offset + limit)), more: all.length > offset + limit };
    }
    const params = new URLSearchParams({ ...base, limit: String(limit + 1), offset: String(offset) });
    const list = await searches.wrap(`s|${params}`, () => rb(`/json/stations/search?${params}`));
    return { stations: cards(list.slice(0, limit)), more: list.length > limit };
  });

  app.get('/api/radio/station/:id', async (request) => {
    limited(request, 'list', 240);
    return { station: (await station(String(request.params.id))).card };
  });

  app.get('/api/radio/meta/:id', async (request) => {
    limited(request, 'meta', 120);
    return { title: nowPlaying.get(String(request.params.id)) || null };
  });

  app.get('/api/radio/logo/:id', async (request, reply) => {
    limited(request, 'logo', 900);
    const id = String(request.params.id);
    if (logoFailed.get(id)) throw new HttpError('Logo indisponible', 404, 'NOT_FOUND');
    const st = await station(id);
    if (!st.favicon) throw new HttpError('Logo indisponible', 404, 'NOT_FOUND');
    let buf = null;
    try {
      buf = await readBody(await open(st.favicon, { timeoutMs: 8000 }), LOGO_MAX);
    } catch { /* below */ }
    const type = buf && imageType(buf);
    if (!type) {
      logoFailed.set(id, true);
      throw new HttpError('Logo indisponible', 404, 'NOT_FOUND');
    }
    reply.header('content-type', type);
    reply.header('cache-control', 'private, max-age=604800');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', "default-src 'none'");
    return reply.send(buf);
  });

  app.get('/api/radio/listen/:id', async (request, reply) => {
    limited(request, 'listen', 60);
    const id = String(request.params.id);
    const st = await station(id);
    const user = request.user.username;
    if ((active.get(user) || 0) >= PER_USER) throw new HttpError('Trop de radios ouvertes en même temps sur ce compte', 429, 'TOO_MANY_STREAMS');
    if (total >= MAX_TOTAL) throw new HttpError('Serveur de radios saturé, réessayez dans un instant', 503, 'BUSY');

    // Counted before any await so parallel requests cannot pass the limit together.
    active.set(user, (active.get(user) || 0) + 1);
    total += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      total -= 1;
      const n = (active.get(user) || 1) - 1;
      if (n > 0) active.set(user, n); else active.delete(user);
    };
    const ac = new AbortController();
    reply.raw.on('close', () => { ac.abort(); release(); });

    // Radio Browser's listen counter (« click »), as they ask from players.
    if (!st.featured && !clicked.get(`${user}|${id}`)) {
      clicked.set(`${user}|${id}`, true);
      rb(`/json/url/${id}`).catch(() => {});
    }

    let opened;
    try {
      opened = st.hls || /\.m3u8(\?|$)/i.test(st.url) ? { hls: await fetchText(st.url, ac.signal) } : await openStream(st.url, ac.signal);
      if (opened.hls) {
        if (!isHlsText(opened.hls.text)) throw new HttpError('flux HLS illisible', 502, 'UPSTREAM_ERROR');
        opened.hls = await hlsMedia(opened.hls, ac.signal);
        parseMedia(opened.hls);
      }
    } catch (err) {
      release();
      request.log.info({ station: id, err: err.message }, 'Radio indisponible');
      if (err.status === 403) throw err;
      throw new HttpError(`Radio indisponible : ${err.userFacing ? err.message : 'radio injoignable'}`, 502, 'RADIO_UNAVAILABLE');
    }

    reply.hijack();
    const out = reply.raw;
    const head = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    if (opened.hls) {
      out.writeHead(200, { ...head, 'content-type': 'audio/mpeg' });
      relayHls(opened.hls, out, ac.signal, release);
      return reply;
    }
    const { res } = opened;
    const metaint = Number(res.headers['icy-metaint']) || 0;
    const strip = metaint > 0 && metaint <= 1_000_000 ? new IcyStrip(metaint, (title) => { if (title) nowPlaying.set(id, title); }) : new PassThrough();
    out.writeHead(200, { ...head, 'content-type': contentType(res) });
    pipeline(res, strip, out, release);
    return reply;
  });
}
