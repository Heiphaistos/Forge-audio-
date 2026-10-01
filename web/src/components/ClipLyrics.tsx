import { Mic2, MonitorPlay, Rows2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSettings, useUi } from '../store/ui';

/** Right panel: « Clip / Paroles / Clip + paroles ». The clip + lyrics choice is remembered on this device. */
export function MediaSwitch() {
  const panel = useUi((s) => s.panel);
  const setPanel = useUi((s) => s.setPanel);
  const both = useSettings((s) => s.clipLyrics);
  const mode = panel === 'lyrics' ? 'lyrics' : both ? 'both' : 'clip';
  const pick = (m: 'clip' | 'lyrics' | 'both') => {
    if (m === 'lyrics') return setPanel('lyrics');
    useSettings.getState().set({ clipLyrics: m === 'both' });
    setPanel('video');
  };
  const tab = (m: 'clip' | 'lyrics' | 'both', icon: React.ReactNode, label: string) => (
    <button role="tab" aria-selected={mode === m} className={`chip ${mode === m ? 'active' : ''}`} onClick={() => pick(m)}>{icon} {label}</button>
  );
  return (
    <div className="chips small media-switch" role="tablist" aria-label="Affichage du panneau">
      {tab('clip', <MonitorPlay size={13} />, 'Clip')}
      {tab('lyrics', <Mic2 size={13} />, 'Paroles')}
      {tab('both', <Rows2 size={13} />, 'Clip + paroles')}
    </div>
  );
}

/** True while the media query matches (follows window resizes). */
export function useMedia(query: string) {
  const [on, setOn] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const upd = () => setOn(m.matches);
    upd();
    m.addEventListener('change', upd);
    return () => m.removeEventListener('change', upd);
  }, [query]);
  return on;
}

/**
 * Scroll `el` to the middle of its own scrolling box only. scrollIntoView also scrolls every
 * ancestor: under the clip it pushed the video out of sight on phones.
 */
export function centerInScroller(el: HTMLElement) {
  let box = el.parentElement;
  while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
  if (!box) return;
  const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - (box.clientHeight - el.offsetHeight) / 2;
  box.scrollTo({ top, behavior: 'smooth' });
}
