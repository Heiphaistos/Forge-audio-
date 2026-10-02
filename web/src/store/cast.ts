import { create } from 'zustand';
import { api } from '../lib/api';
import { engine } from '../audio/engine';
import type { Track } from '../lib/types';
import { usePlayer } from './player';
import { useUi } from './ui';

/**
 * Cast to a speaker or a TV (Chromecast in Chrome / Edge, AirPlay in Safari) with the Remote
 * Playback API on a dedicated <audio>: the cast device fetches the track itself, through a signed
 * link valid for that track only and a few hours (server/src/cast.js), never with the session.
 * Hidden when the browser has no Remote Playback or sees no device. Radios and local files are not
 * castable. Following the queue: when a track ends on the cast device, the next one is sent.
 */

const el: HTMLAudioElement | null = typeof HTMLMediaElement !== 'undefined' && 'remote' in HTMLMediaElement.prototype ? new Audio() : null;
if (el) el.preload = 'none';

export const useCast = create<{ available: boolean; connected: boolean; playing: boolean; track: Track | null }>(() => ({ available: false, connected: false, playing: false, track: null }));

const castable = (t: Track | undefined): t is Track => !!t && t.source !== 'local' && t.source !== 'radio' && !t.isLive && /^https?:\/\//.test(t.url);
let prepared: { url: string; until: number } | null = null;
let watching = false;

/** Get a signed link for `track` ahead of the click (prompt() must run inside the user gesture). */
export async function prepareCast(track: Track | undefined) {
  if (!el || !castable(track)) return;
  if (prepared?.url === track.url && prepared.until > Date.now() + 60_000) return;
  const { src, expiresAt } = await api.castLink(track.url);
  prepared = { url: track.url, until: expiresAt };
  el.src = src;
  useCast.setState({ track });
  if (!watching) {
    watching = true;
    el.remote.watchAvailability((available) => useCast.setState({ available })).catch(() => { watching = false; useCast.setState({ available: false }); });
  }
}

/** Opens the browser's device picker (call it from a click). */
export function chooseCastDevice() {
  if (!el) return;
  el.remote.prompt().catch((err: DOMException) => {
    if (err.name !== 'AbortError') useUi.getState().toast(`Diffusion impossible : ${err.message}`, 'error');
  });
}

export function toggleCast() {
  if (!el) return;
  if (el.paused) el.play().catch(() => {}); else el.pause();
}

if (el) {
  el.remote.addEventListener('connect', () => {
    useCast.setState({ connected: true });
    // Continue where this device was, then stop here.
    if (engine.currentTrack?.url === prepared?.url) el.currentTime = engine.currentTime;
    if (usePlayer.getState().playing) usePlayer.getState().togglePlay();
    el.play().catch(() => {});
  });
  el.remote.addEventListener('disconnect', () => { useCast.setState({ connected: false, playing: false }); el.pause(); });
  el.addEventListener('play', () => useCast.setState({ playing: true }));
  el.addEventListener('pause', () => useCast.setState({ playing: false }));
  el.addEventListener('ended', async () => {
    const p = usePlayer.getState();
    const next = p.queue[p.index + 1];
    if (!useCast.getState().connected || !castable(next)) return;
    usePlayer.setState({ index: p.index + 1, position: 0 });
    await prepareCast(next).catch(() => {});
    el.play().catch(() => {});
  });
}
