import { ChevronLeft, ChevronRight, Menu, Search as SearchIcon, Loader2, Lock, Eye, EyeOff, User as UserIcon } from 'lucide-react';
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
import { useAudioEffects, useMediaSession, useShortcuts, useTheme } from './hooks';
import { api, type User } from './lib/api';
import { startSync } from './lib/sync';

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

function Login({ onDone }: { onDone: (user: User) => void }) {
  const [username, setUsername] = useState(() => localStorage.getItem('forge.lastUser') || '');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  return (
    <div className="login">
      <div className="login-glow" />
      <form className="login-card" onSubmit={async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
          const { user } = await api.login(username.trim(), password);
          try { localStorage.setItem('forge.lastUser', user.username); } catch { /* quota */ }
          onDone(user);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setLoading(false);
        }
      }}>
        <Logo />
        <div>
          <h1 className="login-title">Connexion</h1>
          <p className="muted small">Retrouvez vos playlists, vos titres likés et votre historique sur tous vos appareils.</p>
        </div>
        <label className="field">
          <span>Identifiant</span>
          <div className="input-icon"><UserIcon size={16} /><input autoFocus={!username} autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Votre identifiant" /></div>
        </label>
        <label className="field">
          <span>Mot de passe</span>
          <div className="input-icon">
            <Lock size={16} />
            <input type={show ? 'text' : 'password'} autoFocus={!!username} autoComplete="current-password" spellCheck={false} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Collez votre mot de passe" />
            <button type="button" className="icon-btn" onClick={() => setShow(!show)} aria-label={show ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}>{show ? <EyeOff size={16} /> : <Eye size={16} />}</button>
          </div>
        </label>
        {error && <p className="bad small">{error}</p>}
        <button className="btn btn-primary full" disabled={loading || !username || !password}>{loading ? <Loader2 size={16} className="spin" /> : 'Se connecter'}</button>
        <p className="muted small center-text">Astuce : laissez votre navigateur enregistrer le mot de passe.</p>
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
  useAudioEffects();

  const enter = async (user: User | null, sync: boolean) => {
    if (user && sync) {
      // Load the saved library before showing the app, so it never flashes empty.
      await Promise.race([startSync(user).catch(() => useUi.getState().toast('Bibliothèque en ligne indisponible, nouvel essai automatique', 'error')), new Promise((r) => setTimeout(r, 8000))]);
    }
    setAuth('ok');
  };

  useEffect(() => {
    api.health()
      .then((h) => (h.authRequired && !h.authenticated ? setAuth('required') : enter(h.user, h.sync)))
      .catch(() => setAuth('ok'));
    const expired = () => setAuth('required');
    window.addEventListener('forge:auth-required', expired);
    return () => window.removeEventListener('forge:auth-required', expired);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (auth === 'checking') return <div className="splash"><Logo /><Loader2 className="spin" /></div>;
  if (auth === 'required') return <Login onDone={(user) => { setAuth('checking'); enter(user, true); }} />;

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
