import { ChevronLeft, ChevronRight, Menu, Search as SearchIcon, Loader2, Lock, Eye, EyeOff, User as UserIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useUi } from './store/ui';
import { usePlayer } from './store/player';
import { Sidebar, Logo } from './components/Sidebar';
import { PlayerBar } from './components/PlayerBar';
import { RightPanel, MiniVideo } from './components/Panels';
import { NowPlaying } from './components/NowPlaying';
import { ContextMenu } from './components/ContextMenu';
import { PlaylistPicker } from './components/PlaylistPicker';
import { Equalizer } from './components/Equalizer';
import { Toasts } from './components/Toasts';
import { Home } from './views/Home';
import { Search } from './views/Search';
import { ArtistView, AlbumView, MixView, GenreView } from './views/Catalog';
import { StatsView, BlendView } from './views/Stats';
import { openLink } from './views/Home';
import { Library, PlaylistView, Liked, HistoryView } from './views/Library';
import { Settings } from './views/Settings';
import { SharedPlaylistView } from './views/Shared';
import { JamPanel, JamBanner } from './components/Jam';
import { SelectionBar } from './components/SelectionBar';
import { startSocial } from './store/social';
import { useAudioEffects, useAudioMix, useMediaSession, useRemoteControl, useShortcuts, useTheme } from './hooks';
import { api, type User } from './lib/api';
import { startSync } from './lib/sync';

function CurrentView() {
  const view = useUi((s) => s.view);
  switch (view.name) {
    case 'search': return <Search />;
    case 'artist': return <ArtistView key={`${view.q}:${view.id || ''}`} />;
    case 'album': return <AlbumView key={view.id} />;
    case 'mix': return <MixView key={view.id} />;
    case 'stats': return <StatsView />;
    case 'genre': return <GenreView key={view.id} />;
    case 'blend': return <BlendView key={view.id} />;
    case 'library': return <Library />;
    case 'playlist': return <PlaylistView key={view.id} />;
    case 'shared': return <SharedPlaylistView key={view.id} />;
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
  useAudioMix();
  useRemoteControl();

  const enter = async (user: User | null, sync: boolean) => {
    // Shared playlists, Jam and the Discord link need real accounts (not the desktop app's local mode).
    if (user && user.username !== 'local') startSocial(user);
    // Share links: https://…/?open=<url of a track or playlist>
    const shared = user ? new URLSearchParams(location.search).get('open') : null;
    if (shared && /^https?:\/\//.test(shared)) {
      history.replaceState(null, '', location.pathname);
      openLink(shared).catch((err) => useUi.getState().toast((err as Error).message, 'error'));
    }
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
          <JamBanner />
          <CurrentView />
        </div>
      </main>
      <RightPanel />
      <PlayerBar />
      <NowPlaying />
      <MiniVideo />
      <ContextMenu />
      <PlaylistPicker />
      <Equalizer />
      <JamPanel />
      <SelectionBar />
      <Toasts />
    </div>
  );
}
