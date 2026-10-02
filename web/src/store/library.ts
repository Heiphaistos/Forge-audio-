import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { lazyStorage } from '../lib/storage';
import type { Artist, HiddenEntry, Playlist, RadioStation, Track, HistoryEntry } from '../lib/types';
import { uid } from '../lib/format';
import { artistKey } from '../lib/merge';
import { api } from '../lib/api';

const HISTORY_MAX = 1000;

/** Strip runtime-only fields before storing a track. */
export function slimTrack(t: Track): Track {
  const out: Track = { id: t.id, title: t.title, url: t.url, duration: t.duration, thumbnail: t.thumbnail, author: t.author, album: t.album ?? null, source: t.source, isLive: !!t.isLive };
  if (t.addedAt) out.addedAt = t.addedAt;
  return out;
}

const stamp = (t: Track, at: number): Track => ({ ...slimTrack(t), addedAt: at });

export { artistKey };

interface LibraryState {
  playlists: Playlist[];
  liked: Track[];
  history: HistoryEntry[];
  playCounts: Record<string, number>;
  /** Deleted playlist ids → time, so a deletion is not undone by merging with another device. */
  deletedPlaylists: Record<string, number>;
  /** Un-liked track urls → time (same reason). */
  unliked: Record<string, number>;
  followedArtists: Artist[];
  /** Unfollowed artist keys → time. */
  unfollowed: Record<string, number>;
  /** Tracks (by url) and artists (by artistKey) left out of radio, autoplay and recommendations. */
  hiddenTracks: Record<string, HiddenEntry>;
  hiddenArtists: Record<string, HiddenEntry>;
  /** Radio stations: favourites (+ removal times, like `unliked`) and the last 50 played. */
  radioFavorites: RadioStation[];
  radioUnfavorited: Record<string, number>;
  radioRecent: RadioStation[];
  toggleRadioFavorite: (s: RadioStation) => boolean;
  pushRadioRecent: (s: RadioStation) => void;
  createPlaylist: (name: string, tracks?: Track[], extra?: Partial<Playlist>) => Playlist;
  updatePlaylist: (id: string, patch: Partial<Pick<Playlist, 'name' | 'description' | 'cover' | 'folder' | 'pinned' | 'onProfile'>>) => void;
  /** Several playlists (and/or tracks such as the liked ones) into a new one, duplicates removed. */
  mergeIntoNew: (name: string, sources: Track[][], removeIds?: string[]) => Playlist;
  setHidden: (kind: 'track' | 'artist', key: string, label: string, hidden: boolean) => void;
  deletePlaylist: (id: string) => void;
  duplicatePlaylist: (id: string) => void;
  addToPlaylist: (id: string, tracks: Track[]) => number;
  removeFromPlaylist: (id: string, index: number) => void;
  movePlaylistTrack: (id: string, from: number, to: number) => void;
  toggleLike: (track: Track) => boolean;
  /** Like several tracks at once; returns how many were not liked yet. */
  likeTracks: (tracks: Track[]) => number;
  toggleFollow: (name: string, thumbnail?: string | null) => boolean;
  pushHistory: (track: Track) => void;
  clearHistory: () => void;
  exportData: () => string;
  importData: (json: string) => { playlists: number; liked: number };
}

