import { Check, Heart, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useUi } from '../store/ui';
import { useLibrary } from '../store/library';
import { Mosaic } from './Cover';
import { shared, useShared } from '../store/social';
import { useEscape } from '../hooks';

export function PlaylistPicker() {
  const tracks = useUi((s) => s.pickerTracks);
  const openPicker = useUi((s) => s.openPicker);
  const toast = useUi((s) => s.toast);
  const playlists = useLibrary((s) => s.playlists);
  const liked = useLibrary((s) => s.liked);
  const sharedLists = useShared((s) => s.list);
  const { addToPlaylist, createPlaylist, likeTracks } = useLibrary.getState();
  const [name, setName] = useState('');
  const close = () => { openPicker(null); setName(''); };
  useEscape(!!tracks, close);

  if (!tracks) return null;
  const done = (n: number, plName: string) => {
    toast(n ? `${n > 1 ? `${n} titres ajoutés` : 'Ajouté'} à « ${plName} »` : `Déjà dans « ${plName} »`, n ? 'success' : 'info');
    close();
  };
  // Already there: every picked track is in the list (shown as a check, like Spotify).
  const contains = (list: { url: string }[]) => {
    const urls = new Set(list.map((t) => t.url));
    return tracks.every((t) => urls.has(t.url));
  };

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal picker" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Ajouter à une playlist">
        <div className="modal-head">
          <h2>{tracks.length > 1 ? `Ajouter ${tracks.length} titres` : 'Ajouter à une playlist'}</h2>
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
          <button className="picker-item" onClick={() => done(likeTracks(tracks), 'Titres likés')}>
            <span className="picker-liked liked-gradient"><Heart size={20} fill="currentColor" /></span>
            <span className="grow ellipsis">Titres likés</span>
            <span className="muted small">{liked.length} titres</span>
            {contains(liked) && <Check size={18} className="accent" aria-label="Déjà ajouté" />}
          </button>
          {sharedLists.map((p) => (
            <button key={`s-${p.id}`} className="picker-item" onClick={() => {
              shared.add(p.id, tracks).then((n) => done(n, p.name)).catch((err) => toast((err as Error).message, 'error'));
            }}>
              <Mosaic covers={p.tracks.map((t) => t.thumbnail)} size={44} radius={6} />
              <span className="grow ellipsis">{p.name} <span className="muted small">· partagée</span></span>
              <span className="muted small">{p.tracks.length} titres</span>
              {contains(p.tracks) && <Check size={18} className="accent" aria-label="Déjà ajouté" />}
            </button>
          ))}
          {playlists.map((p) => (
            <button key={p.id} className="picker-item" onClick={() => done(addToPlaylist(p.id, tracks), p.name)}>
              <Mosaic covers={p.tracks.map((t) => t.thumbnail)} size={44} radius={6} />
              <span className="grow ellipsis">{p.name}</span>
              <span className="muted small">{p.tracks.length} titres</span>
              {contains(p.tracks) && <Check size={18} className="accent" aria-label="Déjà ajouté" />}
            </button>
          ))}
          {!playlists.length && <p className="muted small">Aucune autre playlist pour l'instant : créez-en une ci-dessus.</p>}
        </div>
      </div>
    </div>
  );
}
