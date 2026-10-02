import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { lazyStorage } from '../lib/storage';
import type { Track } from '../lib/types';
import { EQ_PRESETS } from '../audio/engine';

export type ViewName = 'home' | 'search' | 'library' | 'playlist' | 'shared' | 'liked' | 'history' | 'settings' | 'artist' | 'album' | 'mix' | 'stats' | 'blend' | 'genre' | 'friends' | 'messages' | 'profile' | 'radio' | 'artists' | 'offline';

export interface View {
  name: ViewName;
  id?: string;
  q?: string;
}

export type Panel = 'queue' | 'lyrics' | 'video' | 'friends' | null;

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
  /** Button in the toast (e.g. « Rejoindre » for a Jam invitation). */
  action?: { label: string; run: () => void };
}

export interface MenuState {
  x: number;
  y: number;
  track: Track;
  /** When opened from a playlist, allows "remove from this playlist". */
  playlistId?: string;
  index?: number;
  /** When opened from the queue. */
  queueIndex?: number;
}

interface UiState {
  view: View;
  back: View[];
  forward: View[];
  panel: Panel;
  nowPlaying: boolean;
  /** Floating reduced video player. */
  miniVideo: boolean;
  eqOpen: boolean;
  jamOpen: boolean;
  pickerTracks: Track[] | null;
  menu: MenuState | null;
  toasts: Toast[];
  sidebarOpen: boolean;
  navigate: (view: View) => void;
  goBack: () => void;
  goForward: () => void;
  togglePanel: (p: Exclude<Panel, null>) => void;
  setPanel: (p: Panel) => void;
  setNowPlaying: (v: boolean) => void;
  setMiniVideo: (v: boolean) => void;
  setEqOpen: (v: boolean) => void;
  setJamOpen: (v: boolean) => void;
  openPicker: (tracks: Track[] | null) => void;
  openMenu: (m: MenuState | null) => void;
  toast: (text: string, kind?: Toast['kind'], action?: Toast['action']) => void;
  dismiss: (id: number) => void;
  setSidebarOpen: (v: boolean) => void;
}

let toastId = 0;

export const useUi = create<UiState>()((set, get) => ({
  view: { name: 'home' },
  back: [],
  forward: [],
  panel: null,
  nowPlaying: false,
  miniVideo: false,
  eqOpen: false,
  jamOpen: false,
  pickerTracks: null,
  menu: null,
  toasts: [],
  sidebarOpen: false,

  navigate: (view) => {
    const cur = get().view;
    // Same page: only close the phone menu (it stayed open over the page).
    if (cur.name === view.name && cur.id === view.id && cur.q === view.q) { if (get().sidebarOpen) set({ sidebarOpen: false }); return; }
    // Consecutive searches replace each other instead of piling up in history.
    const replace = cur.name === 'search' && view.name === 'search';
    set({ view, back: replace ? get().back : [...get().back, cur].slice(-50), forward: [], nowPlaying: false, sidebarOpen: false });
    document.querySelector('.main-scroll')?.scrollTo({ top: 0 });
  },
  goBack: () => {
    const back = [...get().back];
    const prev = back.pop();
    if (prev) set({ view: prev, back, forward: [get().view, ...get().forward] });
  },
  goForward: () => {
    const [next, ...forward] = get().forward;
    if (next) set({ view: next, forward, back: [...get().back, get().view] });
  },
  // Only one video at a time: opening the video panel closes the reduced player and vice versa.
  togglePanel: (p) => set({ panel: get().panel === p ? null : p, miniVideo: p === 'video' ? false : get().miniVideo }),
  setPanel: (panel) => set({ panel, miniVideo: panel === 'video' ? false : get().miniVideo }),
  setMiniVideo: (miniVideo) => set({ miniVideo, panel: miniVideo && get().panel === 'video' ? null : get().panel, nowPlaying: miniVideo ? false : get().nowPlaying }),
  setNowPlaying: (nowPlaying) => set({ nowPlaying }),
  setEqOpen: (eqOpen) => set({ eqOpen }),
  setJamOpen: (jamOpen) => set({ jamOpen }),
  openPicker: (pickerTracks) => set({ pickerTracks, menu: null }),
  openMenu: (menu) => set({ menu }),
  toast: (text, kind = 'info', action) => {
    const id = ++toastId;
    set({ toasts: [...get().toasts.slice(-3), { id, text, kind, action }] });
    setTimeout(() => get().dismiss(id), action ? 20000 : kind === 'error' ? 6000 : 3500);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
}));

export const ACCENTS: Record<string, string> = {
  Braise: '255, 106, 26',
  Rubis: '230, 57, 70',
  Améthyste: '157, 107, 255',
  Océan: '46, 144, 250',
  Menthe: '29, 205, 132',
  Or: '245, 185, 40',
  Rose: '255, 92, 170',
};

interface SettingsState {
  accent: string;
  defaultSource: string;
  visualizer: boolean;
  dynamicColors: boolean;
  eqEnabled: boolean;
  eqPreset: string;
  eqGains: number[];
  autoplay: boolean;
  /** Crossfade between tracks, in seconds (0 = off). */
  crossfade: number;
  gapless: boolean;
  /** « Volume harmonisé »: turn loud tracks down to the same level. */
  normalize: boolean;
  quality: 'high' | 'normal' | 'low';
  /** Data saver: low quality and no prefetch — on mobile data only (auto), always, or never. */
  dataSaver: 'off' | 'auto' | 'on';
  /** Friends see what I play and can make a Blend with me. */
  shareActivity: boolean;
  /** Lyrics shown under the clip (right panel, full-screen player). Per device. */
  clipLyrics: boolean;
  set: (patch: Partial<Omit<SettingsState, 'set'>>) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      accent: 'Braise',
      defaultSource: 'all',
      visualizer: false,
      dynamicColors: true,
      eqEnabled: true,
      eqPreset: 'Plat',
      eqGains: EQ_PRESETS.Plat,
      autoplay: true,
      crossfade: 0,
      gapless: true,
      normalize: true,
      quality: 'high',
      dataSaver: 'auto',
      shareActivity: true,
      clipLyrics: false,
      set: (patch) => set(patch),
    }),
    {
      name: 'forge.settings',
      version: 2,
      storage: lazyStorage,
      // v2: the visualizer needs the Web Audio chain (source of hiss/stutter on some outputs), so it is now opt-in.
      migrate: (state, version) => (version < 2 ? { ...(state as object), visualizer: false } : state) as SettingsState,
    },
  ),
);
