import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { lazyStorage } from '../lib/storage';
import { engine } from '../audio/engine';
import { api } from '../lib/api';
import { shuffleArray } from '../lib/format';
import type { RepeatMode, Track } from '../lib/types';
import { useLibrary, slimTrack, isHidden } from './library';
import { useSettings, useUi } from './ui';
import { readResume, resumePoint, saveResume } from '../lib/resume';
import { useOffline } from './offline';

interface PlayerState {
  queue: Track[];
  index: number;
  shuffle: boolean;
  unshuffled: Track[] | null;
  repeat: RepeatMode;
  volume: number;
  muted: boolean;
  rate: number;
  playing: boolean;
  buffering: boolean;
  position: number;
  duration: number | null;
  error: string | null;
  sleepAt: number | null;
  sleepAfterTrack: boolean;
  radioLoading: boolean;

  playList: (tracks: Track[], start?: number, opts?: { shuffle?: boolean }) => void;
  playNow: (track: Track) => void;
  addNext: (tracks: Track[]) => void;
  enqueue: (tracks: Track[]) => void;
  removeAt: (i: number) => void;
  move: (from: number, to: number) => void;
  clearUpcoming: () => void;
  jumpTo: (i: number) => void;
  next: (auto?: boolean) => Promise<void>;
  prev: () => void;
  togglePlay: () => void;
  seek: (t: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setRate: (r: number) => void;
  setSleep: (minutes: number | 'track' | null) => void;
  startRadio: (track: Track) => Promise<void>;
  /** Jam: load a track of the (shared) queue at a position without going through the router. */
  jamLoad: (i: number, startAt: number, autoplay: boolean) => Promise<void>;
  /** Crossfade / gapless: start the next track while the current one ends. */
  crossNext: () => Promise<void>;
}

/**
 * Set while in a Jam (store/social.ts): playback and queue actions go to the shared session, whose
 * state then drives this player. Returns true when it handled the action.
 */
type JamOp = 'toggle' | 'next' | 'ended' | 'prev' | 'seek' | 'jump' | 'playNow' | 'addNext' | 'enqueue' | 'playList' | 'remove' | 'clear' | 'move' | 'blocked' | 'probe';
let jamRouter: ((op: JamOp, arg?: unknown) => boolean) | null = null;
export function setJamRouter(fn: typeof jamRouter) { jamRouter = fn; }
const jam = (op: JamOp, arg?: unknown) => !!jamRouter && jamRouter(op, arg);

let retriedUrl: string | null = null;
let historyPushedFor = -1;
let loadSeq = 0;

export const usePlayer = create<PlayerState>()(
  persist(
    (set, get) => {
      const toast = (text: string, kind?: 'info' | 'error' | 'success') => useUi.getState().toast(text, kind);

      /** Load queue[i] into the engine. */
      const loadIndex = async (i: number, { autoplay = true, startAt = 0, retry = false } = {}) => {
        const track = get().queue[i];
        if (!track) return;
        const seq = ++loadSeq;
        set({ index: i, position: startAt, duration: track.duration, error: null, buffering: true });
        try {
          await engine.load(track, { autoplay, startAt });
          if (seq === loadSeq && !autoplay) set({ buffering: false });
        } catch (err) {
          if (seq !== loadSeq) return;
          // No server: quietly go on with the next downloaded title (no error per missing one).
          const off = useOffline.getState();
          if (!off.online) {
            set({ error: null, buffering: false, playing: false });
            const j = get().queue.findIndex((t, k) => k > i && !!off.items[t.url]);
            if (autoplay && j > 0) loadIndex(j);
            else if (!off.items[track.url]) toast(`« ${track.title} » n’est pas disponible hors ligne`);
            return;
          }
          // A server hiccup on the first request (stream 502 while yt-dlp warms up) surfaces as
          // « no supported source »: resolve again once before giving up on the track.
          if (!retry && err instanceof DOMException && err.name === 'NotSupportedError') {
            engine.forget(track);
            return loadIndex(i, { autoplay, startAt, retry: true });
          }
          const message = track.source === 'radio' ? 'radio indisponible pour le moment'
            : err instanceof DOMException && err.name === 'NotSupportedError'
            ? 'format non pris en charge par ce navigateur'
            : err instanceof Error ? err.message : 'Lecture impossible';
          set({ error: message, buffering: false, playing: false });
          toast(`${track.title} : ${message}`, 'error');
          // Skip unreadable tracks automatically, but never loop forever on a broken queue.
          if (autoplay && i < get().queue.length - 1) setTimeout(() => { if (seq === loadSeq) loadIndex(i + 1); }, 1200);
          return;
        }
        engine.prefetch(get().queue[i + 1]);
      };

      return {
        queue: [],
        index: -1,
        shuffle: false,
        unshuffled: null,
        repeat: 'off',
        volume: 1,
        muted: false,
        rate: 1,
        playing: false,
        buffering: false,
        position: 0,
        duration: null,
        error: null,
        sleepAt: null,
        sleepAfterTrack: false,
        radioLoading: false,

        playList: (tracks, start = 0, opts = {}) => {
          if (!tracks.length) return;
          if (jam('playList', tracks.slice(start))) return;
          const list = tracks.map(slimTrack);
          if (opts.shuffle) {
            const first = list[start] && start > 0 ? list[start] : list[Math.floor(Math.random() * list.length)];
            const rest = shuffleArray(list.filter((t) => t !== first));
            set({ queue: [first, ...rest], unshuffled: list, shuffle: true });
            loadIndex(0);
          } else {
            set({ queue: list, unshuffled: null, shuffle: false });
            loadIndex(Math.max(0, Math.min(start, list.length - 1)));
          }
        },

        playNow: (track) => {
          if (jam('playNow', track)) return;
          const { queue, index } = get();
          if (index < 0 || !queue.length) {
            get().playList([track]);
            return;
          }
          const q = [...queue];
          q.splice(index + 1, 0, slimTrack(track));
          set({ queue: q });
          loadIndex(index + 1);
        },

        addNext: (tracks) => {
          if (jam('addNext', tracks)) return;
          const { queue, index } = get();
          if (index < 0) return get().playList(tracks);
          const q = [...queue];
          q.splice(index + 1, 0, ...tracks.map(slimTrack));
          set({ queue: q, unshuffled: get().unshuffled ? [...get().unshuffled!, ...tracks.map(slimTrack)] : null });
          engine.prefetch(q[index + 1]);
          toast(tracks.length > 1 ? `${tracks.length} titres lus ensuite` : `« ${tracks[0].title} » sera lu ensuite`, 'success');
        },

        enqueue: (tracks) => {
          if (jam('enqueue', tracks)) return;
          const { queue, index } = get();
          if (index < 0) return get().playList(tracks);
          set({ queue: [...queue, ...tracks.map(slimTrack)], unshuffled: get().unshuffled ? [...get().unshuffled!, ...tracks.map(slimTrack)] : null });
          toast(tracks.length > 1 ? `${tracks.length} titres ajoutés à la file` : `« ${tracks[0].title} » ajouté à la file`, 'success');
        },

        removeAt: (i) => {
          if (jam('remove', i)) return;
          const { queue, index } = get();
          if (i === index) return;
          set({ queue: queue.filter((_, j) => j !== i), index: i < index ? index - 1 : index });
        },

        move: (from, to) => {
          if (jam('move', { from, to })) return;
          const { queue, index } = get();
          if (from === to) return;
          const q = [...queue];
          const [m] = q.splice(from, 1);
          q.splice(to, 0, m);
          let idx = index;
          if (from === index) idx = to;
          else if (from < index && to >= index) idx -= 1;
          else if (from > index && to <= index) idx += 1;
          set({ queue: q, index: idx });
        },

        clearUpcoming: () => {
          if (jam('clear')) return;
          const { queue, index } = get();
          set({ queue: queue.slice(0, index + 1), unshuffled: null });
        },

        jumpTo: (i) => { if (!jam('jump', i)) loadIndex(i); },
        jamLoad: (i, startAt, autoplay) => loadIndex(i, { startAt, autoplay }),

        crossNext: async () => {
          // In a Jam every device follows the shared session: no local early start.
          if (jam('probe')) return;
          const { queue, index, repeat, sleepAfterTrack } = get();
          if (sleepAfterTrack || repeat === 'one') return;
          const i = index < queue.length - 1 ? index + 1 : repeat === 'all' ? 0 : -1;
          const track = queue[i];
          if (!track || track.isLive || !(await engine.crossfade(track))) return;
          const seq = ++loadSeq;
          historyPushedFor = seq;
          retriedUrl = null;
          set({ index: i, position: 0, duration: track.duration, error: null, buffering: false, playing: true });
          useLibrary.getState().pushHistory(track);
          engine.prefetch(get().queue[i + 1]);
        },

        next: async (auto = false) => {
          if (jam(auto ? 'ended' : 'next')) return;
          const { queue, index, repeat, sleepAfterTrack } = get();
          if (auto && sleepAfterTrack) {
            set({ sleepAfterTrack: false, playing: false });
            toast('Minuteur de sommeil : lecture arrêtée');
            return;
          }
          if (auto && repeat === 'one') {
            engine.seek(0);
            engine.play().catch(() => {});
            return;
          }
          if (index < queue.length - 1) return loadIndex(index + 1);
          if (repeat === 'all' && queue.length) return loadIndex(0);
          const current = queue[index];
          if (current && useSettings.getState().autoplay && useOffline.getState().online) {
            await get().startRadio(current);
            if (get().index < get().queue.length - 1) return loadIndex(get().index + 1);
          }
          set({ playing: false });
        },

        prev: () => {
          if (jam('prev')) return;
          const { index } = get();
          if (engine.currentTime > 4 || index <= 0) {
            engine.seek(0);
            return;
          }
          loadIndex(index - 1);
        },

        togglePlay: () => {
          if (jam('toggle')) return;
          const { queue, index } = get();
          if (!queue.length) return;
          if (!engine.currentTrack || engine.currentTrack.url !== queue[index]?.url) {
            // Reopened app: the track waits paused at its saved (or since moved) position.
            const i = Math.max(0, index);
            loadIndex(i, { startAt: i === index ? resumePoint(get().position, queue[i].duration, queue[i].isLive) : 0 });
            return;
          }
          if (engine.paused) engine.play().catch((err) => toast(err.message, 'error'));
          else engine.pause();
        },

        seek: (t) => {
          if (jam('seek', t)) return;
          engine.seek(t);
          set({ position: t });
          // Not loaded yet (reopened app, still paused): remember where to start from.
          const cur = get().queue[get().index];
          if (!engine.currentTrack && cur && !cur.isLive) saveResume(cur.url, t);
        },

        setVolume: (v) => {
          const volume = Math.max(0, Math.min(1, v));
          engine.setVolume(volume);
          set({ volume, muted: volume === 0 ? get().muted : false });
          engine.setMuted(volume === 0 ? get().muted : false);
        },

        toggleMute: () => {
          engine.setMuted(!get().muted);
          set({ muted: !get().muted });
        },

        toggleShuffle: () => {
          if (jam('blocked')) return;
          const { shuffle, queue, index, unshuffled } = get();
          const current = queue[index];
          if (!shuffle) {
            const rest = shuffleArray(queue.filter((_, i) => i !== index));
            set({ shuffle: true, unshuffled: queue, queue: current ? [current, ...rest] : rest, index: current ? 0 : -1 });
          } else {
            const base = unshuffled ?? queue;
            const known = new Set(base.map((t) => t.url));
            const restored = [...base, ...queue.filter((t) => !known.has(t.url))];
            const idx = current ? restored.findIndex((t) => t.url === current.url) : -1;
            set({ shuffle: false, unshuffled: null, queue: restored, index: idx });
          }
          engine.prefetch(get().queue[get().index + 1]);
        },

        cycleRepeat: () => {
          const order: RepeatMode[] = ['off', 'all', 'one'];
          set({ repeat: order[(order.indexOf(get().repeat) + 1) % order.length] });
        },

        setRate: (rate) => {
          engine.setRate(rate);
          set({ rate });
        },

        setSleep: (minutes) => {
          if (minutes === null) {
            set({ sleepAt: null, sleepAfterTrack: false });
            toast('Minuteur de sommeil désactivé');
          } else if (minutes === 'track') {
            set({ sleepAt: null, sleepAfterTrack: true });
            toast('La lecture s\'arrêtera à la fin du titre');
          } else {
            set({ sleepAt: Date.now() + minutes * 60_000, sleepAfterTrack: false });
            toast(`La lecture s'arrêtera dans ${minutes} min`);
          }
        },

        startRadio: async (track) => {
          set({ radioLoading: true });
          try {
            const { tracks } = await api.radio(track);
            const have = new Set(get().queue.map((t) => t.url));
            const fresh = tracks.filter((t) => !have.has(t.url) && !isHidden(t));
            if (fresh.length) {
              set({ queue: [...get().queue, ...fresh.map(slimTrack)] });
              toast(`Radio : ${fresh.length} titres ajoutés d'après « ${track.title} »`, 'success');
            }
          } catch (err) {
            toast(`Radio indisponible : ${(err as Error).message}`, 'error');
          } finally {
            set({ radioLoading: false });
          }
        },
      };
    },
    {
      name: 'forge.player',
      version: 3,
      storage: lazyStorage,
      // v2: the default volume was 0.8, i.e. -4 dB on the squared curve, and phones hide the slider (system volume
      // only): plugged into a car it could never be loud. The untouched default goes to full.
      // v3: the volume was synced from other devices; phones got stuck with a computer's low setting -> full again.
      migrate: (state, version) => {
        const s = state as { volume?: number };
        const phone = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
        return ((version < 2 && s.volume === 0.8) || (version < 3 && phone) ? { ...s, volume: 1 } : s) as never;
      },
      partialize: (s) => ({ queue: s.queue, index: s.index, shuffle: s.shuffle, unshuffled: s.unshuffled, repeat: s.repeat, volume: s.volume, muted: s.muted, rate: s.rate }),
    },
  ),
);

/** Wire audio element events to the store. Call once at startup. */
export function bindEngine() {
  const st = usePlayer.getState();
  engine.setVolume(st.volume);
  engine.setMuted(st.muted);
  engine.setRate(st.rate);
  restorePosition();

  let fallbackToldAt = 0;
  engine.onFallback = (track, source) => {
    if (Date.now() - fallbackToldAt < 30 * 60_000) return;
    fallbackToldAt = Date.now();
    useUi.getState().toast(`YouTube bloque le serveur en ce moment : « ${track.title} » est lu depuis ${source === 'soundcloud' ? 'SoundCloud' : 'Dailymotion'}.`, 'info');
  };

  let lastSave = 0;
  let crossedFor = -1;
  engine.on('timeupdate', () => {
    const position = engine.currentTime;
    const duration = engine.duration;
    usePlayer.setState({ position, duration });
    const w = engine.transitionWindow;
    if (w > 0 && duration && crossedFor !== loadSeq && duration > 2 * w + 5 && duration - position <= w) {
      crossedFor = loadSeq;
      usePlayer.getState().crossNext();
    }
    if (Date.now() - lastSave > 5000) savePosition();
  });
  const savePosition = () => {
    const track = engine.currentTrack;
    // Between two tracks (stream not resolved yet) the element still holds the previous one.
    if (!track || !(engine.seekable || engine.isLive)) return;
    lastSave = Date.now();
    saveResume(track.url, engine.isLive || track.isLive ? 0 : engine.currentTime);
  };
  engine.on('pause', savePosition);
  engine.on('seeked', savePosition);
  window.addEventListener('pagehide', savePosition);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') savePosition(); });
  engine.on('durationchange', () => usePlayer.setState({ duration: engine.duration }));
  engine.on('play', () => usePlayer.setState({ playing: true }));
  engine.on('pause', () => usePlayer.setState({ playing: false }));
  engine.on('waiting', () => usePlayer.setState({ buffering: true }));
  engine.on('playing', () => {
    usePlayer.setState({ buffering: false, error: null });
    const { index, queue } = usePlayer.getState();
    if (historyPushedFor !== loadSeq && queue[index]) {
      historyPushedFor = loadSeq;
      retriedUrl = null;
      useLibrary.getState().pushHistory(queue[index]);
    }
  });
  engine.on('ended', () => {
    // A radio whose server dropped the connection after playing a while: reconnect instead of moving on.
    const live = engine.currentTrack;
    if (live?.source === 'radio' && engine.currentTime > 10) {
      engine.load(live, { autoplay: true }).catch(() => {});
      return;
    }
    if (engine.currentTrack) saveResume(engine.currentTrack.url, 0);
    usePlayer.getState().next(true);
  });
  engine.on('error', () => {
    const track = engine.currentTrack;
    if (!track || !engine.hasSource) return;
    const at = engine.currentTime;
    if (!navigator.onLine) {
      // Network gone (computer waking from sleep, Wi-Fi switching): resume this track when it is back, don't skip it.
      usePlayer.setState({ buffering: true });
      window.addEventListener('online', () => {
        if (engine.currentTrack?.url === track.url) engine.load(track, { autoplay: true, startAt: at }).catch(() => {});
      }, { once: true });
      return;
    }
    if (retriedUrl !== track.url) {
      // Signed media URLs expire: resolve again and resume where we were.
      retriedUrl = track.url;
      engine.forget(track);
      engine.load(track, { autoplay: true, startAt: at }).catch(() => {});
      return;
    }
    usePlayer.setState({ error: 'Lecture impossible', buffering: false, playing: false });
    useUi.getState().toast(`Impossible de lire « ${track.title} », titre suivant…`, 'error');
    setTimeout(() => usePlayer.getState().next(false), 1500);
  });

  // Sleep timer
  setInterval(() => {
    const { sleepAt } = usePlayer.getState();
    if (sleepAt && Date.now() >= sleepAt) {
      usePlayer.setState({ sleepAt: null });
      engine.pause();
      useUi.getState().toast('Minuteur de sommeil : bonne nuit 🌙');
    }
  }, 1000);
}

/**
 * Put back the position saved for the current track (bar and time right, nothing loaded nor played
 * until the listener presses play). Also used when the synced library brings a newer one.
 */
export function restorePosition() {
  if (engine.currentTrack) return;
  const { queue, index } = usePlayer.getState();
  const track = queue[index];
  const saved = readResume();
  const position = track && saved?.url === track.url ? resumePoint(saved.t, track.duration, track.isLive) : 0;
  usePlayer.setState({ position, duration: track && !track.isLive ? track.duration ?? null : null });
}

export const useCurrentTrack = () => usePlayer((s) => s.queue[s.index]);
