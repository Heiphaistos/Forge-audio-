import { Clock, ExternalLink, Flame, Globe2, Heart, Info, Languages, Loader2, Pause, Play, RadioTower, RotateCw, Search as SearchIcon, Tags, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import type { RadioStation } from '../lib/types';
import { countryName, flag, languageName, playStation, radioApi, stationIdOf, toggleFavorite, type Country, type Genre, type Language } from '../lib/radio';
import { usePlayer } from '../store/player';
import { useLibrary, useIsRadioFavorite } from '../store/library';
import { useUi } from '../store/ui';
import { PlayingBars } from '../components/TrackList';
import './radio.css';

/**
 * « Radios » page (loaded on demand): French selection first, then the whole Radio Browser
 * directory by country, genre and language, search, favourites (synced library) and recently played.
 * view.id: undefined (home) | countries | genres | languages | favorites | recent | popular
 *          | country:<CC> | genre:<id> | language:<name>
 */

// ---------- small helpers ----------
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('fr-FR')} ${n > 1 ? many : one}`;
const GENRE_COLORS = ['#e8115b', '#148a08', '#e91429', '#777777', '#1e3264', '#8d67ab', '#af2896', '#0d73ec', '#bc5900', '#7d4b32', '#477d95', '#dc148c', '#5f4b8b', '#a56752', '#b02897', '#608108', '#e1118c', '#27856a', '#8c1932', '#2d46b9', '#006450', '#ba5d07', '#503750', '#ff4632', '#148a08', '#1e3264'];

function hashColor(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 38%)`;
}
function initials(name: string) {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const w = words[0] || '?';
  return (w.length <= 4 ? w : w.slice(0, 2)).toUpperCase();
}
const subOf = (s: RadioStation) => [countryName(s.countryCode, s.country), s.tags.slice(0, 2).join(', ')].filter(Boolean).join(' · ');

const useSheet = create<{ station: RadioStation | null }>(() => ({ station: null }));
const openSheet = (station: RadioStation | null) => useSheet.setState({ station });

function usePlayingStation() {
  const id = usePlayer((s) => stationIdOf(s.queue[s.index]));
  const playing = usePlayer((s) => s.playing);
  const buffering = usePlayer((s) => s.buffering);
  return { id, playing, buffering };
}

function playOrToggle(s: RadioStation) {
  const st = usePlayer.getState();
  if (stationIdOf(st.queue[st.index]) === s.id && st.queue.length) st.togglePlay();
  else playStation(s);
}

// ---------- station visuals ----------
export function StationArt({ s, className = '' }: { s: RadioStation; className?: string }) {
  const [broken, setBroken] = useState(false);
  const color = s.color || hashColor(s.name);
  if (s.logo && !broken) {
    return (
      <div className={`st-art st-logo ${className}`}>
        <img src={s.logo} alt="" loading="lazy" onError={() => setBroken(true)} />
      </div>
    );
  }
  return (
    <div className={`st-art st-initials ${className}`} style={{ ['--st' as string]: color }}>
      <span>{initials(s.name)}</span>
      <RadioTower className="st-wave" size={18} aria-hidden />
    </div>
  );
}

function FavButton({ s, className = '' }: { s: RadioStation; className?: string }) {
  const fav = useIsRadioFavorite(s.id);
  const toast = useUi((x) => x.toast);
  return (
    <button
      className={`st-fav ${fav ? 'on' : ''} ${className}`}
      aria-pressed={fav}
      aria-label={fav ? `Retirer ${s.name} des favoris` : `Ajouter ${s.name} aux favoris`}
      onClick={(e) => { e.stopPropagation(); toast(toggleFavorite(s) ? `« ${s.name} » ajoutée aux favoris` : `« ${s.name} » retirée des favoris`, 'success'); }}
    >
      <Heart size={16} fill={fav ? 'currentColor' : 'none'} />
    </button>
  );
}

