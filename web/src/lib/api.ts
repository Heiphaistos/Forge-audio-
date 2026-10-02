import type { Track, Playback, LyricsResult } from './types';
import type { Wrapped } from './e2e';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

export async function get<T>(path: string, params: Record<string, string | number | undefined | null> = {}, signal?: AbortSignal): Promise<T> {
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
    if (res.status === 401 && path !== '/api/login' && path !== '/api/register') window.dispatchEvent(new Event('forge:auth-required'));
    throw err;
  }
  return body as T;
}

/**
 * Seals the password with the server's RSA-OAEP key (+ single-use nonce) so it never shows in clear
 * in the browser's network tools. Falls back to the plain password (still over HTTPS) if Web Crypto
 * or the key endpoint is unavailable.
 */
export async function sealPassword(password: string): Promise<{ sealed: string } | { password: string }> {
  try {
    if (!globalThis.crypto?.subtle) return { password };
    const { key, nonce } = await get<{ key: string | null; nonce: string | null }>('/api/login-key');
    if (!key || !nonce) return { password };
    const der = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
    const pub = await crypto.subtle.importKey('spki', der, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const data = new TextEncoder().encode(JSON.stringify({ p: password, n: nonce }));
    if (data.length > 446) return { password }; // RSA-OAEP 4096 / SHA-256 limit
    const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pub, data));
    let bin = '';
    for (const b of out) bin += String.fromCharCode(b);
    return { sealed: btoa(bin) };
  } catch {
    return { password };
  }
}

export interface EmailState { email: string | null; pending: string | null; mail: boolean }

export interface User {
  username: string;
  displayName: string;
  role?: 'admin' | 'user';
}

export interface Invite {
  id: string;
  note: string;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  usedBy: string | null;
  usedAt: number | null;
  revokedAt: number | null;
  status: 'active' | 'used' | 'expired' | 'revoked';
}

export interface AdminAccount { username: string; displayName: string; role: 'admin' | 'user'; since: number }

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

export interface SharedTrack extends Track { addedBy?: string }

export interface SharedPlaylist {
  id: string;
  name: string;
  description: string;
  cover: string | null;
  owner: string;
  members: string[];
  tracks: SharedTrack[];
  createdAt: number;
  updatedAt: number;
  rev: number;
}

export interface Jam {
  id: string;
  code: string;
  host: string;
  everyoneControls: boolean;
  participants: { username: string; displayName: string; joinedAt: number }[];
  queue: SharedTrack[];
  index: number;
  playing: boolean;
  /** seconds, at server time positionAt (ms) */
  position: number;
  positionAt: number;
  serverNow: number;
  createdAt: number;
}

export interface ArtistCardData { id: number; name: string; picture: string | null; fans: number | null }
export interface AlbumCardData { id: number; title: string; cover: string | null; year: number | null; releaseDate: string | null; type: string; artist: { id: number; name: string } | null; tracks: number | null }
export interface ArtistPage {
  artist: { id: number; name: string; picture: string | null; fans: number | null; albums: number | null };
  top: Track[];
  albums: AlbumCardData[];
  singles: AlbumCardData[];
  related: ArtistCardData[];
  bio: { text: string; url: string | null; lang: string } | null;
}
export interface AlbumPage { album: AlbumCardData & { duration: number | null; label: string | null; genres: string[] }; tracks: Track[] }
export interface CatalogPlaylist { id: number; title: string; cover: string | null; tracks: number | null; by: string | null; url: string }
export interface CatalogSearch { artists: ArtistCardData[]; albums: AlbumCardData[]; playlists: CatalogPlaylist[] }
export interface Mix { id: string; title: string; subtitle: string; cover: string | null; tracks: Track[] }
export interface Reco { mixes: Mix[]; discover: Mix | null; radar: AlbumCardData[]; seeds: ArtistCardData[] }

