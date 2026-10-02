import { Heart, ListPlus, X } from 'lucide-react';
import { useState } from 'react';
import { repairSpotifyCovers, useLibrary } from '../store/library';
import { useUi } from '../store/ui';
import { useEscape } from '../hooks';
import type { Track } from '../lib/types';

/** Spotify liked songs read from a file: into « Titres likés », or into a new playlist. */
export function SpotifyImportDialog({ tracks, onClose }: { tracks: Track[]; onClose: () => void }) {
  const toast = useUi((s) => s.toast);
  const navigate = useUi((s) => s.navigate);
  const [name, setName] = useState('Titres likés Spotify');
  useEscape(true, onClose);

  const done = (msg: string) => {
    toast(msg, 'success');
    repairSpotifyCovers().catch(() => {});
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal picker" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Importer les titres likés Spotify">
        <div className="modal-head">
          <h2>Importer {tracks.length} titre(s) Spotify</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Fermer"><X size={20} /></button>
        </div>
        <p className="muted small">Où voulez-vous les mettre ?</p>
        <button className="btn btn-primary full" onClick={() => {
          const n = useLibrary.getState().likeTracks(tracks);
          done(`${n} titre(s) ajouté(s) aux titres likés${n < tracks.length ? ` (${tracks.length - n} déjà likés)` : ''}`);
        }}>
          <Heart size={16} /> Dans mes titres likés
        </button>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Nom de la nouvelle playlist" />
        <button className="btn btn-ghost full" onClick={() => {
          const pl = useLibrary.getState().createPlaylist(name.trim() || 'Titres likés Spotify', tracks);
          done(`« ${pl.name} » créée : ${pl.tracks.length} titres`);
          navigate({ name: 'playlist', id: pl.id });
        }}>
          <ListPlus size={16} /> Dans une nouvelle playlist
        </button>
      </div>
    </div>
  );
}