export function StationCard({ s }: { s: RadioStation }) {
  const now = usePlayingStation();
  const current = now.id === s.id;
  const label = current && now.playing ? `Mettre ${s.name} en pause` : `Écouter ${s.name}`;
  return (
    <div className={`st-card ${current ? 'current' : ''}`} onClick={() => playOrToggle(s)} role="button" tabIndex={0} aria-label={label}
      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); playOrToggle(s); } }}>
      <div className="st-cover">
        <StationArt s={s} />
        {current && now.playing && !now.buffering && <span className="st-live"><PlayingBars /></span>}
        <span className="st-play" aria-hidden>{current && now.playing && now.buffering ? <Loader2 size={20} className="spin" /> : current && now.playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}</span>
        <FavButton s={s} />
      </div>
      <div className="st-meta">
        <div className="st-name ellipsis" title={s.name}>{s.name}</div>
        <div className="st-sub ellipsis">{subOf(s) || 'Radio'}</div>
      </div>
      <button className="st-info" aria-label={`Fiche de ${s.name}`} onClick={(e) => { e.stopPropagation(); openSheet(s); }}><Info size={16} /></button>
    </div>
  );
}

function StationSheet() {
  const s = useSheet((x) => x.station);
  const now = usePlayingStation();
  useEffect(() => {
    if (!s) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') openSheet(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s]);
  if (!s) return null;
  const playing = now.id === s.id && now.playing;
  const rows: [string, ReactNode][] = [
    ['Pays', s.countryCode ? `${flag(s.countryCode)} ${countryName(s.countryCode, s.country)}` : s.country],
    ['Groupe', s.group],
    ['Langue', s.language ? s.language.split(',').map((l) => l.trim()).filter(Boolean).join(', ') : null],
    ['Genres', s.tags.length ? s.tags.join(', ') : null],
    ['Qualité', [s.codec, s.bitrate ? `${s.bitrate} kbit/s` : null].filter(Boolean).join(' · ') || null],
  ];
  // Portal: `.page` is animated with a transform, which would pin a fixed overlay to the page instead of the screen.
  return createPortal(
    <div className="modal-backdrop" onClick={() => openSheet(null)}>
      <div className="modal st-sheet" role="dialog" aria-modal="true" aria-label={`Fiche de ${s.name}`} onClick={(e) => e.stopPropagation()}>
        <div className="st-sheet-head">
          <StationArt s={s} className="big" />
          <div className="grow">
            <div className="muted small">RADIO EN DIRECT</div>
            <h2>{s.name}</h2>
          </div>
          <button className="icon-btn" onClick={() => openSheet(null)} aria-label="Fermer"><X size={18} /></button>
        </div>
        <dl className="st-facts">
          {rows.filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
        <div className="st-actions">
          <button className="btn btn-primary" onClick={() => playOrToggle(s)}>{playing ? <><Pause size={16} fill="currentColor" /> Pause</> : <><Play size={16} fill="currentColor" /> Écouter</>}</button>
          <FavButton s={s} className="btn" />
          {s.homepage && <a className="btn" href={s.homepage} target="_blank" rel="noopener noreferrer nofollow"><ExternalLink size={15} /> Site de la radio</a>}
        </div>
        <p className="muted small">{s.featured || s.id.startsWith('fr-') ? 'Flux officiel de la radio, relayé par Forge Audio.' : 'Station de l’annuaire libre Radio Browser, flux relayé par Forge Audio.'}</p>
      </div>
    </div>,
    document.body,
  );
}

// ---------- lists ----------
function Shelf({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="shelf">
      <div className="shelf-head"><h2>{title}</h2>{action}</div>
      <div className="shelf-row st-row">{children}</div>
    </section>
  );
}

function Skeleton({ n = 12 }: { n?: number }) {
  return <div className="st-grid" aria-busy="true" aria-label="Chargement">{Array.from({ length: n }, (_, i) => <div key={i} className="st-skel" />)}</div>;
}

function Failure({ message, retry }: { message: string; retry: () => void }) {
  return <div className="empty error">{message}<button className="btn" onClick={retry}><RotateCw size={15} /> Réessayer</button></div>;
}

/** Directory stations for a query, 48 at a time. */
function Directory({ params, empty = 'Aucune radio trouvée.' }: { params: { country?: string; genre?: string; language?: string; q?: string }; empty?: string }) {
  const key = JSON.stringify(params);
  const [state, setState] = useState<{ list: RadioStation[]; more: boolean; loading: boolean; error: string | null }>({ list: [], more: false, loading: true, error: null });
  const [attempt, setAttempt] = useState(0);
  const load = (offset: number, signal?: AbortSignal) => {
    setState((p) => ({ ...p, loading: true, error: null }));
    radioApi.stations({ ...params, offset, limit: 48 }, signal)
      .then((r) => setState((p) => ({ list: offset ? [...p.list, ...r.stations.filter((s) => !p.list.some((x) => x.id === s.id))] : r.stations, more: r.more, loading: false, error: null })))
      .catch((err) => { if (!signal?.aborted) setState((p) => ({ ...p, loading: false, error: (err as Error).message })); });
  };
  useEffect(() => {
    const ctrl = new AbortController();
    setState({ list: [], more: false, loading: true, error: null });
    load(0, ctrl.signal);
    return () => ctrl.abort();
  }, [key, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.error && !state.list.length) return <Failure message={`Annuaire indisponible : ${state.error}`} retry={() => setAttempt((n) => n + 1)} />;
  if (state.loading && !state.list.length) return <Skeleton />;
  if (!state.list.length) return <div className="empty">{empty}</div>;
  return (
    <>
      <div className="st-grid">{state.list.map((s) => <StationCard key={s.id} s={s} />)}</div>
      {state.error && <p className="bad small">{state.error}</p>}
      {state.more && (
        <div className="center st-more">
          <button className="btn" disabled={state.loading} onClick={() => load(state.list.length)}>{state.loading ? <Loader2 size={16} className="spin" /> : 'Afficher plus de radios'}</button>
        </div>
      )}
    </>
  );
}

/** Lists fetched once per visit (the server caches them 24 h). */
function useList<T>(fetcher: () => Promise<T>): { data: T | null; error: string | null; retry: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    fetcher().then((d) => { if (live) setData(d); }).catch((err) => { if (live) setError((err as Error).message); });
    return () => { live = false; };
  }, [attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, retry: () => setAttempt((n) => n + 1) };
}

const useCountries = () => useList(async () => (await radioApi.countries()).countries);
const useGenres = () => useList(async () => (await radioApi.genres()).genres);
const useLanguages = () => useList(async () => (await radioApi.languages()).languages);
const useFeatured = () => useList(async () => (await radioApi.featured()).stations);

function CountryTiles({ list }: { list: Country[] }) {
  const navigate = useUi((s) => s.navigate);
  return (
    <div className="st-tiles">
      {list.map((c) => (
        <button key={c.code} className="st-tile" onClick={() => navigate({ name: 'radio', id: `country:${c.code}` })}>
          <span className="st-flag" aria-hidden>{flag(c.code)}</span>
          <span className="grow st-tile-text"><span className="ellipsis st-tile-name">{countryName(c.code, c.name)}</span><span className="muted small">{plural(c.count, 'station', 'stations')}</span></span>
        </button>
      ))}
    </div>
  );
}

function GenreTiles({ list }: { list: Genre[] }) {
  const navigate = useUi((s) => s.navigate);
  return (
    <div className="genre-grid st-genres">
      {list.map((g, i) => (
        <button key={g.id} className="genre-card" style={{ background: GENRE_COLORS[i % GENRE_COLORS.length] }} onClick={() => navigate({ name: 'radio', id: `genre:${g.id}` })}>
          <span>{g.label}</span>
          {g.count > 0 && <small className="st-genre-count">{plural(g.count, 'station', 'stations')}</small>}
        </button>
      ))}
    </div>
  );
}

function LanguageTiles({ list }: { list: Language[] }) {
  const navigate = useUi((s) => s.navigate);
  return (
    <div className="st-tiles">
      {list.map((l) => (
        <button key={l.name} className="st-tile" onClick={() => navigate({ name: 'radio', id: `language:${l.name}` })}>
          <span className="st-flag st-lang" aria-hidden><Languages size={20} /></span>
          <span className="grow st-tile-text"><span className="ellipsis st-tile-name">{languageName(l)}</span><span className="muted small">{plural(l.count, 'station', 'stations')}</span></span>
        </button>
      ))}
    </div>
  );
}

function Tabs() {
  const view = useUi((s) => s.view);
  const navigate = useUi((s) => s.navigate);
  const favs = useLibrary((s) => s.radioFavorites.length);
  const tabs: [string | undefined, ReactNode, string][] = [
    [undefined, <RadioTower size={15} />, 'À la une'],
    ['favorites', <Heart size={15} />, favs ? `Favoris · ${favs}` : 'Favoris'],
    ['recent', <Clock size={15} />, 'Récentes'],
    ['countries', <Globe2 size={15} />, 'Pays'],
    ['genres', <Tags size={15} />, 'Genres'],
    ['languages', <Languages size={15} />, 'Langues'],
    ['popular', <Flame size={15} />, 'Les plus écoutées'],
  ];
  const at = view.id?.split(':')[0];
  const isActive = (id: string | undefined) => at === id || (at === 'country' && id === 'countries') || (at === 'genre' && id === 'genres') || (at === 'language' && id === 'languages');
  return (
    <nav className="st-tabs" aria-label="Catégories de radios">
      {tabs.map(([id, icon, label]) => (
        <button key={label} className={`chip ${isActive(id) ? 'active' : ''}`} aria-current={isActive(id) ? 'page' : undefined} onClick={() => navigate({ name: 'radio', id })}>
          {icon}{label}
        </button>
      ))}
    </nav>
  );
}

function Header({ eyebrow, title, sub, children }: { eyebrow?: string; title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="st-hero">
      {eyebrow && <div className="muted small st-eyebrow">{eyebrow}</div>}
      <h1 className="st-title">{title}</h1>
      {sub && <p className="muted st-lead">{sub}</p>}
      {children}
    </header>
  );
}

// ---------- pages ----------
const FEATURED_GROUPS: [string, (g: string) => boolean][] = [
  ['Radio France', (g) => g === 'Radio France'],
  ['Les grandes radios privées', (g) => ['Groupe M6', 'Lagardère', 'NRJ Group', 'RMC BFM', 'France Médias Monde'].includes(g)],
  ['Les webradios de FIP', (g) => g === 'Radio France · FIP'],
  ['France Musique en continu', (g) => g === 'Radio France · France Musique'],
  ['Radios indépendantes', (g) => g === 'Indépendantes'],
  ['ICI, la radio de proximité', (g) => g === 'Radio France · ICI'],
];

function Home() {
  const navigate = useUi((s) => s.navigate);
  const featured = useFeatured();
  const countries = useCountries();
  const genres = useGenres();
  const favorites = useLibrary((s) => s.radioFavorites);
  const recent = useLibrary((s) => s.radioRecent);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);
  const groups = useMemo(() => FEATURED_GROUPS.map(([title, test]) => [title, (featured.data || []).filter((s) => test(s.group || ''))] as const).filter(([, l]) => l.length), [featured.data]);
  const more = (id: string, label = 'Tout afficher') => <button className="link muted small st-more-link" onClick={() => navigate({ name: 'radio', id })}>{label}</button>;

  return (
    <>
      <Header eyebrow="EN DIRECT" title="Radios" sub="Les radios françaises et des dizaines de milliers de stations du monde entier, par pays, par genre et par langue.">
        <form className="st-search" role="search" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
          <SearchIcon size={18} className="muted" aria-hidden />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher une radio : FIP, BBC, jazz…" aria-label="Rechercher une radio" maxLength={80} />
          {q && <button type="button" className="icon-btn" aria-label="Effacer" onClick={() => { setQ(''); setQuery(''); }}><X size={16} /></button>}
        </form>
      </Header>
      <Tabs />
      {query ? (
        <section>
          <h2 className="section-title">Résultats pour « {query} »</h2>
          <Directory params={{ q: query }} empty={`Aucune radio ne correspond à « ${query} ».`} />
        </section>
      ) : (
        <>
          {favorites.length > 0 && <Shelf title="Vos radios favorites" action={more('favorites')}>{favorites.slice(0, 20).map((s) => <StationCard key={s.id} s={s} />)}</Shelf>}
          {recent.length > 0 && <Shelf title="Écoutées récemment" action={more('recent')}>{recent.slice(0, 20).map((s) => <StationCard key={s.id} s={s} />)}</Shelf>}
          {featured.error && <Failure message={featured.error} retry={featured.retry} />}
          {!featured.data && !featured.error && <Skeleton n={6} />}
          {groups.map(([title, list], i) => (
            <Shelf key={title} title={title} action={i === 0 ? more('country:FR', 'Toutes les radios françaises') : undefined}>
              {list.map((s) => <StationCard key={s.id} s={s} />)}
            </Shelf>
          ))}
          <section className="shelf">
            <div className="shelf-head"><h2>Par genre</h2>{more('genres')}</div>
            {genres.data ? <GenreTiles list={genres.data.slice(0, 12)} /> : genres.error ? <Failure message={genres.error} retry={genres.retry} /> : <Skeleton n={6} />}
          </section>
          <section className="shelf">
            <div className="shelf-head"><h2>Par pays</h2>{more('countries')}</div>
            {countries.data ? <CountryTiles list={countries.data.slice(0, 12)} /> : countries.error ? <Failure message={countries.error} retry={countries.retry} /> : <Skeleton n={6} />}
          </section>
        </>
      )}
    </>
  );
}

function CountriesPage() {
  const { data, error, retry } = useCountries();
  const [filter, setFilter] = useState('');
  const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const list = (data || []).filter((c) => !filter || norm(countryName(c.code, c.name)).includes(norm(filter)) || c.code === filter.toUpperCase());
  return (
    <>
      <Header title="Radios par pays" sub={data ? `${data.length} pays et territoires` : undefined}>
        <div className="st-search">
          <SearchIcon size={18} className="muted" aria-hidden />
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrer les pays" aria-label="Filtrer les pays" />
        </div>
      </Header>
      <Tabs />
      {error ? <Failure message={error} retry={retry} /> : !data ? <Skeleton /> : list.length ? <CountryTiles list={list} /> : <div className="empty">Aucun pays ne correspond.</div>}
    </>
  );
}

function CountryPage({ code }: { code: string }) {
  const countries = useCountries();
  const genres = useGenres();
  const [genre, setGenre] = useState<string | undefined>();
  const c = countries.data?.find((x) => x.code === code);
  return (
    <>
      <Header eyebrow="PAYS" title={<>{flag(code)} {countryName(code, c?.name)}</>} sub={c ? `${plural(c.count, 'station', 'stations')}, des plus écoutées aux plus confidentielles` : undefined} />
      <Tabs />
      <div className="st-filter" role="group" aria-label="Filtrer par genre">
        <button className={`chip ${!genre ? 'active' : ''}`} onClick={() => setGenre(undefined)}>Tous les genres</button>
        {(genres.data || []).map((g) => <button key={g.id} className={`chip ${genre === g.id ? 'active' : ''}`} onClick={() => setGenre(g.id)}>{g.label}</button>)}
      </div>
      <Directory params={{ country: code, genre }} />
    </>
  );
}

function GenrePage({ id }: { id: string }) {
  const genres = useGenres();
  const g = genres.data?.find((x) => x.id === id);
  const [country, setCountry] = useState<string | undefined>();
  return (
    <>
      <Header eyebrow="GENRE" title={g?.label || 'Genre'} sub={g?.count ? `Environ ${plural(g.count, 'station', 'stations')} dans le monde` : undefined} />
      <Tabs />
      <div className="st-filter" role="group" aria-label="Filtrer par pays">
        <button className={`chip ${!country ? 'active' : ''}`} onClick={() => setCountry(undefined)}>Monde entier</button>
        <button className={`chip ${country === 'FR' ? 'active' : ''}`} onClick={() => setCountry('FR')}>🇫🇷 France</button>
      </div>
      <Directory params={{ genre: id, country }} />
    </>
  );
}

function SimplePage({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return <><Header title={title} sub={sub} /><Tabs />{children}</>;
}

function LanguagePage({ name }: { name: string }) {
  const languages = useLanguages();
  const l = languages.data?.find((x) => x.name === name);
  return <SimplePage title={l ? languageName(l) : name} sub={l ? plural(l.count, 'station', 'stations') : undefined}><Directory params={{ language: name }} /></SimplePage>;
}

function ListPage({ title, sub, which }: { title: string; sub?: string; which: 'genres' | 'languages' }) {
  const genres = useGenres();
  const languages = useLanguages();
  const src = which === 'genres' ? genres : languages;
  return (
    <SimplePage title={title} sub={sub}>
      {src.error ? <Failure message={src.error} retry={src.retry} />
        : !src.data ? <Skeleton />
          : which === 'genres' ? <GenreTiles list={genres.data!} /> : <LanguageTiles list={languages.data!} />}
    </SimplePage>
  );
}

export function RadioView() {
  const id = useUi((s) => s.view.id);
  const favorites = useLibrary((s) => s.radioFavorites);
  const recent = useLibrary((s) => s.radioRecent);
  const [kind, arg] = id ? [id.split(':')[0], id.slice(id.indexOf(':') + 1)] : [undefined, ''];

  let page: ReactNode;
  if (kind === 'countries') page = <CountriesPage />;
  else if (kind === 'country' && /^[A-Z]{2}$/.test(arg)) page = <CountryPage key={arg} code={arg} />;
  else if (kind === 'genre') page = <GenrePage key={arg} id={arg} />;
  else if (kind === 'genres') page = <ListPage title="Radios par genre" sub="Les étiquettes proches de l’annuaire regroupées" which="genres" />;
  else if (kind === 'languages') page = <ListPage title="Radios par langue" which="languages" />;
  else if (kind === 'language') page = <LanguagePage key={arg} name={arg} />;
  else if (kind === 'favorites') {
    page = (
      <SimplePage title="Radios favorites" sub="Enregistrées dans votre bibliothèque, sur tous vos appareils.">
        {favorites.length ? <div className="st-grid">{favorites.map((s) => <StationCard key={s.id} s={s} />)}</div>
          : <div className="empty"><Heart size={28} />Touchez le cœur d’une radio pour la retrouver ici.</div>}
      </SimplePage>
    );
  } else if (kind === 'recent') {
    page = (
      <SimplePage title="Écoutées récemment">
        {recent.length ? <div className="st-grid">{recent.map((s) => <StationCard key={s.id} s={s} />)}</div>
          : <div className="empty"><Clock size={28} />Les radios que vous écoutez apparaîtront ici.</div>}
      </SimplePage>
    );
  } else if (kind === 'popular') {
    page = <SimplePage title="Les plus écoutées dans le monde" sub="Classement de l’annuaire Radio Browser, mis à jour en continu."><Directory params={{}} /></SimplePage>;
  } else page = <Home />;

  return (
    <div className="page radio-page">
      {page}
      <p className="muted small st-credit">Annuaire : <a className="link" href="https://www.radio-browser.info/" target="_blank" rel="noopener noreferrer">Radio Browser</a> (libre et gratuit), consulté par le serveur Forge Audio.</p>
      <StationSheet />
    </div>
  );
}

export default RadioView;
