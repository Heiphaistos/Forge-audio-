import { create } from 'zustand';
import { api, type ChatMessage, type Conversation, type Correspondent, type DiscordLink, type FriendActivity, type FriendsState, type Jam, type SharedPlaylist, type User } from '../lib/api';
import { useLibrary } from './library';
import { pullNow } from '../lib/sync';
import { engine } from '../audio/engine';
import type { Track } from '../lib/types';
import { usePlayer, setJamRouter } from './player';
import { useSettings, useUi } from './ui';

/**
 * Between accounts: friends, private messages, shared playlists, Jam (group listening + chat) and
 * the Discord link, all kept up to date by the server's live events (/api/events).
 */

const toast = (text: string, kind?: 'info' | 'error' | 'success', action?: { label: string; run: () => void }) => useUi.getState().toast(text, kind, action);
const fail = (err: unknown) => toast((err as Error).message, 'error');

export const useShared = create<{ list: SharedPlaylist[]; loaded: boolean }>(() => ({ list: [], loaded: false }));
export const useDiscord = create<{ link: DiscordLink | null; botEnabled: boolean }>(() => ({ link: null, botEnabled: false }));
/** `offset` = server clock - this device's clock (ms), to place the shared playback position. */
export const useFriends = create<{ list: FriendActivity[]; loaded: boolean }>(() => ({ list: [], loaded: false }));
const putFriend = (f: FriendActivity) => useFriends.setState((s) => ({ list: [f, ...s.list.filter((x) => x.user !== f.user)] }));

export const useJam = create<{ jam: Jam | null; offset: number; me: string | null }>(() => ({ jam: null, offset: 0, me: null }));

/** Friends, requests received / sent, blocked accounts. */
export const usePeople = create<FriendsState & { loaded: boolean }>(() => ({ friends: [], incoming: [], outgoing: [], blocked: [], loaded: false }));
/** Private messages: conversation list + the conversation open on screen. */
export const useInbox = create<{ conversations: Conversation[]; unread: number; open: string | null; with: Correspondent | null; thread: ChatMessage[]; readByOther: number; loading: boolean }>(
  () => ({ conversations: [], unread: 0, open: null, with: null, thread: [], readByOther: 0, loading: false }),
);
/** Chat of the current Jam (in memory on the server, gone with the Jam). */
export const useJamChat = create<{ jamId: string | null; messages: ChatMessage[]; unread: number }>(() => ({ jamId: null, messages: [], unread: 0 }));

let accountsCache: User[] | null = null;
/** Accounts one can share with or invite: friends only. */
export async function otherAccounts() {
  if (!accountsCache) accountsCache = (await api.users()).users;
  return accountsCache;
}
export const nameOf = (username: string) => usePeople.getState().friends.find((u) => u.username === username)?.displayName
  || accountsCache?.find((u) => u.username === username)?.displayName || username;

// ---------------------------------------------------------------- friends
async function refreshPeople() {
  const state = await api.friendsAll();
  accountsCache = null;
  usePeople.setState({ ...state, loaded: true });
}
const thenRefresh = (fn: (username: string) => Promise<unknown>) => async (username: string) => { await fn(username); await refreshPeople(); };
export const people = {
  refresh: refreshPeople,
  request: async (username: string) => { const r = await api.friendRequest(username); await refreshPeople(); return r.status; },
  accept: thenRefresh(api.friendAccept),
  decline: thenRefresh(api.friendDecline),
  cancel: thenRefresh(api.friendCancel),
  remove: thenRefresh(api.friendRemove),
  block: thenRefresh(api.block),
  unblock: thenRefresh(api.unblock),
};

// ---------------------------------------------------------------- private messages
async function refreshInbox() {
  const { conversations, unread } = await api.conversations();
  useInbox.setState({ conversations, unread });
}
function appendThread(username: string, m: ChatMessage) {
  const s = useInbox.getState();
  if (s.open === username && !s.thread.some((x) => x.id === m.id)) useInbox.setState({ thread: [...s.thread, m] });
}
export const inbox = {
  refresh: refreshInbox,
  /** Show a conversation (null = back to the list) and mark it read. */
  open: async (username: string | null) => {
    useInbox.setState({ open: username, with: null, thread: [], readByOther: 0, loading: !!username });
    if (!username) return;
    try {
      const r = await api.conversation(username);
      if (useInbox.getState().open !== username) return;
      useInbox.setState({ with: r.with, thread: r.messages, readByOther: r.readByOther, loading: false });
      if (r.messages.length) await api.readMessages(username);
    } catch (err) { useInbox.setState({ loading: false }); fail(err); }
  },
  send: async (username: string, text: string) => {
    const { message } = await api.sendMessage(username, text);
    appendThread(username, message);
  },
  clear: async (username: string) => {
    await api.clearConversation(username);
    if (useInbox.getState().open === username) useInbox.setState({ thread: [] });
    await refreshInbox();
  },
};

