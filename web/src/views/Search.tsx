import { Search as SearchIcon, X, Loader2, Play, ListEnd, ListMusic, Save, Clock } from 'lucide-react';
import { ArtistCard, AlbumCard, CatalogPlaylistCard } from './Catalog';
import type { CatalogSearch } from '../lib/api';
import { useEffect, useRef, useState } from 'react';
import { api, isUrl, type ResolveResult } from '../lib/api';
import type { Track } from '../lib/types';
import { SOURCE_LABELS } from '../lib/format';
import { useUi, useSettings } from '../store/ui';
import { usePlayer } from '../store/player';
import { useLibrary } from '../store/library';
import { TrackList } from '../components/TrackList';
import { Cover } from '../components/Cover';
import { SourceBadge } from '../components/SourceBadge';
import { GenreGrid } from '../components/Cards';

const TABS = ['all', 'youtube', 'ytmusic', 'soundcloud', 'dailymotion'];
/** Catalogue tabs (Deezer): artists, albums and playlists instead of tracks. */
const KINDS = { artists: 'Artistes', albums: 'Albums', playlists: 'Playlists' } as const;
type Kind = keyof typeof KINDS;
const RECENT_KEY = 'forge.recentSearches';

function loadRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}
function saveRecent(q: string) {
  const list = [q, ...loadRecent().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 12);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* quota */ }
}