export const useLibrary = create<LibraryState>()(
  persist(
    (set, get) => ({
      playlists: [],
      liked: [],
      history: [],
      playCounts: {},
      deletedPlaylists: {},
      unliked: {},
      followedArtists: [],
      unfollowed: {},
      hiddenTracks: {},
      hiddenArtists: {},
      radioFavorites: [],
      radioUnfavorited: {},
      radioRecent: [],

      toggleRadioFavorite: (s) => {
        const list = get().radioFavorites;
        if (list.some((x) => x.id === s.id)) {
          set({ radioFavorites: list.filter((x) => x.id !== s.id), radioUnfavorited: { ...get().radioUnfavorited, [s.id]: Date.now() } });
          return false;
        }
        const radioUnfavorited = { ...get().radioUnfavorited };
        delete radioUnfavorited[s.id];
        set({ radioFavorites: [{ ...s, at: Date.now() }, ...list], radioUnfavorited });
        return true;
      },

      pushRadioRecent: (s) => set({ radioRecent: [{ ...s, at: Date.now() }, ...get().radioRecent.filter((x) => x.id !== s.id)].slice(0, 50) }),

      createPlaylist: (name, tracks = [], extra = {}) => {
        const now = Date.now();
        const pl: Playlist = {
          id: uid(), name: name.trim() || 'Nouvelle playlist', description: '', cover: null, sourceUrl: null,
          ...extra, tracks: tracks.map((t) => stamp(t, now)), createdAt: now, updatedAt: now,
        };
        set({ playlists: [pl, ...get().playlists] });
        return pl;
      },

      updatePlaylist: (id, patch) => set({
        playlists: get().playlists.map((p) => (p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p)),
      }),

      deletePlaylist: (id) => set({
        playlists: get().playlists.filter((p) => p.id !== id),
        deletedPlaylists: { ...get().deletedPlaylists, [id]: Date.now() },
      }),

      mergeIntoNew: (name, sources, removeIds = []) => {
        const seen = new Set<string>();
        const tracks = sources.flat().filter((t) => t.source !== 'local' && !seen.has(t.url) && seen.add(t.url));
        const pl = get().createPlaylist(name, tracks);
        for (const id of removeIds) get().deletePlaylist(id);
        return pl;
      },

      setHidden: (kind, key, label, hidden) => {
        const field = kind === 'track' ? 'hiddenTracks' : 'hiddenArtists';
        set({ [field]: { ...get()[field], [key]: { at: hidden ? Date.now() : -Date.now(), label } } } as Partial<LibraryState>);
      },

      duplicatePlaylist: (id) => {
        const src = get().playlists.find((p) => p.id === id);
        if (src) get().createPlaylist(`${src.name} (copie)`, src.tracks, { description: src.description, cover: src.cover });
      },

      addToPlaylist: (id, tracks) => {
        let added = 0;
        set({
          playlists: get().playlists.map((p) => {
            if (p.id !== id) return p;
            const have = new Set(p.tracks.map((t) => t.url));
            const now = Date.now();
            const fresh = tracks.filter((t) => !have.has(t.url) && have.add(t.url)).map((t) => stamp(t, now));
            added = fresh.length;
            return { ...p, tracks: [...p.tracks, ...fresh], updatedAt: Date.now() };
          }),
        });
        return added;
      },

      removeFromPlaylist: (id, index) => set({
        playlists: get().playlists.map((p) => (p.id === id ? { ...p, tracks: p.tracks.filter((_, i) => i !== index), updatedAt: Date.now() } : p)),
      }),

      movePlaylistTrack: (id, from, to) => set({
        playlists: get().playlists.map((p) => {
          if (p.id !== id || from === to) return p;
          const tracks = [...p.tracks];
          const [moved] = tracks.splice(from, 1);
          tracks.splice(to, 0, moved);
          return { ...p, tracks, updatedAt: Date.now() };
        }),
      }),

      toggleLike: (track) => {
        if (get().liked.some((t) => t.url === track.url)) {
          set({ liked: get().liked.filter((t) => t.url !== track.url), unliked: { ...get().unliked, [track.url]: Date.now() } });
          return false;
        }
        get().likeTracks([track]);
        return true;
      },

      likeTracks: (tracks) => {
        const have = new Set(get().liked.map((t) => t.url));
        const now = Date.now();
        // Newest first, like Spotify; the first track of a batch ends up on top.
        const fresh = tracks.filter((t) => t.source !== 'local' && !have.has(t.url) && have.add(t.url)).map((t, i) => stamp(t, now - i));
        if (!fresh.length) return 0;
        const unliked = { ...get().unliked };
        for (const t of fresh) delete unliked[t.url];
        set({ liked: [...fresh, ...get().liked], unliked });
        return fresh.length;
      },

      toggleFollow: (name, thumbnail = null) => {
        const key = artistKey(name);
        const list = get().followedArtists;
        if (list.some((a) => artistKey(a.name) === key)) {
          set({ followedArtists: list.filter((a) => artistKey(a.name) !== key), unfollowed: { ...get().unfollowed, [key]: Date.now() } });
          return false;
        }
        const unfollowed = { ...get().unfollowed };
        delete unfollowed[key];
        set({ followedArtists: [{ name: name.trim(), thumbnail, at: Date.now() }, ...list], unfollowed });
        return true;
      },

      pushHistory: (track) => {
        const history = get().history.filter((h, i) => !(i === 0 && h.track.url === track.url));
        set({
          history: [{ track: slimTrack(track), at: Date.now() }, ...history].slice(0, HISTORY_MAX),
          playCounts: { ...get().playCounts, [track.url]: (get().playCounts[track.url] || 0) + 1 },
        });
      },

      clearHistory: () => set({ history: [] }),

      exportData: () => {
        const { playlists, liked } = get();
        return JSON.stringify({ app: 'forge-audio', version: 1, exportedAt: new Date().toISOString(), playlists, liked }, null, 2);
      },

      importData: (json) => {
        const data = JSON.parse(json);
        if (!data || (data.app !== 'forge-audio' && !Array.isArray(data.playlists))) throw new Error('Fichier non reconnu');
        const valid = (t: Track) => t && typeof t.url === 'string' && typeof t.title === 'string';
        const incoming: Playlist[] = (data.playlists || []).filter((p: Playlist) => p && typeof p.name === 'string' && Array.isArray(p.tracks))
          .map((p: Playlist) => ({ ...p, id: uid(), tracks: p.tracks.filter(valid).map(slimTrack), createdAt: p.createdAt || Date.now(), updatedAt: Date.now() }));
        set({ playlists: [...incoming, ...get().playlists] });
        const liked = get().likeTracks((data.liked || []).filter(valid));
        return { playlists: incoming.length, liked };
      },
    }),
    { name: 'forge.library', version: 1, storage: lazyStorage },
  ),
);

