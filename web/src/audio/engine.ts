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
/** « Volume harmonisé » target, like YouTube / Spotify « normal ». Quieter tracks are never boosted (no clipping). */
const TARGET_LUFS = -14;
export type Quality = 'high' | 'normal' | 'low';
export interface Mix { crossfade: number; gapless: boolean; normalize: boolean; quality: Quality; saver: boolean }

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
 *
 * Crossfade / gapless start the next track on a second element and ramp the two volumes (still no
 * Web Audio); with the effects chain on, tracks change the classic way. Loudness normalisation only
 * scales the element volume from a server-side EBU R128 measurement.
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
  private prefetched = new Map<string, { at: number; q: Quality; promise: Promise<Playback> }>();
  private mix: Mix = { crossfade: 0, gapless: true, normalize: true, quality: 'high', saver: false };
  private norm = 1;
  private loudness = new Map<string, Promise<number>>();
  private xfade: { timer: ReturnType<typeof setInterval>; old: HTMLAudioElement } | null = null;
  private listeners = new Set<Listener>();
  /** Told when a track plays from SoundCloud / Dailymotion because YouTube blocks the server. */
  onFallback?: (track: Track, source: string) => void;
  private mediaListeners: [MediaEventName, EventListener][] = [];

  constructor() {
    this.el = this.createElement();
  }

  /**
   * Element volume: slider position on a perceptual curve × loudness correction. The ear hears
   * amplitude logarithmically: a linear slider barely changes anything from 100 to 75 % and cuts hard
   * below 20 %. Squaring (-5 dB at 75 %, -12 dB at 50 %, -20 dB at 10 %) makes every step sound alike.
   */
  private get outVol() {
    return this.volume * this.volume * this.norm;
  }

  private createElement(attach = true) {
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
    if (attach) for (const [name, fn] of this.mediaListeners) el.addEventListener(name, fn);
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
    this.el.volume = this.outVol;
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
    // Radio station (lib/radio.ts): relayed live by the server, by station id only.
    if (track.source === 'radio') {
      return Promise.resolve({ src: `/api/radio/listen/${encodeURIComponent(track.url.split('/').pop() || '')}`, seekable: false, duration: null, isLive: true, mime: 'audio/mpeg' });
    }
    const q = this.quality;
    const hit = this.prefetched.get(track.url);
    if (hit && hit.q === q && Date.now() - hit.at < 60 * 60 * 1000) return hit.promise;
    const promise = api.playback(track.url, 'audio', undefined, q, track);
    this.prefetched.set(track.url, { at: Date.now(), q, promise });
    promise.catch(() => this.prefetched.delete(track.url));
    if (this.prefetched.size > 50) this.prefetched.delete(this.prefetched.keys().next().value!);
    return promise;
  }

  prefetch(track: Track | undefined) {
    if (!track || track.isLive || this.mix.saver) return;
    this.resolve(track).catch(() => {});
    this.gainFor(track);
  }

  // ---------- mix: quality, transitions, loudness ----------

  setMix(mix: Mix) {
    const normChanged = mix.normalize !== this.mix.normalize;
    this.mix = { ...mix, crossfade: Math.max(0, Math.min(12, mix.crossfade)) };
    if (normChanged && this.track) this.applyGain(this.track, this.gainFor(this.track));
  }

  get quality(): Quality {
    return this.mix.saver ? 'low' : this.mix.quality;
  }

  /** Seconds before the end at which the next track starts (0 = at the end, the classic way). */
  get transitionWindow() {
    if (this.ctx || !this.playback || this.playback.isLive || this.xfade) return 0;
    return this.mix.crossfade > 0 ? this.mix.crossfade : this.mix.gapless ? 0.45 : 0;
  }

  /** Loudness correction of a track (1 = unchanged), measured once by the server. */
  private gainFor(track: Track): Promise<number> {
    if (!this.mix.normalize || track.isLive || track.source === 'local' || track.url.startsWith('blob:')) return Promise.resolve(1);
    let p = this.loudness.get(track.url);
    if (!p) {
      p = api.loudness(track.url)
        .then(({ lufs }) => (lufs == null || lufs <= TARGET_LUFS ? 1 : Math.max(0.2, Math.pow(10, (TARGET_LUFS - lufs) / 20))))
        .catch(() => { this.loudness.delete(track.url); return 1; });
      this.loudness.set(track.url, p);
      if (this.loudness.size > 500) this.loudness.delete(this.loudness.keys().next().value!);
    }
    return p;
  }

  /** Apply a correction that arrives after playback started (first play of a track): short ramp, no jump. */
  private applyGain(track: Track, p: Promise<number>) {
    p.then((g) => {
      if (this.track !== track || g === this.norm) return;
      this.norm = g;
      if (this.xfade) return;
      if (this.el.paused) this.el.volume = this.outVol; else this.fade(this.outVol, undefined, 600);
    });
  }

  private endCrossfade() {
    if (!this.xfade) return;
    clearInterval(this.xfade.timer);
    const { old } = this.xfade;
    this.xfade = null;
    old.pause();
    old.removeAttribute('src');
    old.load();
    this.el.volume = this.outVol;
  }

  /**
   * Start `track` on a second element while the current one ends, equal-power volume ramps.
   * Resolves false (nothing changed: the current track ends normally) when it cannot start in time.
   */
  async crossfade(track: Track): Promise<boolean> {
    if (this.ctx || this.xfade) return false;
    const token = ++this.loadToken;
    let pb: Playback;
    try { pb = await this.resolve(track); } catch { return false; }
    const gain = await Promise.race([this.gainFor(track), new Promise<number>((r) => setTimeout(() => r(1), 800))]);
    if (token !== this.loadToken || pb.isLive || this.ctx) return false;
    const old = this.el;
    const next = this.createElement(false);
    next.volume = 0;
    next.muted = old.muted;
    next.src = pb.src;
    next.playbackRate = old.playbackRate;
    try { await next.play(); } catch { next.removeAttribute('src'); next.load(); return false; }
    if (token !== this.loadToken) { next.pause(); next.removeAttribute('src'); next.load(); return false; }
    for (const [name, fn] of this.mediaListeners) { old.removeEventListener(name, fn); next.addEventListener(name, fn); }
    this.el = next;
    this.track = track;
    this.playback = pb;
    this.offset = 0;
    this.norm = gain;
    this.applyGain(track, this.gainFor(track));
    const from = old.volume;
    const ms = Math.max(300, Math.min(this.mix.crossfade > 0 ? this.mix.crossfade * 1000 : 450, (old.duration - old.currentTime) * 1000 || 450));
    const start = performance.now();
    const timer = setInterval(() => {
      const k = Math.min(1, (performance.now() - start) / ms);
      old.volume = from * Math.cos((k * Math.PI) / 2);
      next.volume = Math.min(1, this.outVol * Math.sin((k * Math.PI) / 2));
      if (k >= 1) this.endCrossfade();
    }, 30);
    this.xfade = { timer, old };
    this.emit();
    return true;
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
    this.endCrossfade();
    this.activate();
    this.el.pause();
    this.track = track;
    this.playback = null;
    this.offset = 0;
    this.emit();
    const gain = this.gainFor(track);
    const pb = await this.resolve(track);
    if (token !== this.loadToken) return false;
    this.playback = pb;
    if (pb.fallback) this.onFallback?.(track, pb.fallback.source);
    // Known loudness (prefetched): start at the right level; otherwise correct as soon as it is measured.
    this.norm = await Promise.race([gain, new Promise<number>((r) => setTimeout(() => r(this.norm), 250))]);
    if (token !== this.loadToken) return false;
    this.applyGain(track, gain);
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
  private fade(to: number, done?: () => void, ms = FADE_MS) {
    clearInterval(this.fadeTimer);
    const el = this.el;
    const from = el.volume;
    const steps = Math.max(1, Math.round(ms / 16));
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
      this.el.volume = this.outVol;
      if ((err as DOMException).name !== 'AbortError') throw err;
      return;
    }
    if (fadeIn) this.fade(this.outVol); else this.el.volume = this.outVol;
  }

  pause() {
    this.endCrossfade();
    if (this.el.paused) return;
    const el = this.el;
    this.fade(0, () => { el.pause(); el.volume = this.outVol; });
  }

  stop() {
    this.loadToken += 1;
    this.endCrossfade();
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
    this.endCrossfade();
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
    if (!this.xfade) this.el.volume = this.outVol;
  }

  setMuted(m: boolean) {
    this.el.muted = m;
    if (this.xfade) this.xfade.old.muted = m;
  }

  setRate(r: number) {
    this.el.playbackRate = r;
  }
}

export const engine = new AudioEngine();
