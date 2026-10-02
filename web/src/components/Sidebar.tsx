import { Home, Search, Library, RadioTower, Heart, History, Plus, Settings, X, LogOut, Cloud, CloudOff, Loader2, Radio, Users, Pin, Folder, BarChart3, UserPlus, MessageCircle, ChevronRight, MicVocal, CircleArrowDown } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Playlist } from '../lib/types';
import { useInbox, useJam, usePeople, useShared } from '../store/social';
import { useSync, logout } from '../lib/sync';
import { useUi, type View } from '../store/ui';
import { useLibrary } from '../store/library';
import { usePlayer } from '../store/player';
import { useOffline } from '../store/offline';
import { Mosaic } from './Cover';
import { PlayingBars } from './TrackList';

export function Logo() {
  return (
    <div className="logo">
      <img src="/icon.svg" alt="" width={32} height={32} />
      <span>Forge <b>Audio</b></span>
    </div>
  );
}

/** Pinned first, then playlists without a folder, then one group per folder (alphabetical). */
function groupPlaylists(playlists: Playlist[]): [string | null, Playlist[]][] {
  const byPin = [...playlists].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  const loose = byPin.filter((p) => !p.folder || p.pinned);
  const folders = new Map<string, Playlist[]>();
  for (const p of byPin) if (p.folder && !p.pinned) folders.set(p.folder, [...(folders.get(p.folder) || []), p]);
  return [[null, loose], ...[...folders.entries()].sort(([a], [b]) => a.localeCompare(b, 'fr'))];
}

/** Which sidebar sections are folded, per device (nothing stored = all open). */
const FOLD_KEY = 'forge.sidebar.folded';
function readFolded(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') || {}; } catch { return {}; }
}

/** A sidebar section that folds on a click on its title; `badge` shows on the title while folded. */
function Section({ title, open, toggle, badge = 0, badgeLabel, className = '', children }: { title: string; open: boolean; toggle: () => void; badge?: number; badgeLabel?: string; className?: string; children: ReactNode }) {
  return (
    <section className={`side-sec ${className} ${open ? 'open' : ''}`}>
      <button className="side-sec-head" aria-expanded={open} onClick={toggle}>
        <ChevronRight size={14} className="chev" aria-hidden /><span className="grow">{title}</span>
        {!open && badge > 0 && <span className="badge" aria-label={badgeLabel}>{badge}</span>}
      </button>
      {open && <div className="side-sec-body">{children}</div>}
    </section>
  );
}

