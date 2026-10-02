import { Plus, Upload, Download, FolderOpen, Heart, Play, Shuffle, Trash2, Pencil, Copy, RefreshCw, ListEnd, Loader2, ArrowDownUp, Search as SearchIcon, Check, Users, GitMerge, Pin, PinOff, ImagePlus, Folder, ListPlus } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useLibrary } from '../store/library';
import { parseSpotifyLiked } from '../lib/spotifyLiked';
import { SpotifyImportDialog } from '../components/SpotifyImportDialog';
import { usePlayer } from '../store/player';
import { useUi } from '../store/ui';
import { PlaylistCard } from '../components/Cards';
import { Mosaic } from '../components/Cover';
import { TrackList } from '../components/TrackList';
import { AddTracks } from '../components/AddTracks';
import { ShareDialog } from '../components/ShareDialog';
import { MergeDialog } from '../components/MergeDialog';
import { shared, useShared, useJam, nameOf } from '../store/social';
import { Cover } from '../components/Cover';
import { ImportBox } from './Home';
import { DownloadAll } from '../components/DownloadAll';
import { api } from '../lib/api';
import { formatTotal, timeAgo, uid } from '../lib/format';
import type { Track } from '../lib/types';
import { OfflineButton } from './Offline';

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
  const artists = useLibrary((s) => s.followedArtists);
  const sharedLists = useShared((s) => s.list);
  const { createPlaylist, exportData, importData } = useLibrary.getState();
  const navigate = useUi((s) => s.navigate);
  const toast = useUi((s) => s.toast);
  const playList = usePlayer((s) => s.playList);
  const fileInput = useRef<HTMLInputElement>(null);
  const [sort, setSort] = useState<'recent' | 'name' | 'size'>('recent');
  const [merging, setMerging] = useState(false);
  const [spotifyImport, setSpotifyImport] = useState<Track[] | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const folders = useMemo(() => [...new Set(playlists.map((p) => p.folder).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, 'fr')), [playlists]);

  const sorted = useMemo(() => {
    const list = playlists.filter((p) => !folder || p.folder === folder);
    if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    if (sort === 'size') list.sort((a, b) => b.tracks.length - a.tracks.length);
    if (sort === 'recent') list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  }, [playlists, sort, folder]);

  return (
    <div className="page">
      <h1 className="page-title">Bibliothèque</h1>
      <div className="actions">
        <button className="btn btn-primary" onClick={() => { const p = createPlaylist(`Ma playlist n°${playlists.length + 1}`); navigate({ name: 'playlist', id: p.id }); }}><Plus size={16} /> Nouvelle playlist</button>
        <LocalFilesButton />
        <button className="btn btn-ghost" onClick={() => setMerging(true)}><GitMerge size={16} /> Fusionner</button>
        <button className="btn btn-ghost" onClick={() => downloadText(`forge-audio-${new Date().toISOString().slice(0, 10)}.json`, exportData())}><Download size={16} /> Exporter</button>
        <button className="btn btn-ghost" title="Sauvegarde Forge Audio (.json), ou titres likés Spotify : CSV « Liked Songs » d’exportify.app, ou YourLibrary.json de l’export de données Spotify" onClick={() => fileInput.current?.click()}><Upload size={16} /> Importer</button>
        <input ref={fileInput} type="file" accept="application/json,.json,text/csv,.csv" hidden onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          try {
            const text = await f.text();
            const spotify = parseSpotifyLiked(text);
            if (spotify?.length) setSpotifyImport(spotify);
            else if (spotify) toast('Aucun titre Spotify dans ce fichier', 'error');
            else {
              const r = importData(text);
              toast(`${r.playlists} playlist(s) et ${r.liked} titre(s) liké(s) importés`, 'success');
            }
          } catch (err) {
            toast(`Import impossible : ${(err as Error).message}`, 'error');
          }
          e.target.value = '';
        }} />
      </div>
      <ImportBox />
      <p className="muted">Titres likés Spotify : exportez « Liked Songs » en CSV sur <a className="link" style={{ textDecoration: 'underline' }} href="https://exportify.app" target="_blank" rel="noreferrer">exportify.app</a>, puis Importer.</p>
      <div className="row gap shelf-head">
        <h2 className="grow">Playlists</h2>
        <ArrowDownUp size={16} className="muted" />
        <select className="select" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Trier">
          <option value="recent">Récentes</option>
          <option value="name">Nom</option>
          <option value="size">Nombre de titres</option>
        </select>
      </div>
      {folders.length > 0 && (
        <div className="chips">
          <button className={`chip ${!folder ? 'active' : ''}`} onClick={() => setFolder(null)}>Toutes</button>
          {folders.map((f) => <button key={f} className={`chip ${folder === f ? 'active' : ''}`} onClick={() => setFolder(folder === f ? null : f)}><Folder size={13} /> {f}</button>)}
        </div>
      )}
      {merging && <MergeDialog onClose={() => setMerging(false)} />}
      {spotifyImport && <SpotifyImportDialog tracks={spotifyImport} onClose={() => setSpotifyImport(null)} />}
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
          <PlaylistCard key={p.id} name={`${p.pinned ? '📌 ' : ''}${p.name}`} sub={`${p.folder ? `${p.folder} · ` : ''}${p.tracks.length} titres · ${timeAgo(p.updatedAt)}`} covers={p.cover ? [p.cover] : p.tracks.map((t) => t.thumbnail)}
            onOpen={() => navigate({ name: 'playlist', id: p.id })} onPlay={() => playList(p.tracks)} />
        ))}
      </div>
      {!playlists.length && <p className="muted">Créez une playlist, ou collez le lien d'une playlist YouTube / SoundCloud ci-dessus pour l'importer.</p>}
      {sharedLists.length > 0 && (
        <>
          <div className="row gap shelf-head"><h2 className="grow">Playlists partagées</h2></div>
          <div className="card-grid">
            {sharedLists.map((p) => (
              <PlaylistCard key={p.id} name={p.name} sub={`${[p.owner, ...p.members].map(nameOf).join(', ')} · ${p.tracks.length} titres`} covers={p.cover ? [p.cover] : p.tracks.map((t) => t.thumbnail)}
                onOpen={() => navigate({ name: 'shared', id: p.id })} onPlay={() => playList(p.tracks)} />
            ))}
          </div>
        </>
      )}
      {artists.length > 0 && (
        <>
          <div className="row gap shelf-head"><h2 className="grow">Artistes suivis</h2></div>
          <div className="card-grid">
            {artists.map((a) => (
              <div key={a.name} className="card artist-card" onClick={() => navigate({ name: 'artist', q: a.name })}>
                <Cover src={a.thumbnail} size="100%" radius={999} />
                <div className="card-title ellipsis">{a.name}</div>
                <div className="card-sub">Artiste</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

type SortKey = 'custom' | 'added' | 'title' | 'author' | 'duration';

function sortTracks(tracks: Track[], key: SortKey) {
  if (key === 'custom') return tracks;
  const list = [...tracks];
  if (key === 'added') list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
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
  const [sharing, setSharing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [folderInput, setFolderInput] = useState('');
  const canShare = useJam((s) => !!s.me);
  const coverInput = useRef<HTMLInputElement>(null);
  const allFolders = useLibrary((s) => [...new Set(s.playlists.map((p) => p.folder).filter(Boolean) as string[])].join('\u0000'));

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
            <form className="edit-form" onSubmit={(e) => { e.preventDefault(); updatePlaylist(pl.id, { name: name.trim() || pl.name, description: desc, folder: folderInput.trim() || null }); setEditing(false); }}>
              <input className="input hero-input" value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label="Nom" />
              <textarea className="input" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description (facultatif)" rows={2} aria-label="Description" />
              <input className="input" list="pl-folders" value={folderInput} onChange={(e) => setFolderInput(e.target.value)} placeholder="Dossier (facultatif), ex. Soirées" aria-label="Dossier" maxLength={60} />
              <datalist id="pl-folders">{allFolders.split('\u0000').filter(Boolean).map((f) => <option key={f} value={f} />)}</datalist>
              <div className="row gap">
                <button className="btn btn-primary btn-sm" type="submit"><Check size={14} /> Enregistrer</button>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => setEditing(false)}>Annuler</button>
              </div>
            </form>
          ) : (
            <>
              <h1 className="hero-title" onClick={() => { setName(pl.name); setDesc(pl.description); setFolderInput(pl.folder || ''); setEditing(true); }} title="Cliquer pour renommer">{pl.name}</h1>
              {pl.folder && <div className="muted small"><Folder size={12} /> {pl.folder}</div>}
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
        <OfflineButton set={`pl:${pl.id}`} tracks={pl.tracks} name={pl.name} />
        <button className="btn btn-ghost" onClick={() => { setName(pl.name); setDesc(pl.description); setFolderInput(pl.folder || ''); setEditing(true); }}><Pencil size={16} /> Modifier</button>
        <button className="btn btn-ghost" onClick={() => { updatePlaylist(pl.id, { pinned: !pl.pinned }); toast(pl.pinned ? 'Désépinglée' : 'Épinglée en haut de la liste', 'success'); }}>{pl.pinned ? <><PinOff size={16} /> Désépingler</> : <><Pin size={16} /> Épingler</>}</button>
        <button className="btn btn-ghost" onClick={() => coverInput.current?.click()}><ImagePlus size={16} /> Image</button>
        {pl.cover?.startsWith('/api/covers/') && <button className="btn btn-ghost" onClick={() => updatePlaylist(pl.id, { cover: null })}>Retirer l'image</button>}
        <input ref={coverInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          if (f.size > 2 * 1024 * 1024) { toast('Image trop lourde (2 Mo maximum)', 'error'); return; }
          try { const { url } = await api.uploadCover(f); updatePlaylist(pl.id, { cover: url }); toast('Image de la playlist changée', 'success'); } catch (err) { toast((err as Error).message, 'error'); }
        }} />
        <button className="btn btn-ghost" onClick={() => setMerging(true)}><GitMerge size={16} /> Fusionner avec…</button>
        <button className="btn btn-ghost" onClick={() => { duplicatePlaylist(pl.id); toast('Playlist dupliquée', 'success'); }}><Copy size={16} /> Dupliquer</button>
        {canShare && <button className="btn btn-ghost" onClick={() => setSharing(true)}><Users size={16} /> Partager</button>}
        <button className="btn btn-ghost" onClick={() => {
          const data = JSON.parse(exportData());
          downloadText(`${pl.name}.json`, JSON.stringify({ ...data, playlists: [pl], liked: [] }, null, 2));
        }}><Download size={16} /> Exporter</button>
        <DownloadAll name={pl.name} tracks={pl.tracks} />
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
            <option value="added">Date d'ajout</option>
            <option value="title">Titre</option>
            <option value="author">Artiste</option>
            <option value="duration">Durée</option>
          </select>
        </div>
      )}
      <AddTracks have={new Set(pl.tracks.map((t) => t.url))} startOpen={!pl.tracks.length} onAdd={(t) => {
        if (addToPlaylist(pl.id, [t])) toast(`Ajouté à « ${pl.name} »`, 'success');
      }} />
      <TrackList
        tracks={shown}
        playlistId={reorderable ? pl.id : undefined}
        onReorder={reorderable ? (from, to) => movePlaylistTrack(pl.id, from, to) : undefined}
        empty={<>Cette playlist est vide. <button className="link accent" onClick={() => navigate({ name: 'search' })}>Rechercher des titres</button></>}
      />
      {merging && <MergeDialog preselect={[pl.id]} onClose={() => setMerging(false)} />}
      {sharing && (
        <ShareDialog title={`Partager « ${pl.name} »`} confirm="Partager la playlist" onClose={() => setSharing(false)} onDone={async (members) => {
          if (!members.length) throw new Error('Choisissez au moins un compte');
          // The playlist becomes collaborative: it moves to the server, the local copy is removed.
          const sp = await shared.create(pl.name, pl.tracks, members, { description: pl.description, cover: pl.cover });
          deletePlaylist(pl.id);
          toast(`« ${sp.name} » est maintenant partagée`, 'success');
          navigate({ name: 'shared', id: sp.id });
        }} />
      )}
    </div>
  );
}

export function Liked() {
  const liked = useLibrary((s) => s.liked);
  const { playList, enqueue } = usePlayer.getState();
  const toast = useUi((s) => s.toast);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<SortKey>('custom');
  const total = liked.reduce((a, t) => a + (t.duration || 0), 0);
  // "custom" = newest like first, the order they are stored in.
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return sortTracks(f ? liked.filter((t) => `${t.title} ${t.author || ''}`.toLowerCase().includes(f)) : liked, sort);
  }, [liked, filter, sort]);
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
        <button className="play-btn big" disabled={!liked.length} onClick={() => playList(shown)} aria-label="Lire"><Play size={26} fill="currentColor" className="nudge" /></button>
        <button className="icon-btn big" disabled={!liked.length} onClick={() => playList(shown, 0, { shuffle: true })} aria-label="Lecture aléatoire"><Shuffle size={24} /></button>
        <button className="btn btn-ghost" disabled={!liked.length} onClick={() => enqueue(shown)}><ListEnd size={16} /> File d'attente</button>
        <OfflineButton set="liked" tracks={liked} name="Titres likés" />
        <button className="btn btn-ghost" disabled={!shown.length} onClick={() => useUi.getState().openPicker(shown)} title="Nouvelle playlist (ou une existante) avec ces titres ; vos likes ne bougent pas">
          <ListPlus size={16} /> {filter ? `Créer une playlist avec ces ${shown.length} titres` : `Créer une playlist avec les ${shown.length} titres`}
        </button>
        <DownloadAll name="Titres likés" tracks={liked} />
      </div>
      <p className="muted small">Astuce : pour n'en prendre que certains, touchez <b>Sélectionner</b> (ou Ctrl/Maj + clic, appui long sur téléphone), puis « Ajouter à une playlist… ».</p>
      {liked.length > 0 && (
        <div className="row gap list-tools">
          <div className="filter-input"><SearchIcon size={14} /><input placeholder="Filtrer dans les titres likés" value={filter} onChange={(e) => setFilter(e.target.value)} /></div>
          <select className="select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Trier">
            <option value="custom">Ajoutés récemment</option>
            <option value="title">Titre</option>
            <option value="author">Artiste</option>
            <option value="duration">Durée</option>
          </select>
        </div>
      )}
      <AddTracks have={new Set(liked.map((t) => t.url))} startOpen={!liked.length} onAdd={(t) => {
        if (useLibrary.getState().likeTracks([t])) toast('Ajouté aux titres likés', 'success');
      }} />
      <TrackList tracks={shown} listKey="liked" empty={liked.length ? `Aucun titre liké ne correspond à « ${filter} »` : 'Les titres que vous aimez apparaîtront ici : touchez ♥ à côté d\'un titre, ou ajoutez-en ci-dessus.'} />
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
      <TrackList tracks={tracks} listKey="history" onPlay={(i) => playList(tracks, i)} empty="Aucune écoute pour l'instant." />
    </div>
  );
}
