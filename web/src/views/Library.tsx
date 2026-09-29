import { Plus, Upload, Download, FolderOpen, Heart, Play, Shuffle, Trash2, Pencil, Copy, RefreshCw, ListEnd, Loader2, ArrowDownUp, Search as SearchIcon, Check } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useLibrary } from '../store/library';
import { usePlayer } from '../store/player';
import { useUi } from '../store/ui';
import { PlaylistCard } from '../components/Cards';
import { Mosaic } from '../components/Cover';
import { TrackList } from '../components/TrackList';
import { ImportBox } from './Home';
import { api } from '../lib/api';
import { formatTotal, timeAgo, uid } from '../lib/format';
import type { Track } from '../lib/types';

function downloadText(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Play audio files from disk (kept for the session only: browsers do not allow reopening them later). */
export function LocalFilesButton() {
  const input = useRef<HTMLInputElement>(null);
  const playList = usePlayer((s) => s.playList);
  return (
    <>
      <button className="btn btn-ghost" onClick={() => input.current?.click()}><FolderOpen size={16} /> Fichiers locaux</button>
      <input ref={input} type="file" accept="audio/*,video/*" multiple hidden onChange={(e) => {
        const files = [...(e.target.files || [])];
        const tracks: Track[] = files.map((f) => ({
          id: uid(), title: f.name.replace(/\.[^.]+$/, ''), url: URL.createObjectURL(f), duration: null, thumbnail: null, author: 'Fichier local', source: 'local',
        }));
        if (tracks.length) playList(tracks);
        e.target.value = '';
      }} />
    </>
  );
}

export function Library() {
  const playlists = useLibrary((s) => s.playlists);
  const liked = useLibrary((s) => s.liked);
  const { createPlaylist, exportData, importData } = useLibrary.getState();
  const navigate = useUi((s) => s.navigate);
  const toast = useUi((s) => s.toast);
  const playList = usePlayer((s) => s.playList);
  const fileInput = useRef<HTMLInputElement>(null);
  const [sort, setSort] = useState<'recent' | 'name' | 'size'>('recent');

  const sorted = useMemo(() => {
    const list = [...playlists];
    if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    if (sort === 'size') list.sort((a, b) => b.tracks.length - a.tracks.length);
    if (sort === 'recent') list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
  }, [playlists, sort]);

  return (
    <div className="page">
      <h1 className="page-title">Bibliothèque</h1>
      <div className="actions">
        <button className="btn btn-primary" onClick={() => { const p = createPlaylist(`Ma playlist n°${playlists.length + 1}`); navigate({ name: 'playlist', id: p.id }); }}><Plus size={16} /> Nouvelle playlist</button>
        <LocalFilesButton />
        <button className="btn btn-ghost" onClick={() => downloadText(`forge-audio-${new Date().toISOString().slice(0, 10)}.json`, exportData())}><Download size={16} /> Exporter</button>
        <button className="btn btn-ghost" onClick={() => fileInput.current?.click()}><Upload size={16} /> Importer</button>
        <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          try {
            const r = importData(await f.text());
            toast(`${r.playlists} playlist(s) et ${r.liked} titre(s) liké(s) importés`, 'success');
          } catch (err) {
            toast(`Import impossible : ${(err as Error).message}`, 'error');
          }
          e.target.value = '';
        }} />
      </div>
      <ImportBox />
      <div className="row gap shelf-head">
        <h2 className="grow">Playlists</h2>
        <ArrowDownUp size={16} className="muted" />
        <select className="select" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Trier">
          <option value="recent">Récentes</option>
          <option value="name">Nom</option>
          <option value="size">Nombre de titres</option>
        </select>
      </div>
      <div className="card-grid">
        <div className="card liked-card" onClick={() => navigate({ name: 'liked' })}>
          <div className="liked-card-inner">
            <Heart size={36} fill="currentColor" />
            <div>
              <div className="card-title">Titres likés</div>
              <div className="card-sub">{liked.length} titres</div>
            </div>
          </div>
          {liked.length > 0 && <button className="card-play" aria-label="Lire les titres likés" onClick={(e) => { e.stopPropagation(); playList(liked); }}><Play size={20} fill="currentColor" /></button>}
        </div>
        {sorted.map((p) => (
          <PlaylistCard key={p.id} name={p.name} sub={`${p.tracks.length} titres · ${timeAgo(p.updatedAt)}`} covers={p.cover ? [p.cover] : p.tracks.map((t) => t.thumbnail)}
            onOpen={() => navigate({ name: 'playlist', id: p.id })} onPlay={() => playList(p.tracks)} />
        ))}
      </div>
      {!playlists.length && <p className="muted">Créez une playlist, ou collez le lien d'une playlist YouTube / SoundCloud ci-dessus pour l'importer.</p>}
    </div>
  );
}