export function Sidebar() {
  const view = useUi((s) => s.view);
  const navigate = useUi((s) => s.navigate);
  const open = useUi((s) => s.sidebarOpen);
  const setOpen = useUi((s) => s.setSidebarOpen);
  const playlists = useLibrary((s) => s.playlists);
  const likedCount = useLibrary((s) => s.liked.length);
  const offlineCount = useOffline((s) => Object.keys(s.items).length);
  const createPlaylist = useLibrary((s) => s.createPlaylist);
  const playingUrl = usePlayer((s) => (s.playing ? s.queue[s.index]?.url : undefined));
  const sharedLists = useShared((s) => s.list);
  const inJam = useJam((s) => !!s.jam);
  const social = useJam((s) => !!s.me);
  const setJamOpen = useUi((s) => s.setJamOpen);
  const panel = useUi((s) => s.panel);
  const togglePanel = useUi((s) => s.togglePanel);
  const requests = usePeople((s) => s.incoming.length);
  const unread = useInbox((s) => s.unread);
  const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
  const [folded, setFolded] = useState(readFolded);
  const fold = (id: string) => ({
    open: !folded[id],
    toggle: () => {
      const next = { ...folded, [id]: !folded[id] };
      setFolded(next);
      try { localStorage.setItem(FOLD_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    },
  });
  // The playlist list fills the height left and scrolls on its own; when less than ~200 px would be
  // left (phone in landscape, every section open), the whole drawer scrolls instead: never two scrollbars.
  const aside = useRef<HTMLElement>(null);
  const [flow, setFlow] = useState(false);
  useLayoutEffect(() => {
    const sb = aside.current;
    if (!sb) return;
    const check = () => {
      const body = sb.querySelector<HTMLElement>('.side-pl .side-sec-body');
      if (!body) return setFlow(false);
      const free = sb.clientHeight - (sb.scrollHeight - body.offsetHeight);
      setFlow(free < Math.min(200, body.scrollHeight));
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(sb);
    return () => ro.disconnect();
  });
  const socialLabel = [requests && plural(requests, 'demande d’ami', 'demandes d’ami'), unread && plural(unread, 'message non lu', 'messages non lus')].filter(Boolean).join(', ');

  const item = (v: View, icon: ReactNode, label: string) => (
    <button className={`nav-item ${view.name === v.name && view.id === v.id ? 'active' : ''}`} onClick={() => navigate(v)}>
      {icon}<span>{label}</span>
    </button>
  );

  return (
    <>
      <div className={`sidebar-backdrop ${open ? 'open' : ''}`} onClick={() => setOpen(false)} />
      <aside ref={aside} className={`sidebar ${open ? 'open' : ''} ${flow ? 'flow' : ''}`}>
        <div className="sidebar-top">
          <Logo />
          <button className="icon-btn only-mobile" onClick={() => setOpen(false)} aria-label="Fermer le menu"><X size={20} /></button>
        </div>
        <Section title="Navigation" {...fold('nav')}>
          {item({ name: 'home' }, <Home size={20} />, 'Accueil')}
          {item({ name: 'search' }, <Search size={20} />, 'Rechercher')}
          {item({ name: 'artists' }, <MicVocal size={20} />, 'Artistes')}
          {item({ name: 'library' }, <Library size={20} />, 'Bibliothèque')}
          <button className={`nav-item ${view.name === 'radio' ? 'active' : ''}`} onClick={() => navigate({ name: 'radio' })}><RadioTower size={20} /><span>Radios</span></button>
        </Section>
        <Section title="Ma musique" {...fold('music')}>
          <button className="nav-item" onClick={() => { const p = createPlaylist(`Ma playlist n°${playlists.length + 1}`); navigate({ name: 'playlist', id: p.id }); }}>
            <span className="nav-square add"><Plus size={16} /></span><span>Créer une playlist</span>
          </button>
          <button className={`nav-item ${view.name === 'liked' ? 'active' : ''}`} onClick={() => navigate({ name: 'liked' })}>
            <span className="nav-square liked"><Heart size={14} fill="currentColor" /></span><span>Titres likés</span><span className="count">{likedCount}</span>
          </button>
          <button className={`nav-item ${view.name === 'history' ? 'active' : ''}`} onClick={() => navigate({ name: 'history' })}>
            <span className="nav-square hist"><History size={15} /></span><span>Historique</span>
          </button>
          <button className={`nav-item ${view.name === 'offline' ? 'active' : ''}`} onClick={() => navigate({ name: 'offline' })}>
            <span className="nav-square hist"><CircleArrowDown size={15} /></span><span>Hors ligne</span>{offlineCount > 0 && <span className="count">{offlineCount}</span>}
          </button>
          <button className={`nav-item ${view.name === 'stats' ? 'active' : ''}`} onClick={() => navigate({ name: 'stats' })}>
            <span className="nav-square hist"><BarChart3 size={15} /></span><span>Vos stats</span>
          </button>
        </Section>
        {social && (
          <Section title="Social" {...fold('social')} badge={requests + unread} badgeLabel={socialLabel}>
            <button className={`nav-item ${view.name === 'friends' ? 'active' : ''}`} onClick={() => navigate({ name: 'friends' })}>
              <span className="nav-square jam"><UserPlus size={15} /></span><span>Amis</span>{requests > 0 && <span className="badge" aria-label={plural(requests, 'demande d’ami en attente', 'demandes d’ami en attente')}>{requests}</span>}
            </button>
            <button className={`nav-item ${view.name === 'messages' ? 'active' : ''}`} onClick={() => navigate({ name: 'messages' })}>
              <span className="nav-square jam"><MessageCircle size={15} /></span><span>Messages</span>{unread > 0 && <span className="badge" aria-label={plural(unread, 'message non lu', 'messages non lus')}>{unread}</span>}
            </button>
            <button className={`nav-item ${panel === 'friends' ? 'active' : ''}`} onClick={() => { togglePanel('friends'); setOpen(false); }}>
              <span className="nav-square jam"><Users size={15} /></span><span>Activité des amis</span>
            </button>
            <button className={`nav-item ${inJam ? 'active' : ''}`} onClick={() => { setJamOpen(true); setOpen(false); }}>
              <span className="nav-square jam"><Radio size={15} /></span><span>{inJam ? 'Écoute partagée en cours' : 'Écoute partagée'}</span>
            </button>
          </Section>
        )}
        <Section title={`Playlists (${sharedLists.length + playlists.length})`} {...fold('playlists')} className="side-pl">
          {sharedLists.map((p) => (
            <button key={`s-${p.id}`} className={`nav-pl ${view.name === 'shared' && view.id === p.id ? 'active' : ''}`} onClick={() => navigate({ name: 'shared', id: p.id })}>
              <Mosaic covers={p.cover ? [p.cover] : p.tracks.map((t) => t.thumbnail)} size={36} radius={4} />
              <span className="ellipsis grow">{p.name}</span>
              <Users size={13} className="muted" aria-label="Partagée" />
              {playingUrl && p.tracks.some((t) => t.url === playingUrl) && <PlayingBars />}
            </button>
          ))}
          {groupPlaylists(playlists).map(([folder, list]) => {
            const rows = list.map((p) => (
              <button key={p.id} className={`nav-pl ${view.name === 'playlist' && view.id === p.id ? 'active' : ''}`} onClick={() => navigate({ name: 'playlist', id: p.id })}>
                <Mosaic covers={p.cover ? [p.cover] : p.tracks.map((t) => t.thumbnail)} size={36} radius={4} />
                <span className="ellipsis grow">{p.name}</span>
                {p.pinned && <Pin size={12} className="muted" aria-label="Épinglée" />}
                {playingUrl && p.tracks.some((t) => t.url === playingUrl) && <PlayingBars />}
              </button>
            ));
            return folder ? (
              <details key={`f-${folder}`} className="nav-folder" open>
                <summary><Folder size={14} /> <span className="ellipsis">{folder}</span> <span className="muted small">{list.length}</span></summary>
                {rows}
              </details>
            ) : rows;
          })}
          {!sharedLists.length && !playlists.length && <p className="muted small side-empty">Aucune playlist pour l’instant.</p>}
        </Section>
        <div className="side-foot">
          <UserBlock />
          {item({ name: 'settings' }, <Settings size={20} />, 'Paramètres')}
          <LegalLinks />
        </div>
      </aside>
    </>
  );
}

const STATUS: Record<string, string> = {
  saved: 'Sauvegardé',
  saving: 'Sauvegarde…',
  pending: 'Sauvegarde…',
  loading: 'Chargement…',
  offline: 'Hors ligne, en attente',
  error: 'Sauvegarde en échec, nouvel essai…',
};

function UserBlock() {
  const user = useSync((s) => s.user);
  const status = useSync((s) => s.status);
  const navigate = useUi((s) => s.navigate);
  if (!user) return null;
  const busy = status === 'saving' || status === 'pending' || status === 'loading';
  const bad = status === 'offline' || status === 'error';
  return (
    <div className="user-block">
      <span className="avatar" aria-hidden>{user.displayName.slice(0, 1).toUpperCase()}</span>
      <div className="grow">
        {user.username !== 'local'
          ? <button className="friend-link ellipsis user-name" onClick={() => navigate({ name: 'profile', id: user.username })} title="Mon profil">{user.displayName}</button>
          : <div className="ellipsis user-name">{user.displayName}</div>}
        <div className={`sync-status ${bad ? 'bad' : ''}`} title="Playlists, likes, historique et file d'attente sont sauvegardés sur le serveur">
          {busy ? <Loader2 size={11} className="spin" /> : bad ? <CloudOff size={11} /> : <Cloud size={11} />} {STATUS[status] || ''}
        </div>
      </div>
      {user.username !== 'local' && <button className="icon-btn" onClick={() => logout()} title="Se déconnecter" aria-label="Se déconnecter"><LogOut size={17} /></button>}
    </div>
  );
}

/** Links to the static legal pages (web/public/*.html, served next to the app). */
export function LegalLinks() {
  return (
    <nav className="legal-links" aria-label="Informations légales">
      <a href="/mentions-legales.html">Mentions légales</a>
      <a href="/confidentialite.html">Confidentialité</a>
      <a href="/cgu.html">CGU</a>
    </nav>
  );
}
