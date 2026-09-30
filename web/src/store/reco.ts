import { create } from 'zustand';
import { api, type Mix, type Reco } from '../lib/api';
import { artistKey, useLibrary } from './library';

/**
 * Home recommendations (server/src/catalog.js): « Mix du jour », « Découvertes de la semaine »,
 * « Radar des sorties ». Seeds = the listener's own artists: most played, liked, followed.
 * Computed on the server from Deezer's public data, cached there 6 h; refreshed here once per session.
 */
export const useReco = create<{ data: Reco | null; loading: boolean; loadedAt: number }>(() => ({ data: null, loading: false, loadedAt: 0 }));

function seeds() {
  const lib = useLibrary.getState();
  const score = new Map<string, { name: string; n: number }>();
  const add = (name: string | null | undefined, n: number) => {
    if (!name) return;
    const k = artistKey(name);
    if ((lib.hiddenArtists[k]?.at || 0) > 0) return;
    score.set(k, { name, n: (score.get(k)?.n || 0) + n });
  };
  const byUrl = new Map(lib.history.map((h) => [h.track.url, h.track]));
  for (const [url, n] of Object.entries(lib.playCounts)) add(byUrl.get(url)?.author, n);
  for (const t of lib.liked.slice(0, 500)) add(t.author, 3);
  const top = [...score.values()].sort((a, b) => b.n - a.n).map((x) => x.name).slice(0, 12);
  const known = new Set<string>();
  for (const t of [...lib.liked, ...lib.history.map((h) => h.track), ...lib.playlists.flatMap((p) => p.tracks)]) if (t.author) known.add(t.author);
  return {
    top,
    followed: lib.followedArtists.map((a) => a.name).slice(0, 8),
    known: [...known].slice(0, 3000),
    hiddenArtists: Object.entries(lib.hiddenArtists).filter(([, v]) => v.at > 0).map(([k]) => k),
    hiddenTracks: Object.entries(lib.hiddenTracks).filter(([, v]) => v.at > 0).map(([k]) => k),
  };
}

export async function loadReco(force = false) {
  const st = useReco.getState();
  if (st.loading || (!force && st.data && Date.now() - st.loadedAt < 3 * 3600 * 1000)) return;
  const body = seeds();
  if (!body.top.length && !body.followed.length) { useReco.setState({ data: { mixes: [], discover: null, radar: [], seeds: [] }, loadedAt: Date.now() }); return; }
  useReco.setState({ loading: true });
  try {
    useReco.setState({ data: await api.reco(body), loadedAt: Date.now() });
  } catch {
    // Deezer unavailable: the home page simply shows no recommendations this time.
  } finally {
    useReco.setState({ loading: false });
  }
}

export const findMix = (id: string | undefined): Mix | undefined => {
  const d = useReco.getState().data;
  return d ? [...d.mixes, ...(d.discover ? [d.discover] : [])].find((m) => m.id === id) : undefined;
};
