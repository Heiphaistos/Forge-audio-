import { Check, ListEnd, LogOut, Pencil, Play, Shuffle, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { usePlayer } from '../store/player';
import { useUi } from '../store/ui';
import { nameOf, shared, useJam, useShared } from '../store/social';
import { Mosaic } from '../components/Cover';
import { TrackList } from '../components/TrackList';
import { AddTracks } from '../components/AddTracks';
import { ShareDialog } from '../components/ShareDialog';
import { formatTotal, timeAgo } from '../lib/format';

/** A playlist shared between accounts: every member adds, removes and reorders; the owner manages it. */
export function SharedPlaylistView() {
  const id = useUi((s) => s.view.id);
  const p = useShared((s) => s.list.find((x) => x.id === id));
  const loaded = useShared((s) => s.loaded);
  const me = useJam((s) => s.me);
  const navigate = useUi((s) => s.navigate);
  const toast = useUi((s) => s.toast);
  const { playList, enqueue } = usePlayer.getState();
  const [sharing, setSharing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');

  if (!p) return <div className="page"><div className="empty">{loaded ? 'Playlist partagée introuvable (supprimée, ou vous n\'en êtes plus membre).' : 'Chargement…'}</div></div>;
  const owner = p.owner === me;
  const total = p.tracks.reduce((a, t) => a + (t.duration || 0), 0);
  const fail = (err: unknown) => toast((err as Error).message, 'error');
  const people = [p.owner, ...p.members].map(nameOf);

  return (
    <div className="page">
      <div className="hero">
        <Mosaic covers={p.cover ? [p.cover] : p.tracks.map((t) => t.thumbnail)} size={200} radius={10} />
        <div className="hero-info">
          <div className="muted small"><Users size={12} /> PLAYLIST PARTAGÉE</div>
          {editing ? (
            <form className="edit-form" onSubmit={(e) => { e.preventDefault(); shared.update(p.id, { name: name.trim() || p.name }).catch(fail); setEditing(false); }}>
              <input className="input hero-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label="Nom" />
              <div className="row gap">
                <button className="btn btn-primary btn-sm" type="submit"><Check size={14} /> Enregistrer</button>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => setEditing(false)}>Annuler</button>
              </div>
            </form>
          ) : <h1 className="hero-title">{p.name}</h1>}
          {p.description && <p className="muted">{p.description}</p>}
          <div className="muted small">{people.join(', ')} · {p.tracks.length} titres{total ? ` · ${formatTotal(total)}` : ''} · modifiée {timeAgo(p.updatedAt)}</div>
        </div>
      </div>
      <div className="actions">
        <button className="play-btn big" disabled={!p.tracks.length} onClick={() => playList(p.tracks)} aria-label="Lire"><Play size={26} fill="currentColor" className="nudge" /></button>
        <button className="icon-btn big" disabled={!p.tracks.length} onClick={() => playList(p.tracks, 0, { shuffle: true })} aria-label="Lecture aléatoire"><Shuffle size={24} /></button>
        <button className="btn btn-ghost" disabled={!p.tracks.length} onClick={() => enqueue(p.tracks)}><ListEnd size={16} /> File d'attente</button>
        {owner && <button className="btn btn-ghost" onClick={() => setSharing(true)}><Users size={16} /> Membres</button>}
        {owner && <button className="btn btn-ghost" onClick={() => { setName(p.name); setEditing(true); }}><Pencil size={16} /> Renommer</button>}
        <button className="btn btn-ghost danger" onClick={() => {
          if (!confirm(owner ? `Supprimer « ${p.name} » pour tous les membres ?` : `Quitter « ${p.name} » ? Elle disparaîtra de votre bibliothèque.`)) return;
          shared.leave(p.id).then((deleted) => { toast(deleted ? 'Playlist supprimée' : 'Vous avez quitté la playlist'); navigate({ name: 'library' }); }).catch(fail);
        }}>{owner ? <><Trash2 size={16} /> Supprimer</> : <><LogOut size={16} /> Quitter</>}</button>
      </div>
      <AddTracks have={new Set(p.tracks.map((t) => t.url))} startOpen={!p.tracks.length} onAdd={(t) => {
        shared.add(p.id, [t]).then((n) => n && toast(`Ajouté à « ${p.name} »`, 'success')).catch(fail);
      }} />
      <TrackList
        tracks={p.tracks}
        playlistId={`shared:${p.id}`}
        onReorder={(from, to) => shared.move(p.id, from, to).catch(fail)}
        empty="Cette playlist est vide : ajoutez des titres ci-dessus, les autres membres les verront tout de suite."
      />
      {sharing && (
        <ShareDialog title="Membres de la playlist" initial={p.members} confirm="Enregistrer" onClose={() => setSharing(false)}
          onDone={(members) => shared.update(p.id, { members }).then(() => toast('Membres mis à jour', 'success'))} />
      )}
    </div>
  );
}
