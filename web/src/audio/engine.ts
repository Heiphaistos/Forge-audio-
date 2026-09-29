import { api } from '../lib/api';
import type { Playback, Track } from '../lib/types';

export const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const EQ_PRESETS: Record<string, number[]> = {
  Plat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Basses +': [7, 6, 5, 3, 1, 0, 0, 0, 0, 0],
  'Aigus +': [0, 0, 0, 0, 0, 1, 3, 5, 6, 7],
  Vocal: [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1],
  Rock: [5, 4, 2, 0, -1, 0, 2, 3, 4, 4],
  Électro: [6, 5, 2, 0, -2, 1, 0, 2, 4, 5],
  'Hip-hop': [6, 5, 3, 1, -1, -1, 1, 0, 2, 3],
  Acoustique: [3, 3, 2, 1, 2, 2, 3, 3, 2, 1],
  Classique: [4, 3, 2, 1, 0, 0, 0, 1, 2, 3],
  Loudness: [6, 4, 0, 0, -2, 0, -1, 0, 4, 6],
};

type Listener = () => void;
type MediaEventName = keyof HTMLMediaElementEventMap;

const FADE_MS = 140;

/**
 * Audio playback.
 *
 * By default the <audio> element plays straight to the system mixer: no Web Audio, no resampling,
 * no extra thread. A running AudioContext keeps the sound card open (audible hiss/hum on many
 * outputs) and its MediaElementSource bridge crackles and stutters as soon as the page is busy,
 * so the effects chain (10-band EQ + analyser) is only built while the user actually uses it.
 * Turning effects off swaps in a fresh element at the next track and closes the context.
 *
 * Streams that are not seekable by HTTP Range (HLS sources transcoded by the server)
 * are restarted with `?start=` and tracked with an offset.
 */
class AudioEngine {
  private el: HTMLAudioElement;
  private ctx: AudioContext | null = null;
  private filters: BiquadFilterNode[] = [];
  private gain: GainNode | null = null;
  analyser: AnalyserNode | null = null;
  private wantEffects = false;
  private eq: number[] = EQ_PRESETS.Plat;
  private eqEnabled = true;
  private offset = 0;
  private playback: Playback | null = null;
  private track: Track | null = null;
  private loadToken = 0;
  private volume = 1;
  private fadeTimer: ReturnType<typeof setInterval> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private prefetched = new Map<string, { at: number; promise: Promise<Playback> }>();
  private listeners = new Set<Listener>();
  private mediaListeners: [MediaEventName, EventListener][] = [];

  constructor() {
    this.el = this.createElement();
  }

