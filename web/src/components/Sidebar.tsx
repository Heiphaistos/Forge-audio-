import { Home, Search, Library, Heart, History, Plus, Settings, X } from 'lucide-react';
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

export function Sidebar() {
  const view = useUi((s) => s.view);
  const navigate = useUi((s) => s.navigate);
  const open = useUi((s) => s.sidebarOpen);
  const setOpen = useUi((s) => s.setSidebarOpen);
  const playlists = useLibrary((s) => s.playlists);
  const likedCount = useLibrary((s) => s.liked.length);
  const createPlaylist = useLibrary((s) => s.createPlaylist);
  const playingUrl = usePlayer((s) => (s.playing ? s.queue[s.index]?.url : undefined));

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
        </div>
        <div className="playlist-nav">
          {playlists.map((p) => (
            <button key={p.id} className={`nav-pl ${view.name === 'playlist' && view.id === p.id ? 'active' : ''}`} onClick={() => navigate({ name: 'playlist', id: p.id })}>
              <Mosaic covers={p.cover ? [p.cover] : p.tracks.map((t) => t.thumbnail)} size={36} radius={4} />
              <span className="ellipsis grow">{p.name}</span>
              {playingUrl && p.tracks.some((t) => t.url === playingUrl) && <PlayingBars />}
            </button>
          ))}
        </div>
        {item({ name: 'settings' }, <Settings size={20} />, 'Paramètres')}
      </aside>
    </>
  );
}
