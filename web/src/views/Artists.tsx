import { Loader2, Search as SearchIcon, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { get, type ArtistCardData } from '../lib/api';
import { useLibrary, artistKey } from '../store/library';
import { useUi } from '../store/ui';
import { ArtistCard } from './Catalog';
import { Cover } from '../components/Cover';

/**
 * « Artistes »: a directory to browse. Popular (Deezer chart), by genre (curated playlists), by
 * country (Deezer's national charts), followed, recently played, and a search. The server keeps
 * every list going with similar artists, so the grid scrolls on as far as the listener goes.
 */

interface Page { artists: ArtistCardData[]; next: number | null }
interface Scopes { genres: { id: number; name: string; picture: string | null }[]; countries: { id: number; code: string; name: string; flag: string }[] }
type Tab = 'popular' | 'genre' | 'country' | 'followed' | 'recent';

const artistsPage = (p: { scope?: string; q?: string; index: number }, signal?: AbortSignal) => get<Page>('/api/catalog/artists', p, signal);
let scopesCache: Promise<Scopes> | null = null;
const loadScopes = () => (scopesCache ??= get<Scopes>('/api/catalog/artists/scopes').catch((e) => { scopesCache = null; throw e; }));

// Where the listener was, kept while the app is open (coming back from an artist page).
const last: { tab: Tab; genre: string; country: string; q: string } = { tab: 'popular', genre: '', country: '', q: '' };

export function ArtistsView() {
  const [tab, setTabState] = useState<Tab>(last.tab);
  const [genre, setGenre] = useState(last.genre);
  const [country, setCountry] = useState(last.country);
  const [text, setText] = useState(last.q);
  const [q, setQ] = useState(last.q);
  const [scopes, setScopes] = useState<Scopes | null>(null);
  const [scopesError, setScopesError] = useState<string | null>(null);
  const setTab = (t: Tab) => { last.tab = t; setTabState(t); };

  useEffect(() => { loadScopes().then(setScopes).catch((e) => setScopesError(e.message)); }, []);
  useEffect(() => {
    const t = setTimeout(() => { last.q = text.trim(); setQ(text.trim()); }, 350);
    return () => clearTimeout(t);
  }, [text]);
  // First visit of a genre / country tab: its first entry.
  useEffect(() => {
    if (!scopes) return;
    if (!genre && scopes.genres[0]) { last.genre = `genre:${scopes.genres[0].id}`; setGenre(last.genre); }
    if (!country && scopes.countries.length) {
      const fr = scopes.countries.find((c) => c.code === 'FR') || scopes.countries[0];
      last.country = `country:${fr.id}`;
      setCountry(last.country);
    }
  }, [scopes, genre, country]);

  const chip = (t: Tab, label: string) => (
    <button role="tab" aria-selected={tab === t} className={`chip ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{label}</button>
  );

  return (
    <div className="page artists-page">
      <h1 className="page-title">Artistes</h1>
      <div className="filter-input artists-search">
        <SearchIcon size={15} />
        <input type="search" placeholder="Rechercher un artiste" aria-label="Rechercher un artiste" value={text} onChange={(e) => setText(e.target.value)} />
        {text && <button className="icon-btn" onClick={() => setText('')} aria-label="Effacer la recherche"><X size={15} /></button>}
      </div>
      {q ? (
        <>
          <div className="shelf-head"><h2>Résultats pour « {q} »</h2></div>
          <Directory key={`q:${q}`} params={{ q }} />
        </>
      ) : (
        <>
          <div className="chips" role="tablist" aria-label="Parcourir les artistes">
            {chip('popular', 'Populaires')}
            {chip('genre', 'Par genre')}
            {chip('country', 'Par pays')}
            {chip('followed', 'Suivis')}
            {chip('recent', 'Écoutés récemment')}
          </div>
          {scopesError && (tab === 'genre' || tab === 'country') && <div className="empty error">{scopesError}</div>}
          {tab === 'popular' && <Directory key="all" params={{ scope: 'all' }} />}
          {tab === 'genre' && scopes && (
            <>
              <div className="chips small" aria-label="Genre">
                {scopes.genres.map((g) => {
                  const id = `genre:${g.id}`;
                  return <button key={g.id} className={`chip ${genre === id ? 'active' : ''}`} aria-pressed={genre === id} onClick={() => { last.genre = id; setGenre(id); }}>{g.name}</button>;
                })}
              </div>
              {genre && <Directory key={genre} params={{ scope: genre }} />}
            </>
          )}
          {tab === 'country' && scopes && (
            <>
              <label className="artists-country">
                <span className="muted small">Pays</span>
                <select className="select" value={country} onChange={(e) => { last.country = e.target.value; setCountry(e.target.value); }}>
                  {scopes.countries.map((c) => <option key={c.id} value={`country:${c.id}`}>{c.flag} {c.name}</option>)}
                </select>
              </label>
              <p className="muted small">Les artistes du classement Deezer de ce pays, puis des artistes proches.</p>
              {country && <Directory key={country} params={{ scope: country }} />}
            </>
          )}
          {tab === 'followed' && <Followed />}
          {tab === 'recent' && <Recent />}
        </>
      )}
    </div>
  );
}

/** Paginated grid: the next page loads when its end comes into view (or with the button). */
function Directory({ params }: { params: { scope?: string; q?: string } }) {
  const [list, setList] = useState<ArtistCardData[]>([]);
  const [next, setNext] = useState<number | null>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const busy = useRef(false);

  const more = () => {
    if (busy.current || next === null) return;
    busy.current = true;
    setLoading(true);
    setError(null);
    artistsPage({ ...params, index: next })
      .then((p) => {
        setList((l) => {
          const seen = new Set(l.map((a) => a.id));
          return [...l, ...p.artists.filter((a) => !seen.has(a.id))];
        });
        setNext(p.next);
      })
      .catch((e) => setError(e.message))
      .finally(() => { busy.current = false; setLoading(false); });
  };

  useEffect(() => {
    const el = end.current;
    if (!el || next === null || error) return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) more(); }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }); // re-armed after every page so a short page still pulls the next one

  return (
    <>
      {list.length > 0 && <div className="card-grid">{list.map((a) => <ArtistCard key={a.id} a={a} />)}</div>}
      {!loading && !error && next === null && !list.length && <div className="empty small">Aucun artiste trouvé.</div>}
      {error && <div className="empty error">{error} <button className="btn btn-ghost btn-sm" onClick={more}>Réessayer</button></div>}
      <div ref={end} className="dir-end">
        {loading && <Loader2 className="spin" size={24} />}
        {!loading && !error && next !== null && list.length > 0 && <button className="btn btn-ghost" onClick={more}>Plus d'artistes</button>}
      </div>
    </>
  );
}

function NameCard({ name, picture, sub }: { name: string; picture: string | null; sub: string }) {
  const navigate = useUi((s) => s.navigate);
  return (
    <div className="card artist-card" role="link" tabIndex={0} onClick={() => navigate({ name: 'artist', q: name })} onKeyDown={(e) => { if (e.key === 'Enter') navigate({ name: 'artist', q: name }); }}>
      <Cover src={picture} size="100%" radius={999} />
      <div className="card-title ellipsis">{name}</div>
      <div className="card-sub">{sub}</div>
    </div>
  );
}

function Followed() {
  const artists = useLibrary((s) => s.followedArtists);
  if (!artists.length) return <div className="empty small">Vous ne suivez aucun artiste pour l'instant : bouton « Suivre » sur la page d'un artiste.</div>;
  return <div className="card-grid">{artists.map((a) => <NameCard key={a.name} name={a.name} picture={a.thumbnail} sub="Suivi" />)}</div>;
}

/** Artists of the listening history, most recent first (their photo when followed, else the last cover). */
function Recent() {
  const history = useLibrary((s) => s.history);
  const followed = useLibrary((s) => s.followedArtists);
  const list = useMemo(() => {
    const pics = new Map(followed.map((a) => [artistKey(a.name), a.thumbnail]));
    const seen = new Set<string>();
    const out: { name: string; picture: string | null }[] = [];
    for (const h of history) {
      const name = (h.track.author || '').replace(/\s*-\s*Topic$/i, '').trim();
      const key = artistKey(name);
      if (!name || seen.has(key)) continue;
      seen.add(key);
      out.push({ name, picture: pics.get(key) || h.track.thumbnail || null });
      if (out.length >= 60) break;
    }
    return out;
  }, [history, followed]);
  if (!list.length) return <div className="empty small">Aucune écoute pour l'instant.</div>;
  return <div className="card-grid">{list.map((a) => <NameCard key={a.name} name={a.name} picture={a.picture} sub="Écouté récemment" />)}</div>;
}
