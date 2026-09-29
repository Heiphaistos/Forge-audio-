import { Heart, MoreHorizontal, Play, GripVertical, Radio } from 'lucide-react';
import { memo, useState } from 'react';
import type { Track } from '../lib/types';
import { formatTime, formatViews } from '../lib/format';
import { usePlayer } from '../store/player';
import { useIsLiked, useLibrary } from '../store/library';
import { useUi } from '../store/ui';
import { Cover } from './Cover';
import { SourceBadge } from './SourceBadge';

export function PlayingBars() {
  return <span className="playing-bars" aria-label="En lecture"><i /><i /><i /></span>;
}

interface RowProps {
  track: Track;
  index: number;
  onPlay: (i: number) => void;
  playlistId?: string;
  showViews?: boolean;
  dragHandlers?: {
    onDragStart: (i: number) => void;
    onDragOver: (i: number) => void;
    onDrop: () => void;
    over: boolean;
  };
}

export const TrackRow = memo(function TrackRow({ track, index, onPlay, playlistId, showViews, dragHandlers }: RowProps) {
  const isCurrent = usePlayer((s) => s.queue[s.index]?.url === track.url);
  const playing = usePlayer((s) => s.playing);
  const liked = useIsLiked(track.url);
  const toggleLike = useLibrary((s) => s.toggleLike);
  const openMenu = useUi((s) => s.openMenu);
  const navigate = useUi((s) => s.navigate);

  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu({ x: e.clientX, y: e.clientY, track, playlistId, index });
  };

  return (
    <div
      className={`track-row ${isCurrent ? 'current' : ''} ${dragHandlers?.over ? 'drag-over' : ''}`}
      onDoubleClick={() => onPlay(index)}
      onContextMenu={menu}
      draggable={!!dragHandlers}
      onDragStart={dragHandlers ? () => dragHandlers.onDragStart(index) : undefined}
      onDragOver={dragHandlers ? (e) => { e.preventDefault(); dragHandlers.onDragOver(index); } : undefined}
      onDrop={dragHandlers ? (e) => { e.preventDefault(); dragHandlers.onDrop(); } : undefined}
    >
      <div className="tr-index">
        {dragHandlers && <GripVertical size={14} className="grip" />}
        <span className="tr-num">{isCurrent && playing ? <PlayingBars /> : index + 1}</span>
        <button className="tr-play icon-btn" onClick={() => onPlay(index)} aria-label={`Lire ${track.title}`}><Play size={16} fill="currentColor" /></button>
      </div>
      <div className="tr-main" onClick={() => onPlay(index)}>
        <Cover src={track.thumbnail} size={44} />
        <div className="tr-text">
          <div className="tr-title" title={track.title}>{track.title}</div>
          <div className="tr-sub">
            {track.isLive && <span className="live-dot"><Radio size={11} /> DIRECT</span>}
            {track.author && (
              <button className="link" onClick={(e) => { e.stopPropagation(); navigate({ name: 'artist', q: track.author! }); }}>{track.author}</button>
            )}
            {showViews && track.views ? <span className="muted"> · {formatViews(track.views)}</span> : null}
          </div>
        </div>
      </div>
      <div className="tr-source"><SourceBadge source={track.source} /></div>
      <button className={`icon-btn tr-like ${liked ? 'liked' : ''}`} onClick={() => toggleLike(track)} aria-label={liked ? 'Retirer des titres likés' : 'Ajouter aux titres likés'}>
        <Heart size={16} fill={liked ? 'currentColor' : 'none'} />
      </button>
      <div className="tr-duration">{track.isLive ? '' : formatTime(track.duration)}</div>
      <button className="icon-btn tr-more" onClick={menu} aria-label="Plus d'options"><MoreHorizontal size={18} /></button>
    </div>
  );
});

interface ListProps {
  tracks: Track[];
  onPlay?: (i: number) => void;
  playlistId?: string;
  onReorder?: (from: number, to: number) => void;
  showViews?: boolean;
  empty?: React.ReactNode;
}

export function TrackList({ tracks, onPlay, playlistId, onReorder, showViews, empty }: ListProps) {
  const playList = usePlayer((s) => s.playList);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const play = onPlay ?? ((i: number) => playList(tracks, i));

  if (!tracks.length) return <div className="empty">{empty ?? 'Aucun titre'}</div>;

  return (
    <div className="track-list" onDragEnd={() => setDrag(null)}>
      <div className="track-head">
        <span>#</span><span>Titre</span><span className="tr-source">Source</span><span /><span className="tr-duration">Durée</span><span />
      </div>
      {tracks.map((t, i) => (
        <TrackRow
          key={`${t.url}-${i}`}
          track={t}
          index={i}
          onPlay={play}
          playlistId={playlistId}
          showViews={showViews}
          dragHandlers={onReorder ? {
            onDragStart: (from) => setDrag({ from, over: from }),
            onDragOver: (over) => setDrag((d) => (d ? { ...d, over } : d)),
            onDrop: () => { if (drag) onReorder(drag.from, drag.over); setDrag(null); },
            over: !!drag && drag.over === i && drag.from !== i,
          } : undefined}
        />
      ))}
    </div>
  );
}
