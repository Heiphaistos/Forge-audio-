/**
 * Where playback stopped on this device: the track and its position, so reopening the app (web,
 * desktop, Android) puts the same track back, paused, at the same second. Kept in localStorage
 * (`forge.position`, older versions stored a bare number of seconds: ignored), copied to the server
 * with the synced library (lib/sync.ts) so another device can pick it up.
 */
const KEY = 'forge.position';

export interface Resume { url: string; t: number; at: number }

export function readResume(): Resume | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    return v && typeof v === 'object' && typeof v.url === 'string' ? { url: v.url, t: Math.max(0, Number(v.t) || 0), at: Number(v.at) || 0 } : null;
  } catch { return null; }
}

export function saveResume(url: string, t: number, at = Date.now()) {
  try { localStorage.setItem(KEY, JSON.stringify({ url, t: Math.floor(Math.max(0, t)), at })); } catch { /* quota or private mode */ }
}

export function clearResume() {
  try { localStorage.removeItem(KEY); } catch { /* private mode */ }
}

/**
 * Position to restart a track from: none for live streams, and the start when it was saved in the
 * last 5 seconds (the track had in fact ended).
 */
export function resumePoint(t: number, duration: number | null | undefined, isLive?: boolean) {
  if (isLive || !(t > 0)) return 0;
  return duration && t > duration - 5 ? 0 : t;
}
