import { Check, GitMerge, Heart, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useLibrary } from '../store/library';
import { useUi } from '../store/ui';
import { useShared } from '../store/social';
import { Mosaic } from './Cover';
import { useEscape } from '../hooks';

/**
 * « Fusionner des playlists »: pick playlists (and/or the liked tracks, shared playlists) → one new
 * playlist, duplicates removed, in the order picked. Optionally delete the merged (own) playlists.
 */
export function MergeDialog({ onClose, preselect = [] }: { onClose: () => void; preselect?: string[] }) {
  const playlists = useLibrary((s) => s.playlists);
  const liked = useLibrary((s) => s.liked);
  const sharedLists = useShared((s) => s.list);
  const navigate = useUi((s) => s.navigate);
  const toast = useUi((s) => s.toast);
  const [picked, setPicked] = useState<string[]>(preselect);
  const [name, setName] = useState('');
  const [remove, setRemove] = useState(false);
  useEscape(true, onClose);

  const sources = useMemo(() => [
    { id: 'liked', name: 'Titres likés', tracks: liked, own: false, liked: true },
    ...playlists.map((p) => ({ id: p.id, name: p.name, tracks: p.tracks, own: true, liked: false })),
    ...sharedLists.map((p) => ({ id: `shared:${p.id}`, name: `${p.name} (partagée)`, tracks: p.tracks, own: false, liked: false })),
  ], [playlists, liked, sharedLists]);
  const chosen = picked.map((id) => sources.find((s) => s.id === id)).filter(Boolean) as typeof sources;
  const unique = new Set(chosen.flatMap((s) => s.tracks.map((t) => t.url))).size;
  const total = chosen.reduce((n, s) => n + s.tracks.length, 0);
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal picker" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Fusionner des playlists">
        <div className="modal-head">
          <h2><GitMerge size={20} /> Fusionner des playlists</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Fermer"><X size={20} /></button>
        </div>
        <p className="muted small">Choisissez au moins deux sources : elles forment une nouvelle playlist, sans doublons, dans l'ordre choisi.</p>
        <div className="picker-list">
          {sources.map((s) => (
            <button key={s.id} className={`picker-item ${picked.includes(s.id) ? 'picked' : ''}`} onClick={() => toggle(s.id)} aria-pressed={picked.includes(s.id)}>
              {s.liked ? <span className="picker-liked liked-gradient"><Heart size={20} fill="currentColor" /></span> : <Mosaic covers={s.tracks.map((t) => t.thumbnail)} size={44} radius={6} />}
              <span className="grow ellipsis">{s.name}</span>
              <span className="muted small">{s.tracks.length} titres</span>
              {picked.includes(s.id) && <span className="merge-order">{picked.indexOf(s.id) + 1}</span>}
            </button>
          ))}
        </div>
        <input className="input" placeholder={chosen.length ? `${chosen.map((s) => s.name).join(' + ')}`.slice(0, 80) : 'Nom de la nouvelle playlist'} value={name} onChange={(e) => setName(e.target.value)} aria-label="Nom de la nouvelle playlist" />
        {chosen.some((s) => s.own) && (
          <label className="check-row"><input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} /> Supprimer ensuite les playlists fusionnées (vos titres likés et les playlists partagées ne sont jamais touchés)</label>
        )}
        <button className="btn btn-primary full" disabled={chosen.length < 2} onClick={() => {
          const title = name.trim() || chosen.map((s) => s.name).join(' + ').slice(0, 100);
          const pl = useLibrary.getState().mergeIntoNew(title, chosen.map((s) => s.tracks), remove ? chosen.filter((s) => s.own).map((s) => s.id) : []);
          toast(`« ${pl.name} » créée : ${pl.tracks.length} titres`, 'success');
          onClose();
          navigate({ name: 'playlist', id: pl.id });
        }}>
          <Check size={16} /> {chosen.length < 2 ? 'Choisissez au moins 2 sources' : `Créer la playlist (${unique} titres${total > unique ? `, ${total - unique} doublon(s) retiré(s)` : ''})`}
        </button>
      </div>
    </div>
  );
}
