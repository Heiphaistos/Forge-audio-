import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Playlist, Track, HistoryEntry } from '../lib/types';
import { uid } from '../lib/format';

const HISTORY_MAX = 300;

/** Strip runtime-only fields before storing a track. */
export function slimTrack(t: Track): Track {
  return { id: t.id, title: t.title, url: t.url, duration: t.duration, thumbnail: t.thumbnail, author: t.author, album: t.album ?? null, source: t.source, isLive: !!t.isLive };
}

interface LibraryState {
  playlists: Playlist[];
  liked: Track[];
  history: HistoryEntry[];
  playCounts: Record<string, number>;
  createPlaylist: (name: string, tracks?: Track[], extra?: Partial<Playlist>) => Playlist;
  updatePlaylist: (id: string, patch: Partial<Pick<Playlist, 'name' | 'description' | 'cover'>>) => void;
  deletePlaylist: (id: string) => void;
  duplicatePlaylist: (id: string) => void;
  addToPlaylist: (id: string, tracks: Track[]) => number;
  removeFromPlaylist: (id: string, index: number) => void;
  movePlaylistTrack: (id: string, from: number, to: number) => void;
  toggleLike: (track: Track) => boolean;
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

      createPlaylist: (name, tracks = [], extra = {}) => {
        const now = Date.now();
        const pl: Playlist = {
          id: uid(), name: name.trim() || 'Nouvelle playlist', description: '', cover: null, sourceUrl: null,
          ...extra, tracks: tracks.map(slimTrack), createdAt: now, updatedAt: now,
        };
        set({ playlists: [pl, ...get().playlists] });
        return pl;
      },

      updatePlaylist: (id, patch) => set({
        playlists: get().playlists.map((p) => (p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p)),
      }),

      deletePlaylist: (id) => set({ playlists: get().playlists.filter((p) => p.id !== id) }),

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
            const fresh = tracks.filter((t) => !have.has(t.url) && have.add(t.url)).map(slimTrack);
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
        const liked = get().liked;
        const exists = liked.some((t) => t.url === track.url);
        set({ liked: exists ? liked.filter((t) => t.url !== track.url) : [slimTrack(track), ...liked] });
        return !exists;
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
        const likedUrls = new Set(get().liked.map((t) => t.url));
        const liked: Track[] = (data.liked || []).filter((t: Track) => valid(t) && !likedUrls.has(t.url)).map(slimTrack);
        set({ playlists: [...incoming, ...get().playlists], liked: [...get().liked, ...liked] });
        return { playlists: incoming.length, liked: liked.length };
      },
    }),
    { name: 'forge.library', version: 1 },
  ),
);

export const useIsLiked = (url: string | undefined) => useLibrary((s) => !!url && s.liked.some((t) => t.url === url));
