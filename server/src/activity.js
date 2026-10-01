import { HttpError } from './util.js';
import { cleanTracks } from './userdata.js';

/**
 * « Activité des amis » and « Blend ».
 *
 * Friends only. Each client reports the track it starts (POST /api/activity); friends see it live (SSE
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

const artistName = (t) => String(t?.author || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
const artistOf = (t) => artistName(t).toLowerCase();

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

/**
 * Listening stats of a library over the last `days` (Discord /playlist stats; the app computes the
 * same numbers itself in views/Stats.tsx so they stay available offline).
 */
export function statsOf(lib, days = 28, now = Date.now()) {
  const plays = (lib?.history || []).filter((h) => h?.track && h.at >= now - days * 86400000);
  const tracks = new Map();
  const artists = new Map();
  let seconds = 0;
  for (const { track } of plays) {
    seconds += track.duration || 0;
    const t = tracks.get(track.url) || { track, n: 0 };
    t.n += 1;
    tracks.set(track.url, t);
    const name = artistName(track);
    if (name) { const a = artists.get(name.toLowerCase()) || { name, n: 0 }; a.n += 1; artists.set(name.toLowerCase(), a); }
  }
  const top = (m) => [...m.values()].sort((a, b) => b.n - a.n).slice(0, 10);
  return { days, plays: plays.length, minutes: Math.round(seconds / 60), artistCount: artists.size, topArtists: top(artists), topTracks: top(tracks) };
}

export function registerActivity(app, { accounts, userData, hub, friends }) {
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
    hub.emit(friends.of(u).map((f) => f.username), { type: 'activity', user: u, displayName: accounts.get(u)?.displayName || u, ...entry, live: true });
    return { ok: true, shared: true };
  });

  /** What `username` plays now or played last, or null (nothing yet, or activity not shared). */
  const nowOf = (username) => {
    const data = dataOf(username);
    if (!sharing(data)) return null;
    const l = live.get(username);
    const last = data?.library?.history?.[0];
    const entry = l && (!last || l.at >= last.at) ? l : last ? { track: last.track, at: last.at } : null;
    return entry ? { ...entry, live: Date.now() - entry.at < LIVE_MS } : null;
  };

  const friendsOf = (username) => accounts.list().filter((a) => friends.are(username, a.username)).map((a) => {
    const entry = nowOf(a.username);
    return entry ? { user: a.username, displayName: a.displayName, ...entry } : null;
  }).filter(Boolean).sort((x, y) => y.at - x.at);

  const blendOf = (username, otherName) => {
    const other = String(otherName || '').toLowerCase();
    const acc = accounts.get(other);
    // Same answer for an unknown account and for someone who is not a friend.
    if (!acc || !friends.are(username, other)) throw new HttpError('Blend possible uniquement avec vos amis', 404, 'NOT_FRIENDS');
    const mine = dataOf(username);
    const theirs = dataOf(other);
    if (!sharing(theirs)) throw new HttpError(`${acc.displayName} ne partage pas son activité : Blend indisponible`, 403, 'NOT_SHARED');
    if (!sharing(mine)) throw new HttpError('Activez « Partager mon activité » pour créer un Blend', 403, 'NOT_SHARED');
    return { with: { username: other, displayName: acc.displayName }, ...blend(tasteOf(mine?.library), tasteOf(theirs?.library)) };
  };

  app.get('/api/activity', async (request) => ({ friends: friendsOf(me(request)) }));
  app.get('/api/blend/:username', async (request) => blendOf(me(request), request.params.username));

  return { friendsOf, blendOf, nowOf, statsOf: (username, days) => statsOf(dataOf(username)?.library, days) };
}
