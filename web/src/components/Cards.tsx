import { Play } from 'lucide-react';
import type { Track } from '../lib/types';
import { usePlayer } from '../store/player';
import { useUi } from '../store/ui';
import { Cover, Mosaic } from './Cover';

export const GENRES: { label: string; q: string; color: string }[] = [
  { label: 'Hits du moment', q: 'top hits 2026', color: '#e8115b' },
  { label: 'Rap français', q: 'rap français 2026', color: '#8d67ab' },
  { label: 'Lo-fi & chill', q: 'lofi hip hop chill beats', color: '#477d95' },
  { label: 'Électro / House', q: 'house music mix', color: '#0d73ec' },
  { label: 'Rock', q: 'rock classics', color: '#e91429' },
  { label: 'Pop', q: 'pop hits', color: '#148a08' },
  { label: 'Jazz', q: 'jazz classics', color: '#bc5900' },
  { label: 'Classique', q: 'classical music masterpieces', color: '#7d4b32' },
  { label: 'Synthwave', q: 'synthwave retrowave', color: '#dc148c' },
  { label: 'Metal', q: 'metal hits', color: '#1e3264' },
  { label: 'Afro', q: 'afrobeats hits', color: '#27856a' },
  { label: 'K-pop', q: 'kpop hits', color: '#a56752' },
  { label: 'Reggae', q: 'reggae classics', color: '#608108' },
  { label: 'Variété française', q: 'chanson française variété', color: '#b02897' },
  { label: 'Musiques de films', q: 'film soundtrack orchestral', color: '#503750' },
  { label: 'Focus / Étude', q: 'deep focus music study', color: '#2d46b9' },
];

export function GenreGrid() {
  const navigate = useUi((s) => s.navigate);
  return (
    <div className="genre-grid">
      {GENRES.map((g) => (
        <button key={g.q} className="genre-card" style={{ background: g.color }} onClick={() => navigate({ name: 'search', q: g.q })}>
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
