import { Search as SearchIcon, X, Loader2, Play, ListEnd, ListMusic, Save, Clock, Check, UserPlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, isUrl, type ResolveResult } from '../lib/api';
import type { Track } from '../lib/types';
import { SOURCE_LABELS } from '../lib/format';
import { useUi, useSettings } from '../store/ui';
import { usePlayer } from '../store/player';
import { useLibrary, useIsFollowed } from '../store/library';
import { TrackList } from '../components/TrackList';
import { Cover } from '../components/Cover';
import { SourceBadge } from '../components/SourceBadge';
import { GenreGrid } from '../components/Cards';

const TABS = ['all', 'youtube', 'ytmusic', 'soundcloud', 'dailymotion'];
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
  const q = view.q || '';

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
          {TABS.map((t) => <button key={t} className={`chip ${source === t ? 'active' : ''}`} onClick={() => setSource(t)}>{SOURCE_LABELS[t]}</button>)}
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

      {state.loading && <div className="empty"><Loader2 className="spin" size={28} /> Recherche en cours…</div>}
      {state.error && !state.loading && <div className="empty error">{state.error}</div>}

      {!state.loading && state.resolved && state.resolved.type === 'playlist' && (
        <div className="resolved-head">
          <Cover src={state.resolved.thumbnail} size={120} radius={8} />
          <div>
            <div className="muted small">PLAYLIST · {state.resolved.tracks.length} titres</div>
            <h2>{state.resolved.title || 'Playlist'}</h2>
            <BulkActions tracks={state.tracks} title={state.resolved.title || ''} sourceUrl={state.resolved.url} thumbnail={state.resolved.thumbnail} />
          </div>
        </div>
      )}

      {!state.loading && !state.resolved && top && (
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

      {!state.loading && q && !state.error && (
        <TrackList tracks={state.tracks} listKey={`search:${q}`} showViews empty={`Aucun résultat pour « ${q} »`} />
      )}
    </div>
  );
}

export function Artist() {
  const view = useUi((s) => s.view);
  const name = view.q || '';
  const [state, setState] = useState<{ loading: boolean; tracks: Track[]; error: string | null }>({ loading: true, tracks: [], error: null });
  const playList = usePlayer((s) => s.playList);
  const artistName = name.replace(/\s*-\s*Topic$/i, '');
  const followed = useIsFollowed(artistName);
  const toast = useUi((s) => s.toast);

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ loading: true, tracks: [], error: null });
    const clean = name.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '');
    api.search(clean, 'ytmusic', 30, ctrl.signal)
      .catch(() => api.search(clean, 'youtube', 30, ctrl.signal))
      .then((r) => setState({ loading: false, tracks: r.tracks, error: null }))
      .catch((err) => { if (!ctrl.signal.aborted) setState({ loading: false, tracks: [], error: err.message }); });
    return () => ctrl.abort();
  }, [name]);

  return (
    <div className="page">
      <div className="hero artist-hero" style={{ ['--hero-img' as string]: state.tracks[0]?.thumbnail ? `url("${state.tracks[0].thumbnail}")` : 'none' }}>
        <div className="muted small">ARTISTE</div>
        <h1 className="hero-title">{artistName}</h1>
        <div className="actions">
          <button className="btn btn-primary" disabled={!state.tracks.length} onClick={() => playList(state.tracks)}><Play size={16} fill="currentColor" /> Lecture</button>
          <button className="btn btn-ghost" disabled={!state.tracks.length} onClick={() => playList(state.tracks, 0, { shuffle: true })}>Aléatoire</button>
          <button className={`btn ${followed ? 'btn-ghost following' : 'btn-ghost'}`} aria-pressed={followed} onClick={() => {
            const on = useLibrary.getState().toggleFollow(artistName, state.tracks[0]?.thumbnail ?? null);
            toast(on ? 'Artiste ajouté à votre bibliothèque' : 'Vous ne suivez plus cet artiste', 'success');
          }}>{followed ? <><Check size={16} /> Abonné</> : <><UserPlus size={16} /> Suivre</>}</button>
        </div>
      </div>
      {state.loading && <div className="empty"><Loader2 className="spin" size={28} /> Chargement…</div>}
      {state.error && <div className="empty error">{state.error}</div>}
      {!state.loading && <TrackList tracks={state.tracks} listKey={`artist:${name}`} showViews />}
    </div>
  );
}
