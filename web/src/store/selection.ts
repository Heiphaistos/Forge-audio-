import { create } from 'zustand';
import type { Track } from '../lib/types';

/**
 * Multi-select in a track list (Spotify-like): Ctrl/Cmd+click toggles, Shift+click selects a range,
 * a long press starts it on touch screens, and « Sélectionner » in the list header for everyone.
 * One list at a time (`key`); the selection bar acts on `picked` (SelectionBar.tsx).
 */
interface SelectionState {
  key: string | null;
  /** Tracks of the list being selected in (for « Tout sélectionner » and ranges). */
  all: Track[];
  playlistId?: string;
  picked: number[];
  anchor: number;
  start: (key: string, all: Track[], playlistId?: string, index?: number) => void;
  toggle: (index: number) => void;
  range: (index: number) => void;
  selectAll: () => void;
  clear: () => void;
  setAll: (all: Track[]) => void;
}

export const useSelection = create<SelectionState>()((set, get) => ({
  key: null,
  all: [],
  picked: [],
  anchor: -1,
  start: (key, all, playlistId, index) => set({ key, all, playlistId, picked: index === undefined ? [] : [index], anchor: index ?? -1 }),
  toggle: (i) => {
    const picked = get().picked.includes(i) ? get().picked.filter((x) => x !== i) : [...get().picked, i];
    set({ picked, anchor: i });
  },
  range: (i) => {
    const a = get().anchor < 0 ? i : get().anchor;
    const [lo, hi] = a < i ? [a, i] : [i, a];
    const picked = new Set(get().picked);
    for (let k = lo; k <= hi; k++) picked.add(k);
    set({ picked: [...picked] });
  },
  selectAll: () => set({ picked: get().all.map((_, i) => i) }),
  clear: () => set({ key: null, all: [], picked: [], anchor: -1, playlistId: undefined }),
  setAll: (all) => {
    // The list changed under the selection (filter, sort, live edit): keep indexes that still exist.
    const n = all.length;
    set({ all, picked: get().picked.filter((i) => i < n) });
  },
}));

export const pickedTracks = () => {
  const { picked, all } = useSelection.getState();
  return [...picked].sort((a, b) => a - b).map((i) => all[i]).filter(Boolean);
};
