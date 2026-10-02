import type { Track } from './types';

/**
 * Offline downloads: what to fetch, keep or delete.
 *
 * A downloaded track carries « pins », the reasons it is kept: 'track' (made available on its own),
 * 'liked' (the liked tracks are), or 'pl:<id>' (a playlist is). It is deleted when no pin is left,
 * so removing a playlist never deletes a title that is also liked, and vice versa.
 */
export interface OfflineRec { url: string; track: Track; pins: string[]; stored: boolean }

export interface OfflinePlan {
  /** Collections still existing (a deleted playlist drops out). */
  sets: string[];
  download: { track: Track; pins: string[] }[];
  update: { url: string; pins: string[] }[];
  remove: string[];
}

/** Only real remote titles can be downloaded: no live streams, radios or local files. */
export const offlineEligible = (t: Track) => /^https?:\/\//i.test(t.url) && t.source !== 'local' && t.source !== 'radio' && !t.isLive;

export function planOffline(sets: string[], collections: Record<string, Track[] | undefined>, recs: OfflineRec[]): OfflinePlan {
  const live = sets.filter((s) => collections[s]);
  const want = new Map<string, { track: Track; pins: Set<string> }>();
  const add = (track: Track, pin: string) => {
    const w = want.get(track.url) ?? { track, pins: new Set<string>() };
    w.pins.add(pin);
    want.set(track.url, w);
  };
  for (const r of recs) if (r.pins.includes('track')) add(r.track, 'track');
  for (const s of live) for (const t of collections[s]!) if (offlineEligible(t)) add(t, s);

  const plan: OfflinePlan = { sets: live, download: [], update: [], remove: [] };
  const stored = new Set<string>();
  for (const r of recs) {
    if (!r.stored) continue;
    stored.add(r.url);
    const w = want.get(r.url);
    if (!w) { plan.remove.push(r.url); continue; }
    const pins = [...w.pins].sort();
    if (pins.join('|') !== [...r.pins].sort().join('|')) plan.update.push({ url: r.url, pins });
  }
  for (const [url, w] of want) if (!stored.has(url)) plan.download.push({ track: w.track, pins: [...w.pins].sort() });
  return plan;
}

/** « 1,2 Go », « 340 Mo ». */
export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Go`;
  return `${Math.max(0, Math.round(n / 1024 ** 2)).toLocaleString('fr-FR')} Mo`;
}
