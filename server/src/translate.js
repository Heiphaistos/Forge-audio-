import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, TtlCache } from './util.js';

/**
 * « Paroles traduites »: lyrics translated by the free MyMemory API (https://mymemory.translated.net),
 * called by the SERVER only. Unique lines are sent in chunks (one line per « \n », 500 bytes max per
 * request), one request at a time, spaced out, under a daily character budget below the free quota
 * (5 000 chars/day anonymous, 50 000 with a contact address in TRANSLATE_EMAIL). Results are cached
 * on disk (data/lyrics-tr) so a song is only ever translated once per language.
 */

export const LANGS = new Set(['fr', 'en', 'es', 'de', 'it', 'pt', 'nl', 'pl', 'tr', 'ru', 'ar', 'ja', 'ko', 'zh']);
const API = 'https://api.mymemory.translated.net/get';
const CHUNK_BYTES = 480;
const MAX_LINE = 300;

// Words that are French and (nearly) never English / Spanish / Italian / Portuguese.
const FR_WORDS = new Set(['le', 'les', 'des', 'du', 'et', 'est', 'je', 'elle', 'nous', 'vous', 'qui', 'pas', 'une', 'mon', 'mes', 'ton', 'dans', 'pour', 'avec', 'moi', 'toi', "c'est", "j'ai", 'suis', 'sont', 'tout', 'au', 'aux', 'cette', 'oui', 'rien', "j'suis", "t'es", 'quand', 'toujours', 'encore', 'jamais', 'mais', 'ça', 'être', 'faire']);

