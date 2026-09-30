import { Heart, Link2, Loader2, Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useLibrary } from '../store/library';
import { usePlayer } from '../store/player';
import { useUi } from '../store/ui';
import { GenreGrid, PlaylistCard, Shelf, TrackCard } from '../components/Cards';
import { AlbumCard } from './Catalog';
import { loadReco, useReco } from '../store/reco';
import { Mosaic } from '../components/Cover';
import { api, isUrl } from '../lib/api';
import type { Track } from '../lib/types';

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Bonne nuit';
  if (h < 12) return 'Bonjour';
  if (h < 18) return 'Bon après-midi';
  return 'Bonsoir';
}

/** Play a pasted or shared link: a track plays at once, a playlist is imported. Shared by the paste box and the mobile apps' share target. */
export async function openLink(url: string) {
  const { toast, navigate } = useUi.getState();
  const res = await api.resolve(url.trim());
  if (res.type === 'playlist' && res.tracks.length > 1) {
    const pl = useLibrary.getState().createPlaylist(res.title || 'Playlist importée', res.tracks, { sourceUrl: res.url, cover: res.thumbnail });
    toast(`Playlist « ${pl.name} » importée (${res.tracks.length} titres)`, 'success');
    navigate({ name: 'playlist', id: pl.id });
  } else {
    usePlayer.getState().playList(res.tracks);
  }
}

export function ImportBox() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const toast = useUi((s) => s.toast);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isUrl(url)) return toast('Collez un lien valide (YouTube, SoundCloud, Dailymotion, Bandcamp…)', 'error');
    setLoading(true);
    try {
      await openLink(url);
      setUrl('');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="import-box" onSubmit={submit}>
      <Link2 size={18} className="muted" />
      <input className="grow" placeholder="Coller un lien : YouTube, Spotify, Deezer, Apple Music, SoundCloud, Dailymotion, Bandcamp…" value={url} onChange={(e) => setUrl(e.target.value)} />
      <button className="btn btn-primary btn-sm" disabled={loading || !url}>{loading ? <Loader2 size={16} className="spin" /> : 'Lire / Importer'}</button>
    </form>
  );
}

export function Home() {
  const history = useLibrary((s) => s.history);
  const playlists = useLibrary((s) => s.playlists);
  const liked = useLibrary((s) => s.liked);
  const counts = useLibrary((s) => s.playCounts);
  const navigate = useUi((s) => s.navigate);
  const playList = usePlayer((s) => s.playList);

  const recent = useMemo(() => {
    const seen = new Set<string>();
    const out: Track[] = [];
    for (const h of history) if (!seen.has(h.track.url) && seen.add(h.track.url)) out.push(h.track);
    return out.slice(0, 20);
  }, [history]);

  const top = useMemo(() => {
    const byUrl = new Map(history.map((h) => [h.track.url, h.track]));
    return Object.entries(counts).filter(([u, n]) => n > 1 && byUrl.has(u)).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([u]) => byUrl.get(u)!);
  }, [history, counts]);

  const quick = playlists.slice(0, 5);
  const reco = useReco((s) => s.data);
  const recoLoading = useReco((s) => s.loading);
  useEffect(() => { loadReco(); }, []);
  const mixes = reco ? [...reco.mixes, ...(reco.discover ? [reco.discover] : [])] : [];

  return (
    <div className="page">
      <h1 className="page-title">{greeting()}</h1>
      <div className="quick-grid">
        <div className="quick" onClick={() => navigate({ name: 'liked' })}>
          <div className="quick-cover liked-gradient"><Heart size={22} fill="currentColor" /></div>
          <span className="ellipsis">Titres likés</span>
          {liked.length > 0 && <button className="quick-play" aria-label="Lire les titres likés" onClick={(e) => { e.stopPropagation(); playList(liked); }}><Play size={18} fill="currentColor" /></button>}
        </div>
        {quick.map((p) => (
          <div key={p.id} className="quick" onClick={() => navigate({ name: 'playlist', id: p.id })}>
            <Mosaic covers={p.cover ? [p.cover] : p.tracks.map((t) => t.thumbnail)} size={56} radius={0} />
            <span className="ellipsis">{p.name}</span>
            {p.tracks.length > 0 && <button className="quick-play" aria-label={`Lire ${p.name}`} onClick={(e) => { e.stopPropagation(); playList(p.tracks); }}><Play size={18} fill="currentColor" /></button>}
          </div>
        ))}
      </div>

      <ImportBox />

      {(mixes.length > 0 || recoLoading) && (
        <Shelf title="Conçu pour vous" action={recoLoading ? <span className="muted small"><Loader2 size={13} className="spin" /> Préparation de vos mix…</span> : undefined}>
          {mixes.map((m) => (
            <PlaylistCard key={m.id} name={m.title} sub={m.subtitle} covers={m.cover ? [m.cover] : m.tracks.map((t) => t.thumbnail)}
              onOpen={() => navigate({ name: 'mix', id: m.id })} onPlay={() => playList(m.tracks)} />
          ))}
        </Shelf>
      )}
      {reco && reco.radar.length > 0 && (
        <Shelf title="Radar des sorties">
          {reco.radar.map((a) => <AlbumCard key={a.id} a={a} showArtist />)}
        </Shelf>
      )}

      {recent.length > 0 && (
        <Shelf title="Écoutés récemment" action={<button className="link muted" onClick={() => navigate({ name: 'history' })}>Tout afficher</button>}>
          {recent.map((t, i) => <TrackCard key={t.url} track={t} list={recent} index={i} />)}
        </Shelf>
      )}
      {top.length > 0 && (
        <Shelf title="Vos titres les plus écoutés">
          {top.map((t, i) => <TrackCard key={t.url} track={t} list={top} index={i} />)}
        </Shelf>
      )}
      {playlists.length > 0 && (
        <Shelf title="Vos playlists" action={<button className="link muted" onClick={() => navigate({ name: 'library' })}>Bibliothèque</button>}>
          {playlists.slice(0, 12).map((p) => (
            <PlaylistCard key={p.id} name={p.name} sub={`${p.tracks.length} titres`} covers={p.cover ? [p.cover] : p.tracks.map((t) => t.thumbnail)} onOpen={() => navigate({ name: 'playlist', id: p.id })} onPlay={() => playList(p.tracks)} />
          ))}
        </Shelf>
      )}

      <section className="shelf">
        <div className="shelf-head"><h2>Explorer</h2></div>
        <GenreGrid />
      </section>
    </div>
  );
}
