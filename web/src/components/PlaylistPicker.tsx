import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useUi } from '../store/ui';
import { useLibrary } from '../store/library';
import { Mosaic } from './Cover';
import { useEscape } from '../hooks';

export function PlaylistPicker() {
  const tracks = useUi((s) => s.pickerTracks);
  const openPicker = useUi((s) => s.openPicker);
  const toast = useUi((s) => s.toast);
  const playlists = useLibrary((s) => s.playlists);
  const { addToPlaylist, createPlaylist } = useLibrary.getState();
  const [name, setName] = useState('');
  const close = () => { openPicker(null); setName(''); };
  useEscape(!!tracks, close);

  if (!tracks) return null;
  const add = (id: string, plName: string) => {
    const n = addToPlaylist(id, tracks);
    toast(n ? `${n > 1 ? `${n} titres ajoutés` : 'Ajouté'} à « ${plName} »` : `Déjà dans « ${plName} »`, n ? 'success' : 'info');
    close();
  };

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal picker" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Ajouter à une playlist">
        <div className="modal-head">
          <h2>Ajouter à une playlist</h2>
          <button className="icon-btn" onClick={close} aria-label="Fermer"><X size={20} /></button>
        </div>
        <form className="row gap" onSubmit={(e) => {
          e.preventDefault();
          const pl = createPlaylist(name || 'Nouvelle playlist', tracks);
          toast(`Playlist « ${pl.name} » créée`, 'success');
          close();
        }}>
          <input className="input grow" autoFocus placeholder="Nouvelle playlist…" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn btn-primary" type="submit"><Plus size={16} /> Créer</button>
        </form>
        <div className="picker-list">
          {playlists.map((p) => (
            <button key={p.id} className="picker-item" onClick={() => add(p.id, p.name)}>
              <Mosaic covers={p.tracks.map((t) => t.thumbnail)} size={44} radius={6} />
              <span className="grow ellipsis">{p.name}</span>
              <span className="muted small">{p.tracks.length} titres</span>
            </button>
          ))}
          {!playlists.length && <p className="muted">Aucune playlist pour l'instant.</p>}
        </div>
      </div>
    </div>
  );
}