type SortKey = 'custom' | 'title' | 'author' | 'duration';

function sortTracks(tracks: Track[], key: SortKey) {
  if (key === 'custom') return tracks;
  const list = [...tracks];
  if (key === 'title') list.sort((a, b) => a.title.localeCompare(b.title, 'fr'));
  if (key === 'author') list.sort((a, b) => (a.author || '').localeCompare(b.author || '', 'fr'));
  if (key === 'duration') list.sort((a, b) => (a.duration || 0) - (b.duration || 0));
  return list;
}

export function PlaylistView() {
  const id = useUi((s) => s.view.id);
  const pl = useLibrary((s) => s.playlists.find((p) => p.id === id));
  const { updatePlaylist, deletePlaylist, duplicatePlaylist, movePlaylistTrack, addToPlaylist, exportData } = useLibrary.getState();
  const navigate = useUi((s) => s.navigate);
  const toast = useUi((s) => s.toast);
  const { playList, enqueue } = usePlayer.getState();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortKey>('custom');
  const [syncing, setSyncing] = useState(false);

  const shown = useMemo(() => {
    if (!pl) return [];
    const f = filter.trim().toLowerCase();
    const list = f ? pl.tracks.filter((t) => `${t.title} ${t.author || ''}`.toLowerCase().includes(f)) : pl.tracks;
    return sortTracks(list, sort);
  }, [pl, filter, sort]);

  if (!pl) return <div className="page"><div className="empty">Playlist introuvable.</div></div>;
  const total = pl.tracks.reduce((a, t) => a + (t.duration || 0), 0);
  const reorderable = sort === 'custom' && !filter;

  return (
    <div className="page">
      <div className="hero">
        <Mosaic covers={pl.cover ? [pl.cover] : pl.tracks.map((t) => t.thumbnail)} size={200} radius={10} />
        <div className="hero-info">
          <div className="muted small">PLAYLIST</div>
          {editing ? (
            <form className="edit-form" onSubmit={(e) => { e.preventDefault(); updatePlaylist(pl.id, { name: name.trim() || pl.name, description: desc }); setEditing(false); }}>
              <input className="input hero-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label="Nom" />
              <textarea className="input" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description (facultatif)" rows={2} aria-label="Description" />
              <div className="row gap">
                <button className="btn btn-primary btn-sm" type="submit"><Check size={14} /> Enregistrer</button>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => setEditing(false)}>Annuler</button>
              </div>
            </form>
          ) : (
            <>
              <h1 className="hero-title" onClick={() => { setName(pl.name); setDesc(pl.description); setEditing(true); }} title="Cliquer pour renommer">{pl.name}</h1>
              {pl.description && <p className="muted">{pl.description}</p>}
            </>
          )}
          <div className="muted small">{pl.tracks.length} titres{total ? ` · ${formatTotal(total)}` : ''} · modifiée {timeAgo(pl.updatedAt)}</div>
        </div>
      </div>
      <div className="actions">
        <button className="play-btn big" disabled={!pl.tracks.length} onClick={() => playList(shown)} aria-label="Lire"><Play size={26} fill="currentColor" className="nudge" /></button>
        <button className="icon-btn big" disabled={!pl.tracks.length} onClick={() => playList(shown, 0, { shuffle: true })} aria-label="Lecture aléatoire" title="Lecture aléatoire"><Shuffle size={24} /></button>
        <button className="btn btn-ghost" disabled={!pl.tracks.length} onClick={() => enqueue(shown)}><ListEnd size={16} /> File d'attente</button>
        <button className="btn btn-ghost" onClick={() => { setName(pl.name); setDesc(pl.description); setEditing(true); }}><Pencil size={16} /> Modifier</button>
        <button className="btn btn-ghost" onClick={() => { duplicatePlaylist(pl.id); toast('Playlist dupliquée', 'success'); }}><Copy size={16} /> Dupliquer</button>
        <button className="btn btn-ghost" onClick={() => {
          const data = JSON.parse(exportData());
          downloadText(`${pl.name}.json`, JSON.stringify({ ...data, playlists: [pl], liked: [] }, null, 2));
        }}><Download size={16} /> Exporter</button>
        {pl.sourceUrl && (
          <button className="btn btn-ghost" disabled={syncing} onClick={async () => {
            setSyncing(true);
            try {
              const r = await api.resolve(pl.sourceUrl!);
              const n = addToPlaylist(pl.id, r.tracks);
              toast(n ? `${n} nouveau(x) titre(s) ajouté(s)` : 'Déjà à jour', 'success');
            } catch (err) { toast((err as Error).message, 'error'); } finally { setSyncing(false); }
          }}>{syncing ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />} Synchroniser</button>
        )}
        <button className="btn btn-ghost danger" onClick={() => {
          if (confirm(`Supprimer la playlist « ${pl.name} » ?`)) { deletePlaylist(pl.id); navigate({ name: 'library' }); toast('Playlist supprimée'); }
        }}><Trash2 size={16} /> Supprimer</button>
      </div>
      {pl.tracks.length > 0 && (
        <div className="row gap list-tools">
          <div className="filter-input"><SearchIcon size={14} /><input placeholder="Filtrer dans la playlist" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
          <select className="select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Trier">
            <option value="custom">Ordre personnalisé</option>
            <option value="title">Titre</option>
            <option value="author">Artiste</option>
            <option value="duration">Durée</option>
          </select>
        </div>
      )}
      <TrackList
        tracks={shown}
        playlistId={reorderable ? pl.id : undefined}
        onReorder={reorderable ? (from, to) => movePlaylistTrack(pl.id, from, to) : undefined}
        empty={<>Cette playlist est vide. <button className="link accent" onClick={() => navigate({ name: 'search' })}>Rechercher des titres</button></>}
      />
    </div>
  );
}