/** True when the text is obviously French: no request is spent on it. */
export function looksFrench(lines) {
  const words = lines.join(' ').toLowerCase().replace(/[’]/g, "'").match(/[a-zàâçéèêëîïôûùüÿœ']+/g) || [];
  if (words.length < 6) return false;
  return words.filter((w) => FR_WORDS.has(w)).length / words.length >= 0.15;
}

/** Group lines into requests of at most `max` UTF-8 bytes once joined by « \n ». */
export function chunkLines(lines, max = CHUNK_BYTES) {
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const line of lines) {
    const n = Buffer.byteLength(line) + 1;
    if (cur.length && size + n > max) { chunks.push(cur); cur = []; size = 0; }
    cur.push(line);
    size += n;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const nextUtcMidnight = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); };
const QUOTA_MSG = 'Traductions épuisées pour aujourd’hui, réessayez demain';

export function createTranslator({ dataDir = null, fetchImpl = fetch, email = process.env.TRANSLATE_EMAIL || '', gapMs = 300, dailyChars = null } = {}) {
  const dir = dataDir ? path.join(dataDir, 'lyrics-tr') : null;
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const mem = new TtlCache({ ttlMs: 7 * 86400000, max: 300 });
  const budget = dailyChars ?? (email ? 45000 : 4500);
  let chain = Promise.resolve();
  let day = '';
  let used = 0;
  let blockedUntil = 0;

  /** One upstream request, serialised and spaced; { text, lang } or { same: true }. */
  const call = (q, from, to) => {
    const job = chain.then(async () => {
      const today = new Date().toISOString().slice(0, 10);
      if (today !== day) { day = today; used = 0; }
      if (Date.now() < blockedUntil || used + q.length > budget) throw new HttpError(QUOTA_MSG, 503, 'QUOTA');
      used += q.length;
      const params = new URLSearchParams({ q, langpair: `${from}|${to}` });
      if (email) params.set('de', email);
      let res;
      let body = null;
      try {
        res = await fetchImpl(`${API}?${params}`, { headers: { 'user-agent': 'ForgeAudio (lyrics)' }, signal: AbortSignal.timeout(15_000) });
        body = await res.json().catch(() => null);
      } catch {
        throw new HttpError('Service de traduction indisponible', 502, 'UPSTREAM_ERROR');
      } finally {
        await new Promise((r) => setTimeout(r, gapMs));
      }
      const status = Number(body?.responseStatus);
      if (res.status === 429 || status === 429 || body?.quotaFinished === true) {
        blockedUntil = nextUtcMidnight();
        throw new HttpError(QUOTA_MSG, 503, 'QUOTA');
      }
      if (/DISTINCT LANGUAGES/i.test(String(body?.responseDetails || ''))) return { same: true };
      if (!res.ok || status !== 200 || typeof body?.responseData?.translatedText !== 'string') throw new HttpError('Service de traduction indisponible', 502, 'UPSTREAM_ERROR');
      const lang = String(body.responseData.detectedLanguage || '').slice(0, 2).toLowerCase();
      return { text: decodeEntities(body.responseData.translatedText), lang: /^[a-z]{2}$/.test(lang) ? lang : null };
    });
    chain = job.catch(() => {});
    return job;
  };

  /** Translate `unique` lines (no duplicates, no empty ones) into `to`. */
  const run = async (unique, to) => {
    let from = 'autodetect';
    const out = new Map();
    for (const chunk of chunkLines(unique)) {
      const r = await call(chunk.join('\n'), from, to);
      if (r.same) return { lang: to, same: true };
      if (from === 'autodetect' && r.lang) {
        if (r.lang === to) return { lang: to, same: true };
        from = r.lang;
      }
      const parts = r.text.split('\n');
      if (parts.length === chunk.length) {
        chunk.forEach((l, i) => out.set(l, parts[i].trim()));
      } else {
        // The service merged or split lines: translate this chunk line by line.
        for (const l of chunk) {
          const one = await call(l, from, to);
          if (one.same) return { lang: to, same: true };
          out.set(l, one.text.replace(/\s*\n\s*/g, ' ').trim());
        }
      }
    }
    return { lang: from === 'autodetect' ? null : from, same: false, map: Object.fromEntries(out) };
  };

  /**
   * @param {string[]} lines lyrics lines (any count; empty / « ♪ » lines stay empty)
   * @param {string} to target language (LANGS)
   * @returns {Promise<{ lang: string|null, same: boolean, lines: string[] }>} lines aligned with the input
   */
  async function translate(lines, to) {
    const clean = lines.map((l) => String(l ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_LINE));
    const unique = [...new Set(clean.filter((l) => /\p{L}/u.test(l)))];
    if (!unique.length) return { lang: null, same: false, lines: clean.map(() => '') };
    if (to === 'fr' && looksFrench(unique)) return { lang: 'fr', same: true, lines: [] };
    const key = crypto.createHash('sha256').update(`${to}\0${unique.join('\n')}`).digest('hex').slice(0, 40);
    const file = dir ? path.join(dir, `${key}.json`) : null;
    const res = await mem.wrap(key, async () => {
      if (file) {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not cached yet */ }
      }
      const r = await run(unique, to);
      if (file) {
        try { fs.writeFileSync(`${file}.tmp`, JSON.stringify(r)); fs.renameSync(`${file}.tmp`, file); } catch { /* read-only disk */ }
      }
      return r;
    });
    if (res.same) return { lang: res.lang, same: true, lines: [] };
    return { lang: res.lang, same: false, lines: clean.map((l) => res.map[l] ?? '') };
  }

  return { translate };
}

/** POST /api/lyrics/translate { lines: string[], to } → { lang, same, lines }. */
export function registerTranslate(app, opts = {}) {
  const translator = createTranslator(opts);
  // 60 requests per hour and per account (a song toggled on = 1 request; cached answers count too).
  const hits = new Map();
  const limited = (user) => {
    const now = Date.now();
    const h = hits.get(user);
    if (!h || h.reset < now) {
      if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      hits.set(user, { n: 1, reset: now + 3600_000 });
      return;
    }
    if (++h.n > 60) throw new HttpError('Trop de traductions, patientez un peu', 429, 'RATE_LIMITED');
  };

  app.post('/api/lyrics/translate', async (request) => {
    const { lines, to } = request.body || {};
    if (!LANGS.has(to)) throw new HttpError('Langue non prise en charge');
    if (!Array.isArray(lines) || !lines.length || lines.length > 400 || !lines.every((l) => typeof l === 'string')) throw new HttpError('Paroles invalides');
    if (lines.reduce((n, l) => n + l.length, 0) > 20000) throw new HttpError('Paroles trop longues');
    limited(request.user?.username || request.ip);
    return translator.translate(lines, to);
  });
}
