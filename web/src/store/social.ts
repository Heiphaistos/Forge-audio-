import { create } from 'zustand';
import { api, type DiscordLink, type Jam, type SharedPlaylist, type User } from '../lib/api';
import { pullNow } from '../lib/sync';
import { engine } from '../audio/engine';
import type { Track } from '../lib/types';
import { usePlayer, setJamRouter } from './player';
import { useUi } from './ui';

/**
 * Between accounts: shared playlists, Jam (group listening) and the Discord link, all kept up to
 * date by the server's live events (/api/events).
 */

const toast = (text: string, kind?: 'info' | 'error' | 'success', action?: { label: string; run: () => void }) => useUi.getState().toast(text, kind, action);
const fail = (err: unknown) => toast((err as Error).message, 'error');

export const useShared = create<{ list: SharedPlaylist[]; loaded: boolean }>(() => ({ list: [], loaded: false }));
export const useDiscord = create<{ link: DiscordLink | null; botEnabled: boolean }>(() => ({ link: null, botEnabled: false }));
/** `offset` = server clock - this device's clock (ms), to place the shared playback position. */
export const useJam = create<{ jam: Jam | null; offset: number; me: string | null }>(() => ({ jam: null, offset: 0, me: null }));

let accountsCache: User[] | null = null;
export async function otherAccounts() {
  if (!accountsCache) accountsCache = (await api.users()).users;
  return accountsCache;
}
export const nameOf = (username: string) => accountsCache?.find((u) => u.username === username)?.displayName || username;

// ---------------------------------------------------------------- shared playlists
function putShared(p: SharedPlaylist) {
  const list = useShared.getState().list.filter((x) => x.id !== p.id);
  useShared.setState({ list: [p, ...list].sort((a, b) => b.updatedAt - a.updatedAt) });
}
function dropShared(id: string) {
  useShared.setState({ list: useShared.getState().list.filter((x) => x.id !== id) });
}

export const shared = {
  create: async (name: string, tracks: Track[], members: string[], extra: { description?: string; cover?: string | null } = {}) => {
    const { playlist } = await api.sharedCreate({ name, tracks, members, ...extra });
    putShared(playlist);
    return playlist;
  },
  update: async (id: string, patch: Parameters<typeof api.sharedUpdate>[1]) => { putShared((await api.sharedUpdate(id, patch)).playlist); },
  add: async (id: string, tracks: Track[]) => { const r = await api.sharedAdd(id, tracks); putShared(r.playlist); return r.added; },
  remove: async (id: string, url: string) => { putShared((await api.sharedRemove(id, url)).playlist); },
  move: async (id: string, from: number, to: number) => { putShared((await api.sharedMove(id, from, to)).playlist); },
  leave: async (id: string) => { const r = await api.sharedLeave(id); dropShared(id); return r.deleted; },
};

// ---------------------------------------------------------------- Jam
const livePosition = (j: Jam) => (j.playing ? j.position + (Date.now() + useJam.getState().offset - j.positionAt) / 1000 : j.position);

function setJam(j: Jam | null) {
  useJam.setState({ jam: j, offset: j ? j.serverNow - Date.now() : useJam.getState().offset });
  if (j) applyJam(j);
}

/** Make this device play the shared state: same queue, same track, same position (± 2.5 s). */
function applyJam(j: Jam) {
  usePlayer.setState({ queue: j.queue, index: j.index, unshuffled: null, shuffle: false });
  const t = j.queue[j.index];
  if (!t) { if (!engine.paused) engine.pause(); return; }
  const at = livePosition(j);
  if (engine.currentTrack?.url !== t.url) {
    usePlayer.getState().jamLoad(j.index, at, j.playing).catch(() => {});
    return;
  }
  if (Math.abs(engine.currentTime - at) > 2.5) engine.seek(at);
  if (j.playing && engine.paused) {
    engine.play().catch(() => toast('Touchez ▶ pour entendre le Jam (lecture automatique bloquée par le navigateur)', 'info'));
  } else if (!j.playing && !engine.paused) engine.pause();
}

// Drift correction while both play (different networks, buffering).
setInterval(() => {
  const j = useJam.getState().jam;
  if (!j?.playing || engine.paused || engine.currentTrack?.url !== j.queue[j.index]?.url) return;
  if (Math.abs(engine.currentTime - livePosition(j)) > 2.5) engine.seek(livePosition(j));
}, 5000);

const canControl = (j: Jam) => j.host === useJam.getState().me || j.everyoneControls;