export interface DiscordLink { discordId: string; discordName: string | null; linkedAt: number }

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
  login: async (username: string, password: string) =>
    send<{ ok: true; user: User }>('POST', '/api/login', { username, ...(await sealPassword(password)) }),
  register: async (p: { code: string; username: string; displayName: string; password: string; email?: string }) =>
    send<{ ok: true; user: User }>('POST', '/api/register', { code: p.code, username: p.username, displayName: p.displayName, email: p.email || undefined, ...(await sealPassword(p.password)) }),
  logout: () => send<{ ok: true }>('POST', '/api/logout', {}),
  invites: () => get<{ invites: Invite[] }>('/api/admin/invites'),
  inviteCreate: (days: number, note: string) => send<{ code: string; invite: Invite }>('POST', '/api/admin/invites', { days, note }),
  inviteRevoke: (id: string) => send<{ ok: true }>('DELETE', `/api/admin/invites/${encodeURIComponent(id)}`, {}),
  adminAccounts: () => get<{ accounts: AdminAccount[] }>('/api/admin/accounts'),
  getData: <D>() => get<ServerDoc<D>>('/api/me/data'),
  putData: <D>(baseRev: number, data: D) => send<{ rev: number; updatedAt: number }>('PUT', '/api/me/data', { baseRev, data }),
  search: (q: string, source: string, limit = 20, signal?: AbortSignal) =>
    get<{ tracks: Track[]; errors: Record<string, string> }>('/api/search', { q, source, limit }, signal),
  suggest: (q: string, signal?: AbortSignal) => get<{ suggestions: string[] }>('/api/suggest', { q }, signal),
  resolve: (url: string, limit = 300) => get<ResolveResult>('/api/resolve', { url, limit }),
  radio: (t: Track) => get<{ tracks: Track[] }>('/api/radio', { url: t.url, title: t.title, author: t.author, source: t.source }),
  /** `track` lets the server find the same title elsewhere when YouTube blocks it. */
  playback: (url: string, kind: 'audio' | 'video' = 'audio', signal?: AbortSignal, q?: 'high' | 'normal' | 'low', track?: Track) =>
    get<Playback>('/api/playback', {
      url, kind, pref: CODEC_PREFS[kind] === 'webm' ? undefined : CODEC_PREFS[kind], q: q && q !== 'high' ? q : undefined,
      t: track?.title, a: track?.author ?? undefined, d: track?.duration ?? undefined,
    }, signal),
  loudness: (url: string) => get<{ lufs: number | null }>('/api/loudness', { url }),
  lyrics: (t: Track, signal?: AbortSignal) => get<LyricsResult>('/api/lyrics', { title: t.title, author: t.author, duration: t.duration }, signal),
  /** Lines translated by the server (server/src/translate.js); `same` = already in that language. */
  translateLyrics: (lines: string[], to: string) => send<{ lang: string | null; same: boolean; lines: string[] }>('POST', '/api/lyrics/translate', { lines, to }),
  downloadUrl: (url: string, format: 'mp3' | 'audio' | 'video') => `/api/download?${new URLSearchParams({ url, format })}`,
  /** A whole list as one zip: register it, then open downloadBatchUrl(id) as a plain link (single use, 10 min). */
  downloadBatch: (name: string, format: 'mp3' | 'audio', tracks: Track[]) =>
    send<{ id: string; count: number }>('POST', '/api/download/batch', { name, format, tracks: tracks.map((t) => ({ url: t.url, title: t.title, author: t.author })) }),
  downloadBatchUrl: (id: string) => `/api/download/batch/${encodeURIComponent(id)}`,
  imageUrl: (url: string) => `/api/image?${new URLSearchParams({ url })}`,
  // Between accounts (server/src/social.js)
  users: () => get<{ users: User[] }>('/api/users'),
  activity: (track: Track) => send<{ ok: boolean }>('POST', '/api/activity', { track }),
  friends: () => get<{ friends: FriendActivity[] }>('/api/activity'),
  blend: (username: string) => get<BlendResult>(`/api/blend/${encodeURIComponent(username)}`),
  shared: () => get<{ playlists: SharedPlaylist[] }>('/api/shared'),
  sharedCreate: (p: { name: string; description?: string; cover?: string | null; tracks: Track[]; members: string[] }) => send<{ playlist: SharedPlaylist }>('POST', '/api/shared', p),
  sharedUpdate: (id: string, patch: Partial<Pick<SharedPlaylist, 'name' | 'description' | 'members' | 'cover'>>) => send<{ playlist: SharedPlaylist }>('PATCH', `/api/shared/${id}`, patch),
  sharedAdd: (id: string, tracks: Track[]) => send<{ playlist: SharedPlaylist; added: number }>('POST', `/api/shared/${id}/tracks`, { tracks }),
  sharedRemove: (id: string, url: string) => send<{ playlist: SharedPlaylist }>('DELETE', `/api/shared/${id}/tracks?${new URLSearchParams({ url })}`, {}),
  sharedMove: (id: string, from: number, to: number) => send<{ playlist: SharedPlaylist }>('POST', `/api/shared/${id}/move`, { from, to }),
  sharedLeave: (id: string) => send<{ ok: true; deleted: boolean }>('DELETE', `/api/shared/${id}`, {}),
  jam: () => get<{ jam: Jam | null }>('/api/jam'),
  jamStart: (p: { tracks: Track[]; index: number; position: number; playing: boolean }) => send<{ jam: Jam }>('POST', '/api/jam', p),
  jamJoin: (code: string) => send<{ jam: Jam }>('POST', '/api/jam/join', { code }),
  jamLeave: (id: string) => send<{ jam: null }>('POST', `/api/jam/${id}/leave`, {}),
  jamInvite: (id: string, username: string) => send<{ online: boolean }>('POST', `/api/jam/${id}/invite`, { username }),
  jamAdd: (id: string, tracks: Track[], next = false) => send<{ jam: Jam }>('POST', `/api/jam/${id}/add`, { tracks, next }),
  jamRemove: (id: string, index: number) => send<{ jam: Jam }>('POST', `/api/jam/${id}/remove`, { index }),
  jamControl: (id: string, body: { action: string; position?: number; index?: number; from?: number }) => send<{ jam: Jam }>('POST', `/api/jam/${id}/control`, body),
  jamSettings: (id: string, everyoneControls: boolean) => send<{ jam: Jam }>('PATCH', `/api/jam/${id}`, { everyoneControls }),
  catalogArtist: (q: { id?: number; name?: string }) => get<ArtistPage>('/api/catalog/artist', { id: q.id, name: q.name }),
  catalogAlbum: (id: number) => get<AlbumPage>(`/api/catalog/album/${id}`),
  catalogSearch: (q: string, signal?: AbortSignal) => get<CatalogSearch>('/api/catalog/search', { q }, signal),
  catalogGenre: (id: number | undefined, q: string[]) => get<{ playlists: CatalogPlaylist[] }>(`/api/catalog/genre?${new URLSearchParams([...(id === undefined ? [] : [['id', String(id)]]), ...q.map((x) => ['q', x])])}`),
  reco: (body: { top: string[]; followed: string[]; known: string[]; hiddenArtists: string[]; hiddenTracks: string[] }) => send<Reco>('POST', '/api/reco', body),
  uploadCover: async (file: File) => {
    const res = await fetch('/api/me/covers', { method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream' }, credentials: 'same-origin' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(body.error || `Erreur ${res.status}`, res.status, body.code);
    return body as { url: string };
  },
  discord: () => get<{ link: DiscordLink | null; botEnabled: boolean }>('/api/me/discord'),
  discordCode: () => send<{ code: string; expiresAt: number }>('POST', '/api/me/discord/code', {}),
  discordUnlink: () => send<{ ok: true }>('DELETE', '/api/me/discord', {}),
  friendsAll: () => get<FriendsState>('/api/friends'),
  friendRequest: (username: string) => send<{ status: 'sent' | 'friends' }>('POST', '/api/friends/requests', { username }),
  friendAccept: (username: string) => send<{ ok: true }>('POST', `/api/friends/requests/${encodeURIComponent(username)}/accept`, {}),
  friendDecline: (username: string) => send<{ ok: true }>('POST', `/api/friends/requests/${encodeURIComponent(username)}/decline`, {}),
  friendCancel: (username: string) => send<{ ok: true }>('DELETE', `/api/friends/requests/${encodeURIComponent(username)}`, {}),
  friendRemove: (username: string) => send<{ ok: true }>('DELETE', `/api/friends/${encodeURIComponent(username)}`, {}),
  block: (username: string) => send<{ ok: true }>('POST', '/api/friends/blocks', { username }),
  unblock: (username: string) => send<{ ok: true }>('DELETE', `/api/friends/blocks/${encodeURIComponent(username)}`, {}),
  conversations: () => get<{ conversations: Conversation[]; unread: number }>('/api/messages'),
  conversation: (username: string) => get<{ with: Correspondent; messages: PrivateMessage[]; readByOther: number }>(`/api/messages/${encodeURIComponent(username)}`),
  /** End-to-end encrypted (store/keys.ts sealFor): the server never receives the text. */
  sendMessage: (username: string, sealed: { v: 1; iv: string; ct: string; fp: string; toFp: string }) => send<{ message: PrivateMessage }>('POST', `/api/messages/${encodeURIComponent(username)}`, sealed),
  readMessages: (username: string) => send<{ ok: true }>('POST', `/api/messages/${encodeURIComponent(username)}/read`, {}),
  myKeys: () => get<{ key: { pub: string; fp: string; wrapped: Wrapped; at: number; backupAt: number | null } | null }>('/api/me/keys'),
  putKeys: (pub: string, wrapped: Wrapped, backup?: Wrapped) => send<{ key: { pub: string; fp: string } }>('PUT', '/api/me/keys', { pub, wrapped, backup }),
  putBackup: (fp: string, backup: Wrapped) => send<{ backupAt: number }>('PUT', '/api/me/keys/backup', { fp, backup }),
  // Optional e-mail address and « Mot de passe oublié » (server/src/recovery.js)
  myEmail: () => get<EmailState>('/api/me/email'),
  setEmail: async (email: string, password: string) => send<EmailState>('PUT', '/api/me/email', { email, ...(await sealPassword(password)) }),
  removeEmail: async (password: string) => send<EmailState>('DELETE', '/api/me/email', await sealPassword(password)),
  resendEmail: () => send<EmailState>('POST', '/api/me/email/resend', {}),
  verifyEmail: (code: string) => send<EmailState>('POST', '/api/me/email/verify', { code }),
  recoveryStatus: () => get<{ mail: boolean }>('/api/recovery/status'),
  recoveryStart: (login: string) => send<{ ok: true }>('POST', '/api/recovery/start', { login }),
  recoveryVerify: (login: string, code: string) => send<{ ticket: string; username: string; hasKey: boolean; backup: Wrapped | null }>('POST', '/api/recovery/verify', { login, code }),
  recoveryReset: async (ticket: string, password: string, wrapped: Wrapped | null) => {
    const n = await sealPassword(password);
    return send<{ ok: true; user: User }>('POST', '/api/recovery/reset', { ticket, wrapped, ...('sealed' in n ? { newSealed: n.sealed } : { newPassword: n.password }) });
  },
  keysOf: (username: string) => get<{ username: string; current: { pub: string; fp: string } | null; old: { pub: string; fp: string }[] }>(`/api/keys/${encodeURIComponent(username)}`),
  changePassword: async (oldPw: string, newPw: string, wrapped: Wrapped | null) => {
    const o = await sealPassword(oldPw);
    const n = await sealPassword(newPw);
    return send<{ ok: true }>('POST', '/api/me/password', {
      ...('sealed' in o ? { oldSealed: o.sealed } : { oldPassword: o.password }),
      ...('sealed' in n ? { newSealed: n.sealed } : { newPassword: n.password }),
      wrapped,
    });
  },
  clearConversation: (username: string) => send<{ ok: true }>('DELETE', `/api/messages/${encodeURIComponent(username)}`, {}),
  myProfile: () => get<{ profile: MyProfile }>('/api/me/profile'),
  saveProfile: (patch: Partial<Pick<MyProfile, 'displayName' | 'bio' | 'showStats'>>) => send<{ profile: MyProfile }>('PATCH', '/api/me/profile', patch),
  uploadAvatar: async (file: File) => {
    const res = await fetch('/api/me/avatar', { method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream' }, credentials: 'same-origin' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(body.error || `Erreur ${res.status}`, res.status, body.code);
    return body as { avatar: string };
  },
  deleteAvatar: () => send<{ ok: true }>('DELETE', '/api/me/avatar', {}),
  profile: (username: string) => get<{ profile: Profile }>(`/api/profiles/${encodeURIComponent(username)}`),
  profilePlaylist: (username: string, id: string) => get<{ playlist: { id: string; name: string; description: string; cover: string | null; owner: string; tracks: Track[] } }>(`/api/profiles/${encodeURIComponent(username)}/playlists/${encodeURIComponent(id)}`),
  jamChat: (id: string) => get<{ messages: ChatMessage[] }>(`/api/jam/${id}/chat`),
  jamSay: (id: string, text: string) => send<{ message: ChatMessage }>('POST', `/api/jam/${id}/chat`, { text }),
};

export interface FriendsState {
  friends: { username: string; displayName: string; since: number }[];
  incoming: { username: string; displayName: string; at: number }[];
  outgoing: { username: string; at: number }[];
  blocked: { username: string; at: number }[];
}
/** A Jam chat message (plain text, in memory on the server): always rendered as text. */
export interface ChatMessage { id: string; from: string; text: string; at: number; displayName?: string }
export interface MyProfile { username: string; displayName: string; bio: string; avatar: string | null; showStats: boolean; shareActivity: boolean }
export interface ProfilePlaylist { id: string; name: string; description: string; cover: string | null; count: number; duration: number; thumbnails: (string | null)[] }
export interface Profile {
  username: string;
  displayName: string;
  bio: string;
  avatar: string | null;
  self: boolean;
  friendsSince: number | null;
  playlists: ProfilePlaylist[];
  activity: {
    now: { track: Track; at: number; live: boolean } | null;
    stats: { days: number; plays: number; minutes: number; topArtists: { name: string; n: number }[]; topTracks: { track: Track; n: number }[] };
  } | null;
}
export interface Correspondent { username: string; displayName: string; friend: boolean }
export interface Conversation { with: Correspondent; last: PrivateMessage; unread: number }
/** A private message as stored by the server: encrypted (lib/e2e.ts), never any text. */
export interface PrivateMessage { id: string; from: string; at: number; v: 1; iv: string; ct: string; fp: string; toFp: string }

export function isUrl(str: string): boolean {
  try {
    const u = new URL(str.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface FriendActivity { user: string; displayName: string; track: Track; at: number; live: boolean }
export interface BlendResult { with: User; tracks: Track[]; common: number; match: number }