export function Liked() {
  const liked = useLibrary((s) => s.liked);
  const { playList, enqueue } = usePlayer.getState();
  const total = liked.reduce((a, t) => a + (t.duration || 0), 0);
  return (
    <div className="page">
      <div className="hero">
        <div className="hero-cover liked-gradient"><Heart size={72} fill="currentColor" /></div>
        <div className="hero-info">
          <div className="muted small">PLAYLIST</div>
          <h1 className="hero-title">Titres likés</h1>
          <div className="muted small">{liked.length} titres{total ? ` · ${formatTotal(total)}` : ''}</div>
        </div>
      </div>
      <div className="actions">
        <button className="play-btn big" disabled={!liked.length} onClick={() => playList(liked)} aria-label="Lire"><Play size={26} fill="currentColor" className="nudge" /></button>
        <button className="icon-btn big" disabled={!liked.length} onClick={() => playList(liked, 0, { shuffle: true })} aria-label="Lecture aléatoire"><Shuffle size={24} /></button>
        <button className="btn btn-ghost" disabled={!liked.length} onClick={() => enqueue(liked)}><ListEnd size={16} /> File d'attente</button>
      </div>
      <TrackList tracks={liked} empty="Les titres que vous aimez apparaîtront ici. Cliquez sur ♥ à côté d'un titre." />
    </div>
  );
}

export function HistoryView() {
  const history = useLibrary((s) => s.history);
  const clearHistory = useLibrary((s) => s.clearHistory);
  const playList = usePlayer((s) => s.playList);
  const tracks = useMemo(() => history.map((h) => h.track), [history]);
  return (
    <div className="page">
      <div className="row gap">
        <h1 className="page-title grow">Historique</h1>
        {history.length > 0 && <button className="btn btn-ghost" onClick={() => { if (confirm("Effacer tout l'historique ?")) clearHistory(); }}><Trash2 size={16} /> Effacer</button>}
      </div>
      <TrackList tracks={tracks} onPlay={(i) => playList(tracks, i)} empty="Aucune écoute pour l'instant." />
    </div>
  );
}
