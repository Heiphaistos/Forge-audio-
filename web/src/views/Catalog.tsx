import { Check, ExternalLink, Heart, ListEnd, ListPlus, Loader2, Play, Save, Shuffle, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type AlbumCardData, type AlbumPage, type ArtistCardData, type ArtistPage, type CatalogPlaylist } from '../lib/api';
import { GENRES } from '../components/Cards';
import type { Track } from '../lib/types';
import { formatTotal } from '../lib/format';
import { usePlayer } from '../store/player';
import { useUi } from '../store/ui';
import { useLibrary, useIsFollowed } from '../store/library';
import { findMix, useReco } from '../store/reco';
import { TrackList } from '../components/TrackList';
import { Cover } from '../components/Cover';

const fans = (n: number | null) => (n == null ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.0', '')} M d'abonnés` : n >= 1e3 ? `${Math.round(n / 1e3)} k abonnés` : `${n} abonnés`);
const TYPE: Record<string, string> = { album: 'Album', single: 'Single', ep: 'EP', compile: 'Compilation' };

export function ArtistCard({ a }: { a: ArtistCardData }) {
  const navigate = useUi((s) => s.navigate);
  return (
    <div className="card artist-card" onClick={() => navigate({ name: 'artist', q: a.name, id: String(a.id) })}>
      <Cover src={a.picture} size="100%" radius={999} />
      <div className="card-title ellipsis">{a.name}</div>
      <div className="card-sub">{fans(a.fans) || 'Artiste'}</div>
    </div>
  );
}

export function AlbumCard({ a, showArtist = false }: { a: AlbumCardData; showArtist?: boolean }) {
  const navigate = useUi((s) => s.navigate);
  const toast = useUi((s) => s.toast);
  const play = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try { usePlayer.getState().playList((await api.catalogAlbum(a.id)).tracks); } catch (err) { toast((err as Error).message, 'error'); }
  };
  return (
    <div className="card" onClick={() => navigate({ name: 'album', id: String(a.id) })}>
      <div className="card-cover"><Cover src={a.cover} size="100%" radius={8} /><button className="card-play" aria-label={`Lire ${a.title}`} onClick={play}><Play size={20} fill="currentColor" /></button></div>
      <div className="card-title ellipsis">{a.title}</div>
      <div className="card-sub ellipsis">{[a.year, TYPE[a.type] || 'Album', showArtist ? a.artist?.name : null].filter(Boolean).join(' · ')}</div>
    </div>
  );
}

function FollowButton({ name, picture }: { name: string; picture: string | null }) {
  const followed = useIsFollowed(name);
  const toast = useUi((s) => s.toast);
  return (
    <button className={`btn btn-ghost ${followed ? 'following' : ''}`} aria-pressed={followed} onClick={() => {
      const on = useLibrary.getState().toggleFollow(name, picture);
      toast(on ? 'Artiste ajouté à votre bibliothèque' : 'Vous ne suivez plus cet artiste', 'success');
    }}>{followed ? <><Check size={16} /> Abonné</> : <><UserPlus size={16} /> Suivre</>}</button>
  );
}

/** Artist page: top tracks, discography (albums / singles & EP), similar artists, biography. Falls back to a search when the catalogue does not know the artist. */
export function ArtistView() {
  const view = useUi((s) => s.view);
  const name = (view.q || '').replace(/\s*-\s*Topic$/i, '');
  const playList = usePlayer((s) => s.playList);
  const [state, setState] = useState<{ loading: boolean; page: ArtistPage | null; fallback: Track[]; error: string | null }>({ loading: true, page: null, fallback: [], error: null });
  const [tab, setTab] = useState<'albums' | 'singles'>('albums');
  const [more, setMore] = useState(false);

  useEffect(() => {
    let alive = true;
    setState({ loading: true, page: null, fallback: [], error: null });
    api.catalogArtist(view.id ? { id: Number(view.id) } : { name })
      .then((page) => alive && setState({ loading: false, page, fallback: [], error: null }))
      .catch(() => api.search(name, 'ytmusic', 30).catch(() => api.search(name, 'youtube', 30))
        .then((r) => alive && setState({ loading: false, page: null, fallback: r.tracks, error: null }))
        .catch((err) => alive && setState({ loading: false, page: null, fallback: [], error: err.message })));
    return () => { alive = false; };
  }, [name, view.id]);

  const p = state.page;
  const title = p?.artist.name || name;
  const top = p?.top || state.fallback;
  const disco = p ? (tab === 'albums' ? p.albums : p.singles) : [];
  return (
    <div className="page">
      <div className="hero artist-hero" style={{ ['--hero-img' as string]: p?.artist.picture || top[0]?.thumbnail ? `url("${p?.artist.picture || top[0]?.thumbnail}")` : 'none' }}>
        <div className="muted small">ARTISTE{p?.artist.fans ? ` · ${fans(p.artist.fans)}` : ''}</div>
        <h1 className="hero-title">{title}</h1>
        <div className="actions">
          <button className="btn btn-primary" disabled={!top.length} onClick={() => playList(top)}><Play size={16} fill="currentColor" /> Lecture</button>
          <button className="btn btn-ghost" disabled={!top.length} onClick={() => playList(top, 0, { shuffle: true })}><Shuffle size={16} /> Aléatoire</button>
          <FollowButton name={title} picture={p?.artist.picture || null} />
        </div>
      </div>
      {state.loading && <div className="empty"><Loader2 className="spin" size={28} /> Chargement…</div>}
      {state.error && <div className="empty error">{state.error}</div>}
      {!state.loading && top.length > 0 && (
        <section className="shelf">
          <div className="shelf-head"><h2>Titres populaires</h2>{top.length > 10 && <button className="link muted" onClick={() => setMore(!more)}>{more ? 'Moins' : 'Plus'}</button>}</div>
          <TrackList tracks={more ? top : top.slice(0, 10)} listKey={`artist:${title}`} />
        </section>
      )}
      {p && (p.albums.length > 0 || p.singles.length > 0) && (
        <section className="shelf">
          <div className="shelf-head">
            <h2>Discographie</h2>
            <div className="chips">
              <button className={`chip ${tab === 'albums' ? 'active' : ''}`} onClick={() => setTab('albums')}>Albums ({p.albums.length})</button>
              <button className={`chip ${tab === 'singles' ? 'active' : ''}`} onClick={() => setTab('singles')}>Singles et EP ({p.singles.length})</button>
            </div>
          </div>
          <div className="card-grid">{disco.map((a) => <AlbumCard key={a.id} a={a} />)}</div>
        </section>
      )}
      {p && p.related.length > 0 && (
        <section className="shelf">
          <div className="shelf-head"><h2>Artistes similaires</h2></div>
          <div className="card-grid">{p.related.map((a) => <ArtistCard key={a.id} a={a} />)}</div>
        </section>
      )}
      {p?.bio && (
        <section className="shelf about">
          <div className="shelf-head"><h2>À propos</h2></div>
          <p>{p.bio.text}</p>
          {p.bio.url && <a className="link muted small" href={p.bio.url} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Wikipédia</a>}
        </section>
      )}
    </div>
  );
}

/** Album page: tracks in order, play / shuffle / queue / add to a playlist / like all. */
export function AlbumView() {
  const id = Number(useUi((s) => s.view.id));
  const navigate = useUi((s) => s.navigate);
  const toast = useUi((s) => s.toast);
  const { playList, enqueue } = usePlayer.getState();
  const [page, setPage] = useState<AlbumPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setPage(null); setError(null); api.catalogAlbum(id).then(setPage).catch((e) => setError(e.message)); }, [id]);
  if (error) return <div className="page"><div className="empty error">{error}</div></div>;
  if (!page) return <div className="page"><div className="empty"><Loader2 className="spin" size={28} /> Chargement…</div></div>;
  const { album, tracks } = page;
  return (
    <div className="page">
      <div className="hero">
        <Cover src={album.cover} size={200} radius={10} />
        <div className="hero-info">
          <div className="muted small">{(TYPE[album.type] || 'Album').toUpperCase()}</div>
          <h1 className="hero-title">{album.title}</h1>
          <div className="muted small">
            {album.artist && <button className="link" onClick={() => navigate({ name: 'artist', q: album.artist!.name, id: String(album.artist!.id) })}>{album.artist.name}</button>}
            {` · ${[album.year, `${tracks.length} titres`, album.duration ? formatTotal(album.duration) : null, album.label].filter(Boolean).join(' · ')}`}
          </div>
        </div>
      </div>
      <div className="actions">
        <button className="play-btn big" disabled={!tracks.length} onClick={() => playList(tracks)} aria-label="Lire"><Play size={26} fill="currentColor" className="nudge" /></button>
        <button className="icon-btn big" disabled={!tracks.length} onClick={() => playList(tracks, 0, { shuffle: true })} aria-label="Lecture aléatoire"><Shuffle size={24} /></button>
        <button className="btn btn-ghost" onClick={() => enqueue(tracks)}><ListEnd size={16} /> File d'attente</button>
        <button className="btn btn-ghost" onClick={() => useUi.getState().openPicker(tracks)}><ListPlus size={16} /> Ajouter à une playlist…</button>
        <button className="btn btn-ghost" onClick={() => { const n = useLibrary.getState().likeTracks(tracks); toast(n ? `${n} titre(s) ajouté(s) aux titres likés` : 'Tout l\'album est déjà liké', 'success'); }}><Heart size={16} /> Tout liker</button>
      </div>
      <TrackList tracks={tracks} listKey={`album:${album.id}`} />
    </div>
  );
}

/** A recommended mix (« Mix du jour », « Découvertes de la semaine »). */
export function MixView() {
  const id = useUi((s) => s.view.id);
  useReco((s) => s.data);
  const mix = findMix(id);
  const toast = useUi((s) => s.toast);
  const navigate = useUi((s) => s.navigate);
  const { playList } = usePlayer.getState();
  if (!mix) return <div className="page"><div className="empty">Ce mix n'est plus disponible : les recommandations changent chaque jour. <button className="link accent" onClick={() => navigate({ name: 'home' })}>Accueil</button></div></div>;
  return (
    <div className="page">
      <div className="hero">
        <Cover src={mix.cover} size={200} radius={10} />
        <div className="hero-info">
          <div className="muted small">POUR VOUS</div>
          <h1 className="hero-title">{mix.title}</h1>
          <div className="muted small">{mix.subtitle} · {mix.tracks.length} titres</div>
        </div>
      </div>
      <div className="actions">
        <button className="play-btn big" onClick={() => playList(mix.tracks)} aria-label="Lire"><Play size={26} fill="currentColor" className="nudge" /></button>
        <button className="icon-btn big" onClick={() => playList(mix.tracks, 0, { shuffle: true })} aria-label="Lecture aléatoire"><Shuffle size={24} /></button>
        <button className="btn btn-ghost" onClick={() => { const pl = useLibrary.getState().createPlaylist(`${mix.title} (${new Date().toLocaleDateString('fr-FR')})`, mix.tracks); toast(`Enregistré dans « ${pl.name} »`, 'success'); }}><Save size={16} /> Enregistrer comme playlist</button>
      </div>
      <TrackList tracks={mix.tracks} listKey={`mix:${mix.id}`} />
    </div>
  );
}

/** A catalogue playlist (Deezer): opening it imports it like a pasted link. */
export function CatalogPlaylistCard({ p }: { p: CatalogPlaylist }) {
  const navigate = useUi((s) => s.navigate);
  return (
    <div className="card" onClick={() => navigate({ name: 'search', q: p.url })}>
      <div className="card-cover"><Cover src={p.cover} size="100%" radius={8} /></div>
      <div className="card-title ellipsis" title={p.title}>{p.title}</div>
      <div className="card-sub ellipsis">{p.tracks ?? '?'} titres · {p.by?.replace(/^.* - /, '') || 'Deezer'}</div>
    </div>
  );
}

/** Genre page (Home genre cards): official playlists by Deezer's curators, then the community mixes. */
export function GenreView() {
  const label = useUi((s) => s.view.id);
  const navigate = useUi((s) => s.navigate);
  const g = GENRES.find((x) => x.label === label);
  const [state, setState] = useState<{ list: CatalogPlaylist[] | null; error: string | null }>({ list: null, error: null });
  useEffect(() => {
    if (!g) return;
    let alive = true;
    api.catalogGenre(g.dz, g.pq).then((r) => alive && setState({ list: r.playlists, error: null })).catch((e) => alive && setState({ list: null, error: e.message }));
    return () => { alive = false; };
  }, [g]);
  if (!g) return <div className="page"><div className="empty">Genre inconnu.</div></div>;
  return (
    <div className="page">
      <div className="hero genre-hero" style={{ background: `linear-gradient(135deg, ${g.color}, transparent 85%)` }}>
        <div className="hero-info"><div className="muted small">GENRE</div><h1 className="hero-title">{g.label}</h1></div>
      </div>
      <section className="shelf">
        <div className="shelf-head"><h2>Playlists officielles</h2><span className="muted small">par les éditeurs de Deezer</span></div>
        {!state.list && !state.error && <div className="empty"><Loader2 className="spin" size={28} /> Chargement…</div>}
        {state.error && <div className="empty error">{state.error}</div>}
        {state.list && !state.list.length && <div className="empty small">Aucune playlist officielle trouvée pour ce genre.</div>}
        {state.list && state.list.length > 0 && <div className="card-grid">{state.list.map((p) => <CatalogPlaylistCard key={p.id} p={p} />)}</div>}
      </section>
      <section className="shelf">
        <div className="shelf-head"><h2>Mix de la communauté</h2></div>
        <button className="btn btn-ghost" onClick={() => navigate({ name: 'search', q: g.q })}><Play size={16} /> Voir les mix et playlists de la communauté</button>
      </section>
    </div>
  );
}
