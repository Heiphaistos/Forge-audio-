import { HttpError } from './util.js';
import { cleanTracks } from './userdata.js';

/**
 * « Activité des amis » and « Blend ».
 *
 * Each client reports the track it starts (POST /api/activity); the others see it live (SSE
 * `activity`) and, after a restart, the last entry of the synced history. Both features follow the
 * user's `shareActivity` setting (synced with the library, on by default): turned off, nothing is
 * reported, the user disappears from the list and cannot be blended.
 */
const LIVE_MS = 12 * 60 * 1000;

export const sharing = (data) => data?.settings?.shareActivity !== false;

/** Score a user's taste from their library: liked tracks weigh 3, then how often each track was played. */
export function tasteOf(lib, max = 60) {
  const score = new Map();
  const byUrl = new Map();
  for (const t of lib?.liked || []) { score.set(t.url, (score.get(t.url) || 0) + 3); byUrl.set(t.url, t); }
  for (const h of lib?.history || []) if (h?.track?.url && !byUrl.has(h.track.url)) byUrl.set(h.track.url, h.track);
  for (const [url, n] of Object.entries(lib?.playCounts || {})) if (byUrl.has(url)) score.set(url, (score.get(url) || 0) + Math.min(n, 30));
  const hidden = new Set(Object.entries(lib?.hiddenTracks || {}).filter(([, h]) => h.at > 0).map(([url]) => url));
  return [...score.entries()].filter(([u]) => !hidden.has(u)).sort((a, b) => b[1] - a[1]).slice(0, max).map(([u]) => byUrl.get(u));
}

const artistOf = (t) => String(t?.author || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim().toLowerCase();

/** Blend two tastes: shared tracks first, then one of each in turn, no duplicates. `match` = artist overlap in %. */
export function blend(a, b, size = 50) {
  const inB = new Set(b.map((t) => t.url));
  const common = a.filter((t) => inB.has(t.url));
  const seen = new Set(common.map((t) => t.url));
  const out = [...common];
  for (let i = 0; out.length < size && (i < a.length || i < b.length); i++) {
    for (const t of [a[i], b[i]]) if (t && !seen.has(t.url) && out.length < size) { seen.add(t.url); out.push(t); }
  }
  const aa = new Set(a.map(artistOf).filter(Boolean));
  const ba = new Set(b.map(artistOf).filter(Boolean));
  const inter = [...aa].filter((x) => ba.has(x)).length;
  const match = aa.size && ba.size ? Math.round((100 * inter) / Math.min(aa.size, ba.size)) : 0;
  return { tracks: out, common: common.length, match };
}

export function registerActivity(app, { accounts, userData, hub }) {
  /** username -> { track, at } (tracks started since the server started) */
  const live = new Map();
  const me = (request) => request.user.username;
  const dataOf = (u) => userData.get(u)?.data;

  app.post('/api/activity', async (request) => {
    const u = me(request);
    if (!sharing(dataOf(u))) return { ok: true, shared: false };
    const [track] = cleanTracks([request.body?.track]);
    if (!track) throw new HttpError('Titre invalide', 400);
    const entry = { track, at: Date.now() };
    live.set(u, entry);
    const others = accounts.list().map((a) => a.username).filter((x) => x !== u);
    hub.emit(others, { type: 'activity', user: u, displayName: accounts.get(u)?.displayName || u, ...entry, live: true });
    return { ok: true, shared: true };
  });

  app.get('/api/activity', async (request) => {
    const now = Date.now();
    const friends = accounts.list().filter((a) => a.username !== me(request)).map((a) => {
      const data = dataOf(a.username);
      if (!sharing(data)) return null;
      const l = live.get(a.username);
      const last = data?.library?.history?.[0];
      const entry = l && (!last || l.at >= last.at) ? l : last ? { track: last.track, at: last.at } : null;
      return entry ? { user: a.username, displayName: a.displayName, ...entry, live: now - entry.at < LIVE_MS } : null;
    }).filter(Boolean).sort((x, y) => y.at - x.at);
    return { friends };
  });

  app.get('/api/blend/:username', async (request) => {
    const other = String(request.params.username || '').toLowerCase();
    const acc = accounts.get(other);
    if (!acc || other === me(request)) throw new HttpError('Compte introuvable', 404);
    const mine = dataOf(me(request));
    const theirs = dataOf(other);
    if (!sharing(theirs)) throw new HttpError(`${acc.displayName} ne partage pas son activité : Blend indisponible`, 403, 'NOT_SHARED');
    if (!sharing(mine)) throw new HttpError('Activez « Partager mon activité » pour créer un Blend', 403, 'NOT_SHARED');
    const r = blend(tasteOf(mine?.library), tasteOf(theirs?.library));
    return { with: { username: other, displayName: acc.displayName }, ...r };
  });
}
