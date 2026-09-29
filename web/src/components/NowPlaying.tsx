import { ChevronDown, Heart, ListMusic, Mic2, MonitorPlay, MoreHorizontal, Disc3 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useCurrentTrack } from '../store/player';
import { useUi, useSettings } from '../store/ui';
import { useIsLiked, useLibrary } from '../store/library';
import { Cover } from './Cover';
import { SeekBar } from './Seek';
import { TransportControls, VolumeControl } from './PlayerBar';
import { LyricsView, QueuePanel, VideoView } from './Panels';
import { Visualizer } from './Visualizer';
import { SourceBadge } from './SourceBadge';

type Side = 'lyrics' | 'queue' | 'video' | 'cover';

export function NowPlaying() {
  const open = useUi((s) => s.nowPlaying);
  const setOpen = useUi((s) => s.setNowPlaying);
  const openMenu = useUi((s) => s.openMenu);
  const navigate = useUi((s) => s.navigate);
  const track = useCurrentTrack();
  const liked = useIsLiked(track?.url);
  const toggleLike = useLibrary((s) => s.toggleLike);
  const visualizer = useSettings((s) => s.visualizer);
  const [side, setSide] = useState<Side>('lyrics');

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open || !track) return null;
  const tab = (s: Side, icon: React.ReactNode, label: string) => (
    <button className={`chip ${side === s ? 'active' : ''}`} onClick={() => { if (s === 'video') useUi.getState().setMiniVideo(false); setSide(s); }}>{icon} {label}</button>
  );

  return (
    <div className="now-playing" role="dialog" aria-label="Lecture en cours">
      <div className="np-bg" style={{ backgroundImage: track.thumbnail ? `url("${track.thumbnail}")` : undefined }} />
      <div className="np-head">
        <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Réduire"><ChevronDown size={28} /></button>
        <div className="np-head-title">
          <span className="muted small">EN LECTURE</span>
          <SourceBadge source={track.source} />
        </div>
        <button className="icon-btn" onClick={(e) => openMenu({ x: e.clientX, y: e.clientY, track })} aria-label="Plus d'options"><MoreHorizontal size={24} /></button>
      </div>
      <div className={`np-body ${side === 'video' ? 'with-video' : ''}`}>
        <div className="np-left">
          {side === 'video' ? <VideoView variant="np" /> : <Cover src={track.thumbnail} size="min(56vh, 100%)" large radius={14} className="np-cover" />}
          <div className="np-meta">
            <div className="grow" style={{ minWidth: 0 }}>
              <h1 className="np-title">{track.title}</h1>
              {track.author && <button className="link np-artist" onClick={() => navigate({ name: 'artist', q: track.author! })}>{track.author}</button>}
            </div>
            <button className={`icon-btn tr-like ${liked ? 'liked' : ''}`} onClick={() => toggleLike(track)} aria-label="J'aime"><Heart size={26} fill={liked ? 'currentColor' : 'none'} /></button>
          </div>
          <SeekBar />
          <div className="np-controls">
            <TransportControls size={64} />
          </div>
          <div className="np-bottom">
            <VolumeControl />
            {visualizer && <Visualizer bars={40} className="np-viz" />}
          </div>
        </div>
        <div className="np-right">
          <div className="chips">
            {tab('lyrics', <Mic2 size={14} />, 'Paroles')}
            {tab('queue', <ListMusic size={14} />, 'File')}
            {tab('video', <MonitorPlay size={14} />, 'Vidéo')}
            {tab('cover', <Disc3 size={14} />, 'Pochette')}
          </div>
          <div className="np-side">
            {side === 'lyrics' && <LyricsView big />}
            {side === 'queue' && <QueuePanel />}
            {side === 'video' && <div className="empty muted">La vidéo est affichée à gauche, synchronisée avec le son.</div>}
            {side === 'cover' && <div className="np-vinyl"><Cover src={track.thumbnail} size="100%" large radius={999} className="spin-slow" /></div>}
          </div>
        </div>
      </div>
    </div>
  );
}