export const jam = {
  start: async () => {
    const p = usePlayer.getState();
    const { jam: j } = await api.jamStart({ tracks: p.queue.filter((t) => t.source !== 'local'), index: Math.max(0, p.index), position: engine.currentTrack ? engine.currentTime : 0, playing: p.playing });
    setJam(j);
    return j;
  },
  join: async (code: string) => { const { jam: j } = await api.jamJoin(code); setJam(j); toast(`Vous avez rejoint le Jam de ${nameOf(j.host)}`, 'success'); return j; },
  leave: async () => {
    const j = useJam.getState().jam;
    if (!j) return;
    await api.jamLeave(j.id).catch(() => {});
    useJam.setState({ jam: null });
  },
  invite: async (username: string) => {
    const j = useJam.getState().jam;
    if (!j) return;
    const { online } = await api.jamInvite(j.id, username);
    toast(online ? `Invitation envoyée à ${nameOf(username)}` : `${nameOf(username)} n'est pas connecté : donnez-lui le code ${j.code}`, online ? 'success' : 'info');
  },
  add: async (tracks: Track[], next = false) => {
    const j = useJam.getState().jam;
    if (!j) return null;
    const res = await api.jamAdd(j.id, tracks.filter((t) => t.source !== 'local'), next);
    setJam(res.jam);
    return res.jam;
  },
  remove: async (index: number) => { const j = useJam.getState().jam; if (j) setJam((await api.jamRemove(j.id, index)).jam); },
  control: async (action: string, extra: { position?: number; index?: number; from?: number } = {}) => {
    const j = useJam.getState().jam;
    if (j) setJam((await api.jamControl(j.id, { action, ...extra })).jam);
  },
  everyone: async (on: boolean) => { const j = useJam.getState().jam; if (j) setJam((await api.jamSettings(j.id, on)).jam); },
};

/** While in a Jam, the player's actions go to the shared session (see store/player.ts). */
setJamRouter((op, arg) => {
  const j = useJam.getState().jam;
  if (!j) return false;
  const ctl = (action: string, extra = {}) => {
    if (!canControl(j)) { toast('Seul l\'hôte contrôle la lecture de ce Jam', 'info'); return; }
    jam.control(action, extra).catch(fail);
  };
  switch (op) {
    case 'toggle': ctl(j.playing ? 'pause' : 'play'); break;
    case 'next': ctl('next'); break;
    case 'prev': ctl('prev'); break;
    // Track over on this device: the server moves on once (idempotent), whoever reports it first.
    case 'ended': jam.control('advance', { from: j.index }).catch(() => {}); break;
    case 'seek': ctl('seek', { position: Number(arg) }); break;
    case 'jump': ctl('jump', { index: Number(arg) }); break;
    case 'remove': jam.remove(Number(arg)).catch(fail); break;
    case 'playNow':
      jam.add([arg as Track], true).then((nj) => {
        if (nj && canControl(nj)) return jam.control('jump', { index: nj.index + 1 });
        toast('Ajouté au Jam, joué ensuite', 'success');
      }).catch(fail);
      break;
    case 'playList': case 'addNext':
      jam.add(arg as Track[], true).then(() => toast(`${(arg as Track[]).length > 1 ? `${(arg as Track[]).length} titres ajoutés` : 'Ajouté'} au Jam, joué ensuite`, 'success')).catch(fail);
      break;
    case 'enqueue':
      jam.add(arg as Track[]).then(() => toast(`${(arg as Track[]).length > 1 ? `${(arg as Track[]).length} titres ajoutés` : 'Ajouté'} à la file du Jam`, 'success')).catch(fail);
      break;
    case 'probe': break;
    case 'blocked': toast('Pas disponible pendant un Jam : la file est commune', 'info'); break;
  }
  return true;
});

// ---------------------------------------------------------------- Discord link
export const discord = {
  refresh: async () => { useDiscord.setState(await api.discord()); },
  code: () => api.discordCode(),
  unlink: async () => { await api.discordUnlink(); useDiscord.setState({ link: null }); },
};

// ---------------------------------------------------------------- live events
let source: EventSource | null = null;

async function refreshAll() {
  const [s, j] = await Promise.allSettled([api.shared(), api.jam(), discord.refresh(), otherAccounts()]);
  if (s.status === 'fulfilled') useShared.setState({ list: s.value.playlists, loaded: true });
  if (j.status === 'fulfilled') setJam(j.value.jam);
}

/** Start after login (App.tsx). The browser reconnects EventSource by itself; each (re)connection resyncs. */
export function startSocial(user: User) {
  useJam.setState({ me: user.username });
  if (source || typeof EventSource === 'undefined') return;
  source = new EventSource('/api/events');
  source.onmessage = (m) => {
    let e: { type: string; [k: string]: unknown };
    try { e = JSON.parse(m.data); } catch { return; }
    if (e.type === 'hello') refreshAll();
    else if (e.type === 'library') pullNow();
    else if (e.type === 'discord') discord.refresh().catch(() => {});
    else if (e.type === 'shared') {
      if (e.playlist) {
        const p = e.playlist as SharedPlaylist;
        const isNew = !useShared.getState().list.some((x) => x.id === p.id);
        putShared(p);
        if (isNew && e.by && e.by !== user.username) toast(`${nameOf(String(e.by))} a partagé « ${p.name} » avec vous`, 'success');
      } else dropShared(String(e.id));
    } else if (e.type === 'jam') {
      const before = useJam.getState().jam;
      const next = (e.jam as Jam | null) || null;
      if (!next && before) toast(String(e.reason || 'Vous avez quitté le Jam'));
      if (e.joined && e.joined !== user.username) toast(`${nameOf(String(e.joined))} a rejoint le Jam`);
      const added = e.added as { by: string; count: number; title: string } | undefined;
      if (added && added.by !== user.username) toast(`${nameOf(added.by)} a ajouté ${added.count > 1 ? `${added.count} titres` : `« ${added.title} »`} au Jam`);
      setJam(next);
    } else if (e.type === 'jam-invite') {
      toast(`${String(e.from)} vous invite à son Jam`, 'info', { label: 'Rejoindre', run: () => jam.join(String(e.code)).catch(fail) });
    }
  };
}
