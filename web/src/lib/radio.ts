import { get } from './api';
import type { RadioStation, Track } from './types';
import { usePlayer } from '../store/player';
import { useLibrary } from '../store/library';

/**
 * Radios (server/src/radio.js): hand-picked French stations + the Radio Browser directory, all
 * through our server. A station plays as a live track whose URL is a stable id in a namespace of
 * ours (never fetched): the engine turns it into /api/radio/listen/<id>.
 */

export const RADIO_URL = 'https://forgeaudio.heiphaistos.org/radio/';

export interface Country { code: string; name: string; count: number }
export interface Language { name: string; code: string | null; count: number }
export interface Genre { id: string; label: string; count: number }
export interface StationPage { stations: RadioStation[]; more: boolean }

export const radioApi = {
  featured: () => get<{ stations: RadioStation[] }>('/api/radio/featured'),
  countries: () => get<{ countries: Country[] }>('/api/radio/countries'),
  languages: () => get<{ languages: Language[] }>('/api/radio/languages'),
  genres: () => get<{ genres: Genre[] }>('/api/radio/genres'),
  stations: (p: { country?: string; genre?: string; language?: string; q?: string; offset?: number; limit?: number }, signal?: AbortSignal) =>
    get<StationPage>('/api/radio/stations', p, signal),
  meta: (id: string) => get<{ title: string | null }>(`/api/radio/meta/${encodeURIComponent(id)}`),
};

export const stationIdOf = (t: Track | undefined) => (t?.source === 'radio' ? t.url.slice(RADIO_URL.length) : null);

export function toTrack(s: RadioStation): Track {
  return { id: s.id, title: s.name, url: RADIO_URL + s.id, duration: null, thumbnail: s.logo, author: null, album: null, source: 'radio', isLive: true };
}

/** Station card kept in favourites / recent (no counters that change every day). */
const snapshot = ({ votes, clicks, ...s }: RadioStation): RadioStation => s; // eslint-disable-line @typescript-eslint/no-unused-vars

export function playStation(s: RadioStation) {
  usePlayer.getState().playList([toTrack(s)]);
  useLibrary.getState().pushRadioRecent(snapshot(s));
}

export function toggleFavorite(s: RadioStation) {
  return useLibrary.getState().toggleRadioFavorite(snapshot(s));
}

// ---------- names ----------
const regionNames = (() => { try { return new Intl.DisplayNames(['fr'], { type: 'region' }); } catch { return null; } })();
const languageNames = (() => { try { return new Intl.DisplayNames(['fr'], { type: 'language' }); } catch { return null; } })();

export function countryName(code: string | null | undefined, fallback?: string | null) {
  if (!code) return fallback || '';
  try { return regionNames?.of(code) || fallback || code; } catch { return fallback || code; }
}

export function flag(code: string | null | undefined) {
  if (!code || !/^[A-Z]{2}$/.test(code)) return '';
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function languageName(l: Language) {
  let name = l.name;
  try { if (l.code) name = languageNames?.of(l.code) || name; } catch { /* unknown code */ }
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// ---------- « title in progress » (ICY metadata, when the station sends it) ----------
let metaTimer: ReturnType<typeof setInterval> | undefined;

/** While a radio plays, show what it plays (as the track's author line), polled every 15 s. */
export function startRadioMeta() {
  let current: string | null = null;
  const poll = async () => {
    const st = usePlayer.getState();
    const t = st.queue[st.index];
    const id = stationIdOf(t);
    if (!id || !st.playing) return;
    try {
      const { title } = await radioApi.meta(id);
      const now = usePlayer.getState();
      const i = now.index;
      if (title && stationIdOf(now.queue[i]) === id && now.queue[i].author !== title) {
        usePlayer.setState({ queue: now.queue.map((x, j) => (j === i ? { ...x, author: title } : x)) });
      }
    } catch { /* not sent by this station */ }
  };
  usePlayer.subscribe((s) => {
    const id = s.playing ? stationIdOf(s.queue[s.index]) : null;
    if (id === current) return;
    current = id;
    clearInterval(metaTimer);
    if (id) {
      setTimeout(poll, 4000);
      metaTimer = setInterval(poll, 15_000);
    }
  });
}
