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

/**
 * Single audio element + Web Audio graph (10-band EQ → gain → analyser).
 * Streams that are not seekable by HTTP Range (HLS sources transcoded by the server)
 * are restarted with `?start=` and tracked with an offset.
 */
class AudioEngine {
  readonly audio: HTMLAudioElement;
  private ctx: AudioContext | null = null;
  private filters: BiquadFilterNode[] = [];
  private gain: GainNode | null = null;
  analyser: AnalyserNode | null = null;
  private eq: number[] = EQ_PRESETS.Plat;
  private eqEnabled = true;
  private offset = 0;
  private playback: Playback | null = null;
  private track: Track | null = null;
  private loadToken = 0;
  private prefetched = new Map<string, { at: number; promise: Promise<Playback> }>();
  private listeners = new Set<Listener>();

  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.crossOrigin = 'anonymous';
    // A running AudioContext keeps the sound card open: on many headphone jacks that is a constant hum/hiss.
    // Suspend it as soon as nothing plays (short delay so pause → play stays instant), resume on play.
    let idle: ReturnType<typeof setTimeout> | undefined;
    const sleep = () => {
      clearTimeout(idle);
      idle = setTimeout(() => { if (this.audio.paused && this.ctx?.state === 'running') this.ctx.suspend().catch(() => {}); }, 1500);
    };
    for (const e of ['pause', 'ended', 'emptied', 'error']) this.audio.addEventListener(e, sleep);
    this.audio.addEventListener('play', () => { clearTimeout(idle); if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {}); });
  }

  /** Build the Web Audio graph (must happen after a user gesture). */
  private ensureGraph() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    try {
      const ctx = new AudioContext({ latencyHint: 'playback' });
      const source = ctx.createMediaElementSource(this.audio);
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
      this.applyEq();
    } catch {
      // Web Audio unavailable: plain <audio> playback still works.
    }
  }

  private applyEq() {
    this.filters.forEach((f, i) => { f.gain.value = this.eqEnabled ? this.eq[i] ?? 0 : 0; });
    // Keep headroom when boosting to avoid clipping.
    const maxBoost = this.eqEnabled ? Math.max(0, ...this.eq) : 0;
    if (this.gain) this.gain.gain.value = Math.pow(10, -maxBoost / 2 / 20);
  }

  setEq(gains: number[], enabled = true) {
    this.eq = gains;
    this.eqEnabled = enabled;
    this.applyEq();
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

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

  /** Load a track; resolves once the source is set (playback may still be buffering). */
  async load(track: Track, { autoplay = true, startAt = 0 } = {}) {
    const token = ++this.loadToken;
    this.ensureGraph();
    this.audio.pause();
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
    const rate = this.audio.playbackRate;
    if (pb.seekable) {
      this.offset = 0;
      this.audio.src = pb.src;
      if (startAt > 0) {
        const seek = () => { this.audio.currentTime = startAt; };
        this.audio.addEventListener('loadedmetadata', seek, { once: true });
      }
    } else {
      this.offset = pb.isLive ? 0 : startAt;
      this.audio.src = startAt > 0 && !pb.isLive ? `${pb.src}&start=${Math.floor(startAt)}` : pb.src;
    }
    this.audio.playbackRate = rate;
    this.audio.preservesPitch = true;
  }

  async play() {
    this.ensureGraph();
    if (!this.audio.src && this.track) {
      await this.load(this.track, { autoplay: true });
      return;
    }
    try {
      await this.audio.play();
    } catch (err) {
      if ((err as DOMException).name !== 'AbortError') throw err;
    }
  }

  pause() {
    this.audio.pause();
  }

  stop() {
    this.loadToken += 1;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.track = null;
    this.playback = null;
    this.emit();
  }

  get currentTrack() {
    return this.track;
  }

  get currentTime() {
    return this.offset + (this.audio.currentTime || 0);
  }

  get duration(): number | null {
    if (this.playback?.isLive) return null;
    if (this.playback?.seekable && Number.isFinite(this.audio.duration)) return this.audio.duration;
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
      this.audio.currentTime = t;
    } else {
      const wasPlaying = !this.audio.paused;
      this.setSource(t);
      if (wasPlaying) this.audio.play().catch(() => {});
    }
    this.emit();
  }

  setVolume(v: number) {
    this.audio.volume = Math.max(0, Math.min(1, v));
  }

  setMuted(m: boolean) {
    this.audio.muted = m;
  }

  setRate(r: number) {
    this.audio.playbackRate = r;
  }
}

export const engine = new AudioEngine();
