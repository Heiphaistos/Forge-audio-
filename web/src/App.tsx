import { ChevronLeft, ChevronRight, Menu, Search as SearchIcon, Loader2, Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useUi } from './store/ui';
import { usePlayer } from './store/player';
import { Sidebar, Logo } from './components/Sidebar';
import { PlayerBar } from './components/PlayerBar';
import { RightPanel } from './components/Panels';
import { NowPlaying } from './components/NowPlaying';
import { ContextMenu } from './components/ContextMenu';
import { PlaylistPicker } from './components/PlaylistPicker';
import { Equalizer } from './components/Equalizer';
import { Toasts } from './components/Toasts';
import { Home } from './views/Home';
import { Search, Artist } from './views/Search';
import { Library, PlaylistView, Liked, HistoryView } from './views/Library';
import { Settings } from './views/Settings';
import { useMediaSession, useShortcuts, useTheme } from './hooks';
import { api } from './lib/api';

function CurrentView() {
  const view = useUi((s) => s.view);
  switch (view.name) {
    case 'search': return <Search />;
    case 'artist': return <Artist key={view.q} />;
    case 'library': return <Library />;
    case 'playlist': return <PlaylistView key={view.id} />;
    case 'liked': return <Liked />;
    case 'history': return <HistoryView />;
    case 'settings': return <Settings />;
    default: return <Home />;
  }
}

function TopBar() {
  const { back, forward, goBack, goForward, navigate, setSidebarOpen, view } = useUi();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const el = document.querySelector('.main-scroll');
    const onScroll = () => setScrolled((el?.scrollTop || 0) > 10);
    el?.addEventListener('scroll', onScroll);
    return () => el?.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <div className={`topbar ${scrolled ? 'scrolled' : ''}`}>
      <button className="icon-btn only-mobile" onClick={() => setSidebarOpen(true)} aria-label="Menu"><Menu size={22} /></button>
      <button className="icon-btn round hide-mobile" disabled={!back.length} onClick={goBack} aria-label="Précédent"><ChevronLeft size={20} /></button>
      <button className="icon-btn round hide-mobile" disabled={!forward.length} onClick={goForward} aria-label="Suivant"><ChevronRight size={20} /></button>
      <div className="grow only-mobile center"><Logo /></div>
      <div className="grow hide-mobile" />
      {view.name !== 'search' && (
        <button className="topbar-search" onClick={() => navigate({ name: 'search' })}>
          <SearchIcon size={16} /> <span className="hide-mobile">Rechercher</span><kbd className="hide-mobile">Ctrl K</kbd>
        </button>
      )}
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  return (
    <div className="login">
      <form className="login-card" onSubmit={async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try { await api.login(token); onDone(); } catch (err) { setError((err as Error).message); } finally { setLoading(false); }
      }}>
        <Logo />
        <p className="muted"><Lock size={14} /> Ce serveur Forge Audio est protégé par un mot de passe.</p>
        <input className="input" type="password" autoFocus placeholder="Mot de passe" value={token} onChange={(e) => setToken(e.target.value)} />
        {error && <p className="bad small">{error}</p>}
        <button className="btn btn-primary full" disabled={loading || !token}>{loading ? <Loader2 size={16} className="spin" /> : 'Entrer'}</button>
      </form>
    </div>
  );
}

export function App() {
  const [auth, setAuth] = useState<'checking' | 'ok' | 'required'>('checking');
  const panel = useUi((s) => s.panel);
  const hasTrack = usePlayer((s) => s.index >= 0 && s.queue.length > 0);
  useMediaSession();
  useShortcuts();
  useTheme();

  useEffect(() => {
    api.health()
      .then((h) => setAuth(h.authRequired && !h.authenticated ? 'required' : 'ok'))
      .catch(() => setAuth('ok'));
  }, []);

  if (auth === 'checking') return <div className="splash"><Logo /><Loader2 className="spin" /></div>;
  if (auth === 'required') return <Login onDone={() => setAuth('ok')} />;

  return (
    <div className={`app ${panel ? 'with-panel' : ''} ${hasTrack ? 'has-track' : ''}`}>
      <Sidebar />
      <main className="main">
        <div className="main-tint" />
        <div className="main-scroll">
          <TopBar />
          <CurrentView />
        </div>
      </main>
      <RightPanel />
      <PlayerBar />
      <NowPlaying />
      <ContextMenu />
      <PlaylistPicker />
      <Equalizer />
      <Toasts />
    </div>
  );
}
