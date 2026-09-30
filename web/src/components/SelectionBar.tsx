import { EyeOff, Heart, HeartOff, ListEnd, ListMusic, Play, Trash2, X, CheckCheck } from 'lucide-react';
import { useEscape } from '../hooks';
import { pickedTracks, useSelection } from '../store/selection';
import { usePlayer } from '../store/player';
import { useLibrary } from '../store/library';
import { useUi } from '../store/ui';
import { shared } from '../store/social';

/** Actions on the selected tracks (see store/selection.ts). */
export function SelectionBar() {
  const key = useSelection((s) => s.key);
  const count = useSelection((s) => s.picked.length);
  const total = useSelection((s) => s.all.length);
  const playlistId = useSelection((s) => s.playlistId);
  const { clear, selectAll } = useSelection.getState();
  const toast = useUi((s) => s.toast);
  useEscape(!!key, clear);
  if (!key) return null;

  const run = (fn: (tracks: ReturnType<typeof pickedTracks>) => void, keep = false) => () => {
    const tracks = pickedTracks();
    if (!tracks.length) return;
    fn(tracks);
    if (!keep) clear();
  };
  const lib = useLibrary.getState();
  const removable = !!playlistId || key === 'liked';

  return (
    <div className="selection-bar" role="toolbar" aria-label="Actions sur la sélection">
      <span className="selection-count">{count ? `${count} sélectionné${count > 1 ? 's' : ''}` : 'Touchez des titres pour les sélectionner'}</span>
      <button className="btn btn-ghost btn-sm" onClick={count === total ? () => useSelection.setState({ picked: [] }) : selectAll}><CheckCheck size={15} /> {count === total ? 'Tout désélectionner' : `Tout (${total})`}</button>
      {count > 0 && (
        <>
          <button className="btn btn-primary btn-sm" onClick={run((t) => usePlayer.getState().playList(t))}><Play size={15} fill="currentColor" /> Lire</button>
          <button className="btn btn-ghost btn-sm" onClick={run((t) => usePlayer.getState().enqueue(t))}><ListEnd size={15} /> File</button>
          <button className="btn btn-ghost btn-sm" onClick={run((t) => useUi.getState().openPicker(t))}><ListMusic size={15} /> Ajouter à une playlist…</button>
          {key !== 'liked' && <button className="btn btn-ghost btn-sm" onClick={run((t) => { const n = lib.likeTracks(t); toast(n ? `${n} titre(s) ajouté(s) aux titres likés` : 'Déjà likés', 'success'); })}><Heart size={15} /> J'aime</button>}
          {removable && (
            <button className="btn btn-ghost btn-sm danger" onClick={run((t) => {
              if (key === 'liked') { for (const x of t) lib.toggleLike(x); toast(`${t.length} titre(s) retiré(s) des titres likés`); return; }
              if (playlistId!.startsWith('shared:')) {
                Promise.all(t.map((x) => shared.remove(playlistId!.slice(7), x.url))).then(() => toast(`${t.length} titre(s) retiré(s)`)).catch((e) => toast(e.message, 'error'));
                return;
              }
              const urls = new Set(t.map((x) => x.url));
              const pl = lib.playlists.find((p) => p.id === playlistId);
              if (pl) { useLibrary.setState({ playlists: lib.playlists.map((p) => (p.id === pl.id ? { ...p, tracks: p.tracks.filter((x) => !urls.has(x.url)), updatedAt: Date.now() } : p)) }); toast(`${t.length} titre(s) retiré(s) de « ${pl.name} »`); }
            })}>{key === 'liked' ? <><HeartOff size={15} /> Retirer des likes</> : <><Trash2 size={15} /> Retirer</>}</button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={run((t) => { for (const x of t) lib.setHidden('track', x.url, `${x.title}${x.author ? ` · ${x.author}` : ''}`, true); toast(`${t.length} titre(s) masqué(s) de la radio et des recommandations`); })}><EyeOff size={15} /> Masquer</button>
        </>
      )}
      <button className="icon-btn" onClick={clear} aria-label="Terminer la sélection" title="Terminer (Échap)"><X size={18} /></button>
    </div>
  );
}
