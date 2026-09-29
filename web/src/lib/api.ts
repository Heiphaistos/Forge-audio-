import type { Track, Playback, LyricsResult } from './types';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

async function get<T>(path: string, params: Record<string, string | number | undefined | null> = {}, signal?: AbortSignal): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const res = await fetch(`${path}${qs.toString() ? `?${qs}` : ''}`, { signal, credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event('forge:auth-required'));
    throw new ApiError(body.error || `Erreur ${res.status}`, res.status, body.code);
  }
  return body as T;
}

async function send<T>(method: string, path: string, payload: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(body.error || `Erreur ${res.status}`, res.status, body.code) as ApiError & { current?: unknown };
    err.current = body.current;
    if (res.status === 401 && path !== '/api/login') window.dispatchEvent(new Event('forge:auth-required'));
    throw err;
  }
  return body as T;
}

export interface User {
  username: string;
  displayName: string;
}

export interface ServerDoc<D> {
  rev: number;
  updatedAt: number | null;
  data: D | null;
}

export interface Health {
  ok: boolean;
  version: string;
  ytdlp: string | null;
  authRequired: boolean;
  authenticated: boolean;
  user: User | null;
  sync: boolean;
}

export interface ResolveResult {
  type: 'search' | 'playlist' | 'track';
  title: string | null;
  url: string | null;
  thumbnail: string | null;
  tracks: Track[];
}

/** Container the browser plays best: Opus/VP9 in WebM when available, otherwise AAC/H.264 in MP4. */
function detectPrefs() {
  if (typeof document === 'undefined') return { audio: 'webm', video: 'webm' };
  const a = document.createElement('audio');
  const v = document.createElement('video');
  return {
    audio: a.canPlayType('audio/webm; codecs="opus"') ? 'webm' : 'mp4',
    video: v.canPlayType('video/webm; codecs="vp9"') ? 'webm' : 'mp4',
  };
}
export const CODEC_PREFS = detectPrefs();

export const api = {
  health: () => get<Health>('/api/health'),
  login: (username: string, password: string) => send<{ ok: true; user: User }>('POST', '/api/login', { username, password }),
  logout: () => send<{ ok: true }>('POST', '/api/logout', {}),
  getData: <D>() => get<ServerDoc<D>>('/api/me/data'),
  putData: <D>(baseRev: number, data: D) => send<{ rev: number; updatedAt: number }>('PUT', '/api/me/data', { baseRev, data }),
  search: (q: string, source: string, limit = 20, signal?: AbortSignal) =>
    get<{ tracks: Track[]; errors: Record<string, string> }>('/api/search', { q, source, limit }, signal),
  suggest: (q: string, signal?: AbortSignal) => get<{ suggestions: string[] }>('/api/suggest', { q }, signal),
  resolve: (url: string, limit = 300) => get<ResolveResult>('/api/resolve', { url, limit }),
  radio: (t: Track) => get<{ tracks: Track[] }>('/api/radio', { url: t.url, title: t.title, author: t.author, source: t.source }),
  playback: (url: string, kind: 'audio' | 'video' = 'audio', signal?: AbortSignal) =>
    get<Playback>('/api/playback', { url, kind, pref: CODEC_PREFS[kind] === 'webm' ? undefined : CODEC_PREFS[kind] }, signal),
  lyrics: (t: Track, signal?: AbortSignal) => get<LyricsResult>('/api/lyrics', { title: t.title, author: t.author, duration: t.duration }, signal),
  downloadUrl: (url: string, format: 'mp3' | 'audio' | 'video') => `/api/download?${new URLSearchParams({ url, format })}`,
  imageUrl: (url: string) => `/api/image?${new URLSearchParams({ url })}`,
};

export function isUrl(str: string): boolean {
  try {
    const u = new URL(str.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