export function SearchInput({ value, onSubmit, autoFocus }: { value: string; onSubmit: (q: string) => void; autoFocus?: boolean }) {
  const [text, setText] = useState(value);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(-1);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => setText(value), [value]);

  useEffect(() => {
    const q = text.trim();
    if (!q || isUrl(q) || q === value) { setSuggestions([]); return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => api.suggest(q, ctrl.signal).then((r) => { setSuggestions(r.suggestions); setSel(-1); }).catch(() => {}), 180);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [text, value]);

  const submit = (q: string) => {
    setOpen(false);
    setText(q);
    ref.current?.blur();
    if (q.trim()) onSubmit(q.trim());
  };

  return (
    <div className="search-input-wrap">
      <form className="search-input" onSubmit={(e) => { e.preventDefault(); submit(sel >= 0 ? suggestions[sel] : text); }}>
        <SearchIcon size={20} />
        <input
          ref={ref} id="global-search" autoFocus={autoFocus} value={text} placeholder="Titre, artiste, album ou lien…" autoComplete="off" spellCheck={false}
          onChange={(e) => { setText(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(suggestions.length - 1, s + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(-1, s - 1)); }
            if (e.key === 'Escape') { setOpen(false); ref.current?.blur(); }
          }}
        />
        {text && <button type="button" className="icon-btn" onClick={() => { setText(''); ref.current?.focus(); }} aria-label="Effacer"><X size={18} /></button>}
      </form>
      {open && suggestions.length > 0 && (
        <div className="suggestions">
          {suggestions.map((s, i) => (
            <button key={s} className={i === sel ? 'sel' : ''} onMouseDown={(e) => { e.preventDefault(); submit(s); }}><SearchIcon size={14} /> {s}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function BulkActions({ tracks, title, sourceUrl, thumbnail }: { tracks: Track[]; title?: string; sourceUrl?: string | null; thumbnail?: string | null }) {
  const { playList, enqueue } = usePlayer.getState();
  const openPicker = useUi((s) => s.openPicker);
  const navigate = useUi((s) => s.navigate);
  const toast = useUi((s) => s.toast);
  return (
    <div className="actions">
      <button className="btn btn-primary" onClick={() => playList(tracks)}><Play size={16} fill="currentColor" /> Tout lire</button>
      <button className="btn btn-ghost" onClick={() => enqueue(tracks)}><ListEnd size={16} /> Ajouter à la file</button>
      <button className="btn btn-ghost" onClick={() => openPicker(tracks)}><ListMusic size={16} /> Ajouter à une playlist</button>
      {title !== undefined && (
        <button className="btn btn-ghost" onClick={() => {
          const pl = useLibrary.getState().createPlaylist(title || 'Playlist importée', tracks, { sourceUrl, cover: thumbnail ?? null });
          toast(`Playlist « ${pl.name} » enregistrée`, 'success');
          navigate({ name: 'playlist', id: pl.id });
        }}><Save size={16} /> Enregistrer la playlist</button>
      )}
    </div>
  );
}

export function Search() {
  const view = useUi((s) => s.view);
  const navigate = useUi((s) => s.navigate);
  const defaultSource = useSettings((s) => s.defaultSource);
  const [source, setSource] = useState(defaultSource);
  const [state, setState] = useState<{ loading: boolean; error: string | null; tracks: Track[]; resolved: ResolveResult | null; errors: Record<string, string> }>({ loading: false, error: null, tracks: [], resolved: null, errors: {} });
  const playList = usePlayer((s) => s.playList);
  const [recent, setRecent] = useState(loadRecent);
  const [kind, setKind] = useState<Kind | null>(null);
  const [cat, setCat] = useState<{ loading: boolean; data: CatalogSearch | null; error: string | null }>({ loading: false, data: null, error: null });
  const q = view.q || '';
  // A pasted / opened link always shows its content, whatever catalogue tab was active.
  const catMode = !!kind && !!q && !isUrl(q);

  useEffect(() => {
    if (!kind || !q || isUrl(q)) return;
    const ctrl = new AbortController();
    setCat({ loading: true, data: null, error: null });
    api.catalogSearch(q, ctrl.signal)
      .then((data) => setCat({ loading: false, data, error: null }))
      .catch((err) => { if (!ctrl.signal.aborted) setCat({ loading: false, data: null, error: err.message }); });
    return () => ctrl.abort();
  }, [kind, q]);

  useEffect(() => {
    if (!q) { setState({ loading: false, error: null, tracks: [], resolved: null, errors: {} }); return; }
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    if (isUrl(q)) {
      api.resolve(q)
        .then((resolved) => setState({ loading: false, error: null, tracks: resolved.tracks, resolved, errors: {} }))
        .catch((err) => setState({ loading: false, error: err.message, tracks: [], resolved: null, errors: {} }));
    } else {
      saveRecent(q);
      setRecent(loadRecent());
      api.search(q, source, 20, ctrl.signal)
        .then((r) => setState({ loading: false, error: null, tracks: r.tracks, resolved: null, errors: r.errors }))
        .catch((err) => { if (!ctrl.signal.aborted) setState({ loading: false, error: err.message, tracks: [], resolved: null, errors: {} }); });
    }
    return () => ctrl.abort();
  }, [q, source]);

  const top = state.tracks[0];
  const failed = Object.keys(state.errors);

  return (
    <div className="page">
      <SearchInput value={q} autoFocus={!q} onSubmit={(nq) => navigate({ name: 'search', q: nq })} />
      {!isUrl(q) && (
        <div className="chips tabs">
          {TABS.map((t) => <button key={t} className={`chip ${!kind && source === t ? 'active' : ''}`} onClick={() => { setKind(null); setSource(t); }}>{SOURCE_LABELS[t]}</button>)}
          {(Object.keys(KINDS) as Kind[]).map((k) => <button key={k} className={`chip ${kind === k ? 'active' : ''}`} onClick={() => setKind(k)}>{KINDS[k]}</button>)}
        </div>
      )}

      {!q && (
        <>
          {recent.length > 0 && (
            <section className="shelf">
              <div className="shelf-head">
                <h2>Recherches récentes</h2>
                <button className="link muted" onClick={() => { localStorage.removeItem(RECENT_KEY); setRecent([]); }}>Effacer</button>
              </div>
              <div className="chips">
                {recent.map((r) => <button key={r} className="chip" onClick={() => navigate({ name: 'search', q: r })}><Clock size={13} /> {r}</button>)}
              </div>
            </section>
          )}
          <section className="shelf">
            <div className="shelf-head"><h2>Parcourir tout</h2></div>
            <GenreGrid />
          </section>
        </>
      )}

      {catMode && kind && (
        <>
          {cat.loading && <div className="empty"><Loader2 className="spin" size={28} /> Recherche en cours…</div>}
          {cat.error && <div className="empty error">{cat.error}</div>}
          {cat.data && (
            <div className="card-grid">
              {kind === 'artists' && cat.data.artists.map((a) => <ArtistCard key={a.id} a={a} />)}
              {kind === 'albums' && cat.data.albums.map((a) => <AlbumCard key={a.id} a={a} showArtist />)}
              {kind === 'playlists' && cat.data.playlists.map((p) => <CatalogPlaylistCard key={p.id} p={p} />)}
            </div>
          )}
          {cat.data && !cat.data[kind].length && <div className="empty">Aucun résultat pour « {q} »</div>}
        </>
      )}
      {!catMode && state.loading && <div className="empty"><Loader2 className="spin" size={28} /> Recherche en cours…</div>}
      {state.error && !state.loading && <div className="empty error">{state.error}</div>}

      {!catMode && !state.loading && state.resolved && state.resolved.type === 'playlist' && (
        <div className="resolved-head">
          <Cover src={state.resolved.thumbnail} size={120} radius={8} />
          <div>
            <div className="muted small">PLAYLIST · {state.resolved.tracks.length} titres</div>
            <h2>{state.resolved.title || 'Playlist'}</h2>
            <BulkActions tracks={state.tracks} title={state.resolved.title || ''} sourceUrl={state.resolved.url} thumbnail={state.resolved.thumbnail} />
          </div>
        </div>
      )}

      {!catMode && !state.loading && !state.resolved && top && (
        <div className="search-top">
          <div className="top-result" onClick={() => playList(state.tracks, 0)}>
            <h2 className="muted-title">Meilleur résultat</h2>
            <Cover src={top.thumbnail} size={110} radius={8} large />
            <div className="top-title ellipsis-2">{top.title}</div>
            <div className="row gap"><span className="muted">{top.author}</span><SourceBadge source={top.source} /></div>
            <button className="card-play visible" aria-label="Lire" onClick={(e) => { e.stopPropagation(); playList(state.tracks, 0); }}><Play size={22} fill="currentColor" /></button>
          </div>
          <div className="grow">
            <BulkActions tracks={state.tracks} />
            {failed.length > 0 && <p className="muted small">Sources indisponibles : {failed.map((f) => SOURCE_LABELS[f] || f).join(', ')}</p>}
          </div>
        </div>
      )}

      {!catMode && !state.loading && q && !state.error && (
        <TrackList tracks={state.tracks} listKey={`search:${q}`} showViews empty={`Aucun résultat pour « ${q} »`} />
      )}
    </div>
  );
}
