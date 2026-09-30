import { Check, Loader2, Plus, Search as SearchIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useSettings } from '../store/ui';
import type { Track } from '../lib/types';
import { Cover } from './Cover';

/**
 * "Let's find something for your playlist" (Spotify): search from inside a playlist or the liked
 * tracks and add results one by one, without leaving the page.
 */
export function AddTracks({ have, onAdd, startOpen = false }: { have: Set<string>; onAdd: (t: Track) => void; startOpen?: boolean }) {
  const source = useSettings((s) => s.defaultSource);
  const [open, setOpen] = useState(startOpen);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [state, setState] = useState<{ loading: boolean; tracks: Track[]; error: string | null }>({ loading: false, tracks: [], error: null });

  useEffect(() => {
    if (!query) return;
    const ctrl = new AbortController();
    setState({ loading: true, tracks: [], error: null });
    api.search(query, source, 12, ctrl.signal)
      .then((r) => setState({ loading: false, tracks: r.tracks, error: null }))
      .catch((err) => { if (!ctrl.signal.aborted) setState({ loading: false, tracks: [], error: err.message }); });
    return () => ctrl.abort();
  }, [query, source]);

  if (!open) {
    return <button className="btn btn-ghost" onClick={() => setOpen(true)}><Plus size={16} /> Ajouter des titres</button>;
  }
  return (
    <section className="add-tracks">
      <div className="row gap">
        <h2 className="grow">Trouvons quelque chose à ajouter</h2>
        <button className="link muted" onClick={() => setOpen(false)}>Fermer</button>
      </div>
      <form className="filter-input" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
        <SearchIcon size={14} />
        <input autoFocus placeholder="Rechercher un titre ou un artiste" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher des titres à ajouter" />
      </form>
      {state.loading && <div className="muted small row gap"><Loader2 size={14} className="spin" /> Recherche…</div>}
      {state.error && <div className="muted small error">{state.error}</div>}
      <div className="add-list">
        {state.tracks.map((t) => {
          const added = have.has(t.url);
          return (
            <div key={t.url} className="add-row">
              <Cover src={t.thumbnail} size={40} />
              <div className="grow ellipsis">
                <div className="ellipsis">{t.title}</div>
                <div className="muted small ellipsis">{t.author}</div>
              </div>
              <button className={`btn btn-sm ${added ? 'btn-ghost' : 'btn-primary'}`} disabled={added} onClick={() => onAdd(t)}>
                {added ? <><Check size={14} /> Ajouté</> : <><Plus size={14} /> Ajouter</>}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