  private createElement() {
    const el = new Audio();
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    el.preservesPitch = true;
    // Release the sound card shortly after playback stops (effects mode only; pure mode releases on its own).
    const sleep = () => {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => { if (el.paused && this.ctx?.state === 'running') this.ctx.suspend().catch(() => {}); }, 1500);
    };
    for (const e of ['pause', 'ended', 'emptied', 'error'] as const) el.addEventListener(e, sleep);
    el.addEventListener('play', () => { clearTimeout(this.idleTimer); if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {}); });
    for (const [name, fn] of this.mediaListeners) el.addEventListener(name, fn);
    return el;
  }

  /** The current media element (it can change when the effects chain is switched off). */
  get audio() {
    return this.el;
  }

  /** Listen to media events on whichever element is current. */
  on(name: MediaEventName, fn: EventListener) {
    this.mediaListeners.push([name, fn]);
    this.el.addEventListener(name, fn);
  }

  get paused() {
    return this.el.paused;
  }

  get hasSource() {
    return !!this.el.getAttribute('src');
  }

  // ---------- effects chain ----------

  /** Whether EQ / visualizer need the Web Audio chain. Enabling builds it now; disabling takes effect at the next track. */
  setEffects(want: boolean) {
    this.wantEffects = want;
    if (want && !this.ctx && this.userActivated) this.buildGraph();
    if (!want && this.ctx && this.el.paused) this.dropGraph();
  }

  private userActivated = false;

  private buildGraph() {
    try {
      const ctx = new AudioContext({ latencyHint: 'playback' });
      const source = ctx.createMediaElementSource(this.el);
      this.filters = EQ_BANDS.map((freq, i) => {
        const f = ctx.createBiquadFilter();
        f.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
        f.frequency.value = freq;
        f.Q.value = 1.1;
        return f;
      });
      this.gain = ctx.createGain();
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;
      let node: AudioNode = source;
      for (const f of this.filters) { node.connect(f); node = f; }
      node.connect(this.gain);
      this.gain.connect(this.analyser);
      this.analyser.connect(ctx.destination);
      this.ctx = ctx;
      this.applyEq(true);
      if (this.el.paused) ctx.suspend().catch(() => {});
    } catch {
      this.ctx = null;
      this.analyser = null;
    }
  }

  /** Close the context and move playback to a fresh element (a MediaElementSource cannot be detached). */
  private dropGraph() {
    const old = this.el;
    const src = old.getAttribute('src');
    const time = old.currentTime;
    const rate = old.playbackRate;
    const wasPlaying = !old.paused;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.filters = [];
    this.gain = null;
    this.analyser = null;
    for (const [name, fn] of this.mediaListeners) old.removeEventListener(name, fn);
    old.pause();
    old.removeAttribute('src');
    old.load();
    this.el = this.createElement();
    this.el.volume = this.volume;
    this.el.muted = old.muted;
    this.el.playbackRate = rate;
    if (src) {
      this.el.src = src;
      if (time > 0) this.el.addEventListener('loadedmetadata', () => { this.el.currentTime = time; }, { once: true });
      if (wasPlaying) this.el.play().catch(() => {});
    }
  }

  private applyEq(immediate = false) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Smooth parameter changes: instant jumps produce audible "zipper" clicks.
    const set = (p: AudioParam, v: number) => (immediate ? (p.value = v) : p.setTargetAtTime(v, now, 0.03));
    this.filters.forEach((f, i) => set(f.gain, this.eqEnabled ? this.eq[i] ?? 0 : 0));
    // Keep headroom when boosting to avoid clipping.
    const maxBoost = this.eqEnabled ? Math.max(0, ...this.eq) : 0;
    if (this.gain) set(this.gain.gain, Math.pow(10, -maxBoost / 20));
  }

  setEq(gains: number[], enabled = true) {
    this.eq = gains;
    this.eqEnabled = enabled;
    this.applyEq();
  }

  // ---------- state listeners ----------

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  // ---------- resolution ----------

  /** Resolve (with a short cache) how to play a track. */
  resolve(track: Track): Promise<Playback> {
    if (track.source === 'local' || track.url.startsWith('blob:')) {
      return Promise.resolve({ src: track.url, seekable: true, duration: track.duration, isLive: false, mime: 'audio/*' });
    }
    const hit = this.prefetched.get(track.url);
    if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.promise;
    const promise = api.playback(track.url, 'audio');
    this.prefetched.set(track.url, { at: Date.now(), promise });
    promise.catch(() => this.prefetched.delete(track.url));
    if (this.prefetched.size > 50) this.prefetched.delete(this.prefetched.keys().next().value!);
    return promise;
  }

  prefetch(track: Track | undefined) {
    if (track && !track.isLive) this.resolve(track).catch(() => {});
  }

  forget(track: Track) {
    this.prefetched.delete(track.url);
  }

  // ---------- transport ----------

  /** Called from user gestures: browsers only allow audio contexts after one. */
  private activate() {
    this.userActivated = true;
    if (this.wantEffects && !this.ctx) this.buildGraph();
    if (!this.wantEffects && this.ctx) this.dropGraph();
  }

  /** Load a track; resolves once the source is set (playback may still be buffering). */
  async load(track: Track, { autoplay = true, startAt = 0 } = {}) {
    const token = ++this.loadToken;
    this.activate();
    this.el.pause();
    this.track = track;
    this.playback = null;
    this.offset = 0;
    this.emit();
    const pb = await this.resolve(track);
    if (token !== this.loadToken) return false;
    this.playback = pb;
    this.setSource(startAt);
    if (autoplay) await this.play();
    return true;
  }

  private setSource(startAt: number) {
    const pb = this.playback;
    if (!pb) return;
    const el = this.el;
    const rate = el.playbackRate;
    if (pb.seekable) {
      this.offset = 0;
      el.src = pb.src;
      if (startAt > 0) el.addEventListener('loadedmetadata', () => { el.currentTime = startAt; }, { once: true });
    } else {
      this.offset = pb.isLive ? 0 : startAt;
      el.src = startAt > 0 && !pb.isLive ? `${pb.src}&start=${Math.floor(startAt)}` : pb.src;
    }
    el.playbackRate = rate;
  }

  /** Ramp the element volume to avoid clicks on play / pause. */
  private fade(to: number, done?: () => void) {
    clearInterval(this.fadeTimer);
    const el = this.el;
    const from = el.volume;
    const steps = Math.max(1, Math.round(FADE_MS / 16));
    let i = 0;
    this.fadeTimer = setInterval(() => {
      i += 1;
      el.volume = Math.max(0, Math.min(1, from + ((to - from) * i) / steps));
      if (i >= steps) {
        clearInterval(this.fadeTimer);
        done?.();
      }
    }, 16);
  }

  async play() {
    this.activate();
    if (!this.el.getAttribute('src') && this.track) {
      await this.load(this.track, { autoplay: true });
      return;
    }
    clearInterval(this.fadeTimer);
    const fadeIn = this.el.currentTime > 0.2;
    if (fadeIn) this.el.volume = 0;
    try {
      await this.el.play();
    } catch (err) {
      this.el.volume = this.volume;
      if ((err as DOMException).name !== 'AbortError') throw err;
      return;
    }
    if (fadeIn) this.fade(this.volume); else this.el.volume = this.volume;
  }

  pause() {
    if (this.el.paused) return;
    const el = this.el;
    this.fade(0, () => { el.pause(); el.volume = this.volume; });
  }

  stop() {
    this.loadToken += 1;
    clearInterval(this.fadeTimer);
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.track = null;
    this.playback = null;
    this.emit();
  }

  get currentTrack() {
    return this.track;
  }

  get currentTime() {
    return this.offset + (this.el.currentTime || 0);
  }

  get duration(): number | null {
    if (this.playback?.isLive) return null;
    if (this.playback?.seekable && Number.isFinite(this.el.duration)) return this.el.duration;
    return this.playback?.duration ?? this.track?.duration ?? null;
  }

  get seekable() {
    return !!this.playback && !this.playback.isLive;
  }

  get isLive() {
    return !!this.playback?.isLive;
  }

  seek(time: number) {
    if (!this.playback || this.playback.isLive) return;
    const t = Math.max(0, Math.min(time, (this.duration ?? time) - 0.25));
    if (this.playback.seekable) {
      this.el.currentTime = t;
    } else {
      const wasPlaying = !this.el.paused;
      this.setSource(t);
      if (wasPlaying) this.el.play().catch(() => {});
    }
    this.emit();
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    clearInterval(this.fadeTimer);
    this.el.volume = this.volume;
  }

  setMuted(m: boolean) {
    this.el.muted = m;
  }

  setRate(r: number) {
    this.el.playbackRate = r;
  }
}

export const engine = new AudioEngine();