/** Spotify playlist imports used to give every track the playlist's image (ab67706c…) instead of its album art (ab67616d…). */
const wrongSpotifyCover = (t: Track) => /^https:\/\/open\.spotify\.com\/track\//.test(t.url) && !/ab67616d/.test(t.thumbnail || '');

/** Put the real album art on the Spotify tracks of the library (likes and playlists); run once after the library loads. */
export async function repairSpotifyCovers() {
  const { liked, playlists } = useLibrary.getState();
  const urls = [...new Set([...liked, ...playlists.flatMap((p) => p.tracks)].filter(wrongSpotifyCover).map((t) => t.url))];
  if (!urls.length) return;
  const covers: Record<string, string> = {};
  for (let i = 0; i < urls.length; i += 200) Object.assign(covers, (await api.spotifyCovers(urls.slice(i, i + 200))).covers);
  if (!Object.keys(covers).length) return;
  const fix = (t: Track) => (covers[t.url] ? { ...t, thumbnail: covers[t.url] } : t);
  useLibrary.setState((s) => ({
    liked: s.liked.map(fix),
    playlists: s.playlists.map((p) => (p.tracks.some((t) => covers[t.url]) ? { ...p, tracks: p.tracks.map(fix), updatedAt: Date.now() } : p)),
  }));
}

export const useIsLiked = (url: string | undefined) => useLibrary((s) => !!url && s.liked.some((t) => t.url === url));
/** Left out of radio / autoplay / recommendations? */
export function isHidden(t: Track) {
  const { hiddenTracks, hiddenArtists } = useLibrary.getState();
  return (hiddenTracks[t.url]?.at || 0) > 0 || (!!t.author && (hiddenArtists[artistKey(t.author)]?.at || 0) > 0);
}
export const useIsRadioFavorite = (id: string | undefined) => useLibrary((s) => !!id && s.radioFavorites.some((x) => x.id === id));
export const useIsFollowed = (name: string | undefined) => useLibrary((s) => !!name && s.followedArtists.some((a) => artistKey(a.name) === artistKey(name)));
