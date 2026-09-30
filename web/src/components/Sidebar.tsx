import { Home, Search, Library, Heart, History, Plus, Settings, X, LogOut, Cloud, CloudOff, Loader2, Radio, Users, Pin, Folder } from 'lucide-react';
import type { Playlist } from '../lib/types';
import { useJam, useShared } from '../store/social';
import { useSync, logout } from '../lib/sync';
import { useUi, type View } from '../store/ui';
import { useLibrary } from '../store/library';
import { usePlayer } from '../store/player';
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

export function Sidebar() {
  const view = useUi((s) => s.view);
  const navigate = useUi((s) => s.navigate);
  const open = useUi((s) => s.sidebarOpen);
  const setOpen = useUi((s) => s.setSidebarOpen);
  const playlists = useLibrary((s) => s.playlists);
  const likedCount = useLibrary((s) => s.liked.length);
  const createPlaylist = useLibrary((s) => s.createPlaylist);
  const playingUrl = usePlayer((s) => (s.playing ? s.queue[s.index]?.url : undefined));
  const sharedLists = useShared((s) => s.list);
  const inJam = useJam((s) => !!s.jam);
  const social = useJam((s) => !!s.me);
  const setJamOpen = useUi((s) => s.setJamOpen);

  const item = (v: View, icon: React.ReactNode, label: string) => (
    <button className={`nav-item ${view.name === v.name && view.id === v.id ? 'active' : ''}`} onClick={() => navigate(v)}>
      {icon}<span>{label}</span>
    </button>
  );

  return (
    <>
      <div className={`sidebar-backdrop ${open ? 'open' : ''}`} onClick={() => setOpen(false)} />
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="sidebar-top">
          <Logo />
          <button className="icon-btn only-mobile" onClick={() => setOpen(false)} aria-label="Fermer le menu"><X size={20} /></button>
        </div>
        <nav className="nav">
          {item({ name: 'home' }, <Home size={20} />, 'Accueil')}
          {item({ name: 'search' }, <Search size={20} />, 'Rechercher')}
          {item({ name: 'library' }, <Library size={20} />, 'Bibliothèque')}
        </nav>
        <div className="nav-section">
          <button className="nav-item" onClick={() => { const p = createPlaylist(`Ma playlist n°${playlists.length + 1}`); navigate({ name: 'playlist', id: p.id }); }}>
            <span className="nav-square add"><Plus size={16} /></span><span>Créer une playlist</span>
          </button>
          <button className={`nav-item ${view.name === 'liked' ? 'active' : ''}`} onClick={() => navigate({ name: 'liked' })}>
            <span className="nav-square liked"><Heart size={14} fill="currentColor" /></span><span>Titres likés</span><span className="count">{likedCount}</span>
          </button>
          <button className={`nav-item ${view.name === 'history' ? 'active' : ''}`} onClick={() => navigate({ name: 'history' })}>
            <span className="nav-square hist"><History size={15} /></span><span>Historique</span>
          </button>
          {social && (
            <button className={`nav-item ${inJam ? 'active' : ''}`} onClick={() => { setJamOpen(true); setOpen(false); }}>
              <span className="nav-square jam"><Radio size={15} /></span><span>{inJam ? 'Jam en cours' : 'Jam : écouter ensemble'}</span>
            </button>
          )}
        </div>
        <div className="playlist-nav">
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
        </div>
        <UserBlock />
        {item({ name: 'settings' }, <Settings size={20} />, 'Paramètres')}
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
  if (!user) return null;
  const busy = status === 'saving' || status === 'pending' || status === 'loading';
  const bad = status === 'offline' || status === 'error';
  return (
    <div className="user-block">
      <span className="avatar" aria-hidden>{user.displayName.slice(0, 1).toUpperCase()}</span>
      <div className="grow">
        <div className="ellipsis user-name">{user.displayName}</div>
        <div className={`sync-status ${bad ? 'bad' : ''}`} title="Playlists, likes, historique et file d'attente sont sauvegardés sur le serveur">
          {busy ? <Loader2 size={11} className="spin" /> : bad ? <CloudOff size={11} /> : <Cloud size={11} />} {STATUS[status] || ''}
        </div>
      </div>
      {user.username !== 'local' && <button className="icon-btn" onClick={() => logout()} title="Se déconnecter" aria-label="Se déconnecter"><LogOut size={17} /></button>}
    </div>
  );
}
