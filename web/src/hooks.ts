import { useEffect } from 'react';
import { engine } from './audio/engine';
import { usePlayer } from './store/player';
import { useUi, useSettings, ACCENTS } from './store/ui';
import { dominantColor } from './lib/color';

/** Close a dialog or overlay with the Escape key while it is open. */
export function useEscape(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);
}

/** OS media keys / lock screen controls. */
export function useMediaSession() {
  const track = usePlayer((s) => s.queue[s.index]);
  const playing = usePlayer((s) => s.playing);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const p = () => usePlayer.getState();
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => p().togglePlay()],
      ['pause', () => engine.pause()],
      ['previoustrack', () => p().prev()],
      ['nexttrack', () => p().next(false)],
      ['seekto', (d) => { if (d.seekTime !== undefined) p().seek(d.seekTime); }],
      ['seekbackward', (d) => p().seek(engine.currentTime - (d.seekOffset || 10))],
      ['seekforward', (d) => p().seek(engine.currentTime + (d.seekOffset || 10))],
    ];
    for (const [a, h] of handlers) { try { ms.setActionHandler(a, h); } catch { /* unsupported */ } }
  }, []);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = track ? new MediaMetadata({
      title: track.title,
      artist: track.author || '',
      album: 'Forge Audio',
      artwork: track.thumbnail ? [{ src: track.thumbnail, sizes: '480x360', type: 'image/jpeg' }] : [],
    }) : null;
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    document.title = track ? `${playing ? '▶ ' : ''}${track.title}${track.author ? ` · ${track.author}` : ''} — Forge Audio` : 'Forge Audio';
  }, [track, playing]);
}

export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        focusSearch();
        return;
      }
      if (el.closest('input, textarea, select, [contenteditable="true"]') || e.ctrlKey || e.metaKey || e.altKey) return;
      const p = usePlayer.getState();
      const ui = useUi.getState();
      switch (e.key) {
        case ' ': e.preventDefault(); p.togglePlay(); break;
        case 'ArrowRight': e.preventDefault(); if (e.shiftKey) p.next(false); else p.seek(engine.currentTime + 10); break;
        case 'ArrowLeft': e.preventDefault(); if (e.shiftKey) p.prev(); else p.seek(Math.max(0, engine.currentTime - 10)); break;
        case 'ArrowUp': e.preventDefault(); p.setVolume(p.volume + 0.05); break;
        case 'ArrowDown': e.preventDefault(); p.setVolume(p.volume - 0.05); break;
        case 'm': case 'M': p.toggleMute(); break;
        case 's': case 'S': p.toggleShuffle(); break;
        case 'r': case 'R': p.cycleRepeat(); break;
        case 'l': case 'L': ui.togglePanel('lyrics'); break;
        case 'q': case 'Q': ui.togglePanel('queue'); break;
        case 'v': case 'V': ui.togglePanel('video'); break;
        case 'e': case 'E': ui.setEqOpen(!ui.eqOpen); break;
        case 'f': case 'F': if (p.queue[p.index]) ui.setNowPlaying(!ui.nowPlaying); break;
        case '/': e.preventDefault(); focusSearch(); break;
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function focusSearch() {
  const ui = useUi.getState();
  if (ui.view.name !== 'search') ui.navigate({ name: 'search' });
  setTimeout(() => (document.getElementById('global-search') as HTMLInputElement | null)?.select(), 30);
}

/** Build the Web Audio chain only while the EQ (non-flat) or the visualizer is in use. */
export function useAudioEffects() {
  const eqActive = useSettings((s) => s.eqEnabled && s.eqGains.some((g) => g !== 0));
  const visualizer = useSettings((s) => s.visualizer);
  useEffect(() => { engine.setEffects(eqActive || visualizer); }, [eqActive, visualizer]);
}

/** Accent color + background tint from the current cover. */
export function useTheme() {
  const accent = useSettings((s) => s.accent);
  const dynamic = useSettings((s) => s.dynamicColors);
  const thumb = usePlayer((s) => s.queue[s.index]?.thumbnail);

  useEffect(() => {
    document.documentElement.style.setProperty('--accent-rgb', ACCENTS[accent] || ACCENTS.Braise);
  }, [accent]);

  useEffect(() => {
    let cancelled = false;
    const root = document.documentElement.style;
    if (!dynamic || !thumb) { root.setProperty('--tint-rgb', ACCENTS[accent] || ACCENTS.Braise); return; }
    dominantColor(thumb).then((c) => { if (!cancelled) root.setProperty('--tint-rgb', c || ACCENTS[accent]); });
    return () => { cancelled = true; };
  }, [thumb, dynamic, accent]);
}
