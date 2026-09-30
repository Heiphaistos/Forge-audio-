import { Heart, MoreHorizontal, Play, GripVertical, Radio, Check, ListChecks } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { useSelection } from '../store/selection';
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
  /** Selection mode of this list: clicking a row picks it instead of playing. */
  selecting?: boolean;
  picked?: boolean;
  onPick?: (i: number, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; long?: boolean }) => void;
  dragHandlers?: {
    onDragStart: (i: number) => void;
    onDragOver: (i: number) => void;
    onDrop: () => void;
    over: boolean;
  };
}

export const TrackRow = memo(function TrackRow({ track, index, onPlay, playlistId, showViews, dragHandlers, selecting, picked, onPick }: RowProps) {
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
  // Long press on touch screens starts the selection with this row.
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const touchStart = () => {
    longPressed.current = false;
    press.current = setTimeout(() => { longPressed.current = true; onPick?.(index, { shiftKey: false, ctrlKey: false, metaKey: false, long: true }); navigator.vibrate?.(20); }, 500);
  };
  const touchEnd = () => { if (press.current) clearTimeout(press.current); };
  const activate = (e: React.MouseEvent) => {
    if (longPressed.current) { longPressed.current = false; return; }
    if (onPick && (selecting || e.ctrlKey || e.metaKey || e.shiftKey)) { e.preventDefault(); onPick(index, e); return; }
    onPlay(index);
  };

  return (
    <div
      className={`track-row ${isCurrent ? 'current' : ''} ${dragHandlers?.over ? 'drag-over' : ''} ${selecting ? 'selecting' : ''} ${picked ? 'picked' : ''}`}
      onDoubleClick={() => { if (!selecting) onPlay(index); }}
      onTouchStart={onPick ? touchStart : undefined}
      onTouchEnd={onPick ? touchEnd : undefined}
      onTouchMove={onPick ? touchEnd : undefined}
      aria-selected={selecting ? !!picked : undefined}
      onContextMenu={menu}
      draggable={!!dragHandlers}
      onDragStart={dragHandlers ? () => dragHandlers.onDragStart(index) : undefined}
      onDragOver={dragHandlers ? (e) => { e.preventDefault(); dragHandlers.onDragOver(index); } : undefined}
      onDrop={dragHandlers ? (e) => { e.preventDefault(); dragHandlers.onDrop(); } : undefined}
    >
      <div className="tr-index">
        {dragHandlers && <GripVertical size={14} className="grip" />}
        {selecting ? (
          <button className={`tr-check ${picked ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); onPick?.(index, e); }} aria-label={picked ? `Désélectionner ${track.title}` : `Sélectionner ${track.title}`} aria-pressed={!!picked}>
            {picked && <Check size={14} />}
          </button>
        ) : (
          <>
            <span className="tr-num">{isCurrent && playing ? <PlayingBars /> : index + 1}</span>
            <button className="tr-play icon-btn" onClick={() => onPlay(index)} aria-label={`Lire ${track.title}`}><Play size={16} fill="currentColor" /></button>
          </>
        )}
      </div>
      <div className="tr-main" onClick={activate}>
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
  /** Identifies the list for multi-select (defaults to the playlist id). */
  listKey?: string;
}

export function TrackList({ tracks, onPlay, playlistId, onReorder, showViews, empty, listKey }: ListProps) {
  const playList = usePlayer((s) => s.playList);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const play = onPlay ?? ((i: number) => playList(tracks, i));
  const key = listKey || playlistId || 'list';
  const selecting = useSelection((s) => s.key === key);
  const picked = useSelection((s) => (s.key === key ? s.picked : null));
  // Keep the selection's view of this list current (filter, sort, live edits by other members).
  useEffect(() => { if (useSelection.getState().key === key) useSelection.getState().setAll(tracks); }, [tracks, key]);
  const onPick = (i: number, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; long?: boolean }) => {
    const sel = useSelection.getState();
    if (sel.key !== key) { sel.start(key, tracks, playlistId, i); return; }
    if (e.shiftKey) sel.range(i); else sel.toggle(i);
  };
  const pickedSet = new Set(picked || []);

  if (!tracks.length) return <div className="empty">{empty ?? 'Aucun titre'}</div>;

  return (
    <div className="track-list" onDragEnd={() => setDrag(null)}>
      <div className="track-head">
        <span>#</span><span>Titre</span><span className="tr-source">Source</span><span /><span className="tr-duration">Durée</span>
        <button className="icon-btn tr-select-all" onClick={() => (selecting ? useSelection.getState().clear() : useSelection.getState().start(key, tracks, playlistId))}
          title={selecting ? 'Terminer la sélection' : 'Sélectionner plusieurs titres (ou Ctrl/Maj + clic, appui long sur téléphone)'} aria-label={selecting ? 'Terminer la sélection' : 'Sélectionner'}>
          <ListChecks size={16} />
        </button>
      </div>
      {tracks.map((t, i) => (
        <TrackRow
          key={`${t.url}-${i}`}
          track={t}
          index={i}
          onPlay={play}
          playlistId={playlistId}
          showViews={showViews}
          selecting={selecting}
          picked={pickedSet.has(i)}
          onPick={onPick}
          dragHandlers={onReorder && !selecting ? {
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
