import { Play } from 'lucide-react';
import type { Track } from '../lib/types';
import { usePlayer } from '../store/player';
import { useUi } from '../store/ui';
import { Cover, Mosaic } from './Cover';

/**
 * Home genre cards. `q` = community search (YouTube mixes), `dz` = Deezer genre id (its chart of
 * playlists) and `pq` = keywords for Deezer's editorial playlists (official, by Deezer's curators).
 */
export const GENRES: { label: string; q: string; color: string; dz?: number; pq: string[] }[] = [
  { label: 'Hits du moment', q: 'top hits 2026', color: '#e8115b', dz: 0, pq: ['hits', 'top france'] },
  { label: 'Rap français', q: 'rap français 2026', color: '#8d67ab', dz: 116, pq: ['rap français', 'rap fr'] },
  { label: 'Rap US', q: 'us rap hits 2026', color: '#5f4b8b', pq: ['rap us', 'hip hop'] },
  { label: 'R&B', q: 'rnb hits', color: '#ba5d07', dz: 165, pq: ['r&b', 'rnb'] },
  { label: 'Pop', q: 'pop hits', color: '#148a08', dz: 132, pq: ['pop'] },
  { label: 'Électro / House', q: 'house music mix', color: '#0d73ec', dz: 106, pq: ['electro', 'house'] },
  { label: 'Dance', q: 'dance hits', color: '#1e3264', dz: 113, pq: ['dance'] },
  { label: 'Rock', q: 'rock classics', color: '#e91429', dz: 152, pq: ['rock'] },
  { label: 'Alternative / Indé', q: 'indie alternative hits', color: '#777777', dz: 85, pq: ['indie', 'alternative'] },
  { label: 'Metal', q: 'metal hits', color: '#1e3264', dz: 464, pq: ['metal'] },
  { label: 'Variété française', q: 'chanson française variété', color: '#b02897', dz: 52, pq: ['chanson française', 'variété'] },
  { label: 'Afro', q: 'afrobeats hits', color: '#27856a', dz: 2, pq: ['afro'] },
  { label: 'Latino', q: 'reggaeton latino hits', color: '#e1118c', dz: 197, pq: ['latino', 'reggaeton'] },
  { label: 'Reggae', q: 'reggae classics', color: '#608108', dz: 144, pq: ['reggae'] },
  { label: 'Soul & Funk', q: 'soul funk classics', color: '#af2896', dz: 169, pq: ['soul', 'funk'] },
  { label: 'Jazz', q: 'jazz classics', color: '#bc5900', dz: 129, pq: ['jazz'] },
  { label: 'Blues', q: 'blues classics', color: '#2d46b9', dz: 153, pq: ['blues'] },
  { label: 'Country / Folk', q: 'country folk hits', color: '#8c1932', dz: 84, pq: ['country', 'folk'] },
  { label: 'Classique', q: 'classical music masterpieces', color: '#7d4b32', dz: 98, pq: ['classique'] },
  { label: 'Musiques de films', q: 'film soundtrack orchestral', color: '#503750', dz: 173, pq: ['bandes originales', 'jeux vidéo'] },
  { label: 'K-pop / Asie', q: 'kpop hits', color: '#a56752', dz: 16, pq: ['k-pop'] },
  { label: 'Musique arabe', q: 'arabic music hits', color: '#006450', dz: 12, pq: ['raï', 'arabe'] },
  { label: 'Brésil', q: 'musica brasileira hits', color: '#148a08', dz: 75, pq: ['brasil'] },
  { label: 'Synthwave', q: 'synthwave retrowave', color: '#dc148c', pq: ['synthwave', 'années 80'] },
  { label: 'Lo-fi & chill', q: 'lofi hip hop chill beats', color: '#477d95', pq: ['lofi', 'chill'] },
  { label: 'Focus / Étude', q: 'deep focus music study', color: '#2d46b9', pq: ['focus', 'concentration'] },
  { label: 'Sport', q: 'workout motivation music', color: '#e8115b', pq: ['sport', 'workout'] },
  { label: 'Soirée', q: 'party hits mix', color: '#dc148c', pq: ['soirée', 'party'] },
  { label: 'Sommeil', q: 'sleep music relaxing', color: '#1e3264', pq: ['sommeil', 'relaxation'] },
  { label: 'Enfants', q: 'comptines chansons enfants', color: '#ff4632', dz: 95, pq: ['enfants', 'comptines'] },
];

export function GenreGrid() {
  const navigate = useUi((s) => s.navigate);
  return (
    <div className="genre-grid">
      {GENRES.map((g) => (
        <button key={g.q} className="genre-card" style={{ background: g.color }} onClick={() => navigate({ name: 'genre', id: g.label })}>
          <span>{g.label}</span>
        </button>
      ))}
    </div>
  );
}

export function TrackCard({ track, list, index }: { track: Track; list: Track[]; index: number }) {
  const playList = usePlayer((s) => s.playList);
  const openMenu = useUi((s) => s.openMenu);
  return (
    <div className="card" onClick={() => playList(list, index)} onContextMenu={(e) => { e.preventDefault(); openMenu({ x: e.clientX, y: e.clientY, track }); }}>
      <div className="card-cover">
        <Cover src={track.thumbnail} size="100%" radius={8} />
        <button className="card-play" aria-label={`Lire ${track.title}`} onClick={(e) => { e.stopPropagation(); playList(list, index); }}><Play size={20} fill="currentColor" /></button>
      </div>
      <div className="card-title ellipsis" title={track.title}>{track.title}</div>
      <div className="card-sub ellipsis">{track.author}</div>
    </div>
  );
}

export function PlaylistCard({ name, sub, covers, onOpen, onPlay }: { name: string; sub: string; covers: (string | null)[]; onOpen: () => void; onPlay: () => void }) {
  return (
    <div className="card" onClick={onOpen}>
      <div className="card-cover">
        <Mosaic covers={covers} size="100%" radius={8} />
        <button className="card-play" aria-label={`Lire ${name}`} onClick={(e) => { e.stopPropagation(); onPlay(); }}><Play size={20} fill="currentColor" /></button>
      </div>
      <div className="card-title ellipsis" title={name}>{name}</div>
      <div className="card-sub ellipsis">{sub}</div>
    </div>
  );
}

export function Shelf({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="shelf">
      <div className="shelf-head"><h2>{title}</h2>{action}</div>
      <div className="shelf-row">{children}</div>
    </section>
  );
}
