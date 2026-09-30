import { useEffect } from 'react';
import { engine } from './audio/engine';
import { usePlayer } from './store/player';
import { useLibrary } from './store/library';
import { useUi, useSettings, ACCENTS } from './store/ui';
import { dominantColor } from './lib/color';
import { openLink } from './views/Home';

/** Close a dialog or overlay with the Escape key while it is open. */
export function useEscape(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);
}

declare global {
  interface Window {
    /** Remote control used by the desktop tray and the mobile apps' notification buttons. */
    __forgeRemote?: (action: 'toggle' | 'play' | 'pause' | 'next' | 'prev' | 'seek' | 'like', value?: number) => void;
    /** Current track for native notifications (position and duration in seconds, duration null when unknown or live). */
    __forgeNowPlaying?: () => { title: string; author: string; thumbnail: string | null; playing: boolean; position: number; duration: number | null; liked: boolean } | null;
    /** Mobile apps' share target: plays or imports the first link found in the shared text. */
    __forgeOpenLink?: (text: string) => void;
    /** Android Back button: closes the topmost overlay or goes back one view. Returns false when there is nothing left to close. */
    __forgeBack?: () => boolean;
  }
}

export function useRemoteControl() {
  useEffect(() => {
    window.__forgeRemote = (action, value) => {
      const p = usePlayer.getState();
      if (action === 'toggle') p.togglePlay();
      else if (action === 'play') { if (engine.paused) p.togglePlay(); }
      else if (action === 'pause') engine.pause();
      else if (action === 'next') p.next(false);
      else if (action === 'prev') p.prev();
      else if (action === 'seek' && Number.isFinite(value)) p.seek(value!);
      else if (action === 'like') { const t = p.queue[p.index]; if (t && t.source !== 'local') useLibrary.getState().toggleLike(t); }
    };
    window.__forgeNowPlaying = () => {
      const p = usePlayer.getState();
      const t = p.queue[p.index];
      if (!t) return null;
      const duration = t.isLive ? null : engine.duration;
      const liked = useLibrary.getState().liked.some((l) => l.url === t.url);
      return { title: t.title, author: t.author || '', thumbnail: t.thumbnail, playing: p.playing, position: engine.currentTime, duration: Number.isFinite(duration) ? duration : null, liked };
    };
    window.__forgeBack = () => {
      const ui = useUi.getState();
      if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return true; }
      if (ui.menu) ui.openMenu(null);
      else if (ui.pickerTracks) ui.openPicker(null);
      else if (ui.eqOpen) ui.setEqOpen(false);
      else if (ui.sidebarOpen) ui.setSidebarOpen(false);
      else if (ui.nowPlaying) ui.setNowPlaying(false);
      else if (ui.panel) ui.setPanel(null);
      else if (ui.back.length) ui.goBack();
      else return false;
      return true;
    };
    window.__forgeOpenLink = (text) => {
      const url = text.match(/https?:\/\/\S+/)?.[0];
      const { toast } = useUi.getState();
      if (!url) return toast('Aucun lien dans le texte partagé', 'error');
      toast('Ouverture du lien partagé…');
      openLink(url).catch((err) => toast((err as Error).message, 'error'));
    };
    return () => { delete window.__forgeRemote; delete window.__forgeNowPlaying; delete window.__forgeBack; delete window.__forgeOpenLink; };
  }, []);
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
        case 'i': case 'I': ui.setMiniVideo(!ui.miniVideo); break;
        case 'e': case 'E': ui.setEqOpen(!ui.eqOpen); break;
        case 'j': case 'J': { const t = p.queue[p.index]; if (t && t.source !== 'local') useLibrary.getState().toggleLike(t); break; }
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