// ---------------------------------------------------------------- Jam chat
async function loadJamChat(id: string) {
  useJamChat.setState({ jamId: id, messages: [], unread: 0 });
  try {
    const { messages } = await api.jamChat(id);
    if (useJamChat.getState().jamId === id) useJamChat.setState({ messages });
  } catch { /* the Jam just ended */ }
}
export async function jamSay(text: string) {
  const j = useJam.getState().jam;
  if (!j) return;
  const { message } = await api.jamSay(j.id, text);
  const s = useJamChat.getState();
  if (s.jamId === j.id && !s.messages.some((x) => x.id === message.id)) useJamChat.setState({ messages: [...s.messages, message] });
}

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
  if (!j) useJamChat.setState({ jamId: null, messages: [], unread: 0 });
  else if (useJamChat.getState().jamId !== j.id) loadJamChat(j.id);
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
let started = false;
let retries = 0;

/**
 * The browser retries a dropped stream by itself, but gives up for good after an HTTP error (nginx
 * answers 502 while the server restarts for a deployment): reopen it ourselves, 2 s then up to 30 s.
 */
function connect(onEvent: (m: MessageEvent) => void) {
  source = new EventSource('/api/events');
  source.onopen = () => { retries = 0; };
  source.onmessage = onEvent;
  source.onerror = () => {
    if (source?.readyState !== EventSource.CLOSED) return;
    source = null;
    setTimeout(() => { if (!source) connect(onEvent); }, Math.min(30_000, 2000 * 2 ** retries++));
  };
}

async function refreshAll() {
  const [s, j, , , f] = await Promise.allSettled([api.shared(), api.jam(), discord.refresh(), refreshPeople(), api.friends(), refreshInbox()]);
  if (s.status === 'fulfilled') useShared.setState({ list: s.value.playlists, loaded: true });
  if (f.status === 'fulfilled') useFriends.setState({ list: f.value.friends, loaded: true });
  if (j.status === 'fulfilled') setJam(j.value.jam);
}

/** Start after login (App.tsx). The browser reconnects EventSource by itself; each (re)connection resyncs. */
export function startSocial(user: User) {
  useJam.setState({ me: user.username });
  if (started || typeof EventSource === 'undefined') return;
  started = true;
  // Report each track started here (the history entry is pushed when playback really starts).
  useLibrary.subscribe((st, prev) => {
    const h = st.history[0];
    if (!h || h === prev.history[0] || Date.now() - h.at > 10_000 || !useSettings.getState().shareActivity) return;
    api.activity(h.track).catch(() => {});
  });
  const onEvent = (m: MessageEvent) => {
    let e: { type: string; [k: string]: unknown };
    try { e = JSON.parse(m.data); } catch { return; }
    if (e.type === 'hello') refreshAll();
    else if (e.type === 'library') pullNow();
    else if (e.type === 'discord') discord.refresh().catch(() => {});
    else if (e.type === 'profile') {
      // A friend (or I, elsewhere) changed name, bio, picture or options.
      window.dispatchEvent(new CustomEvent('forge:profile', { detail: String(e.user) }));
      refreshPeople().catch(() => {});
      accountsCache = null;
    }
    else if (e.type === 'activity') putFriend(e as unknown as FriendActivity);
    else if (e.type === 'friends') {
      const before = new Set(usePeople.getState().incoming.map((r) => r.username));
      refreshPeople().then(() => {
        const fresh = usePeople.getState().incoming.find((r) => !before.has(r.username));
        if (fresh) toast(`${fresh.displayName} vous demande en ami`, 'info', { label: 'Voir', run: () => useUi.getState().navigate({ name: 'friends' }) });
      }).catch(() => {});
      api.friends().then((r) => useFriends.setState({ list: r.friends, loaded: true })).catch(() => {});
    } else if (e.type === 'message') {
      const other = String(e.with);
      const m = e.message as ChatMessage;
      appendThread(other, m);
      const here = useInbox.getState().open === other && document.visibilityState === 'visible';
      if (m.from !== user.username) {
        if (here) api.readMessages(other).catch(() => {});
        else toast(`${String(e.displayName || other)} : ${m.text.length > 80 ? `${m.text.slice(0, 80)}…` : m.text}`, 'info', { label: 'Répondre', run: () => useUi.getState().navigate({ name: 'messages', id: other }) });
      }
      refreshInbox().catch(() => {});
    } else if (e.type === 'message-read' || e.type === 'message-cleared') {
      if (e.type === 'message-cleared' && useInbox.getState().open === String(e.with)) useInbox.setState({ thread: [] });
      refreshInbox().catch(() => {});
    } else if (e.type === 'message-read-by') {
      if (useInbox.getState().open === String(e.with)) useInbox.setState({ readByOther: Number(e.at) || Date.now() });
    } else if (e.type === 'jam-chat') {
      const c = useJamChat.getState();
      const m = e.message as ChatMessage;
      if (c.jamId === e.jamId && !c.messages.some((x) => x.id === m.id)) {
        // Jam window closed: say it, or the message goes unnoticed.
        const away = m.from !== user.username && !useUi.getState().jamOpen;
        useJamChat.setState({ messages: [...c.messages, m].slice(-200), unread: c.unread + (away ? 1 : 0) });
        if (away) toast(`${m.displayName || m.from} (Jam) : ${m.text.length > 80 ? `${m.text.slice(0, 80)}…` : m.text}`, 'info', { label: 'Ouvrir', run: () => useUi.getState().setJamOpen(true) });
      }
    }
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
  connect(onEvent);
  // Back to the app (phone woken up, tab shown again) while the stream is down: reconnect now.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !source) { retries = 0; connect(onEvent); }
  });
}
