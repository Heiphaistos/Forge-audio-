import { ChevronDown, Heart, ListMusic, Users, Mic2, MonitorPlay, MoreHorizontal, Disc3, Rows2 } from 'lucide-react';
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
import { useShared } from '../store/social';
import { useMedia } from './ClipLyrics';

type Side = 'lyrics' | 'queue' | 'video' | 'both' | 'cover';

export function NowPlaying() {
  const open = useUi((s) => s.nowPlaying);
  const setOpen = useUi((s) => s.setNowPlaying);
  const openMenu = useUi((s) => s.openMenu);
  const navigate = useUi((s) => s.navigate);
  const track = useCurrentTrack();
  const liked = useIsLiked(track?.url);
  const toggleLike = useLibrary((s) => s.toggleLike);
  const visualizer = useSettings((s) => s.visualizer);
  const [side, setSide] = useState<Side>(() => (useSettings.getState().clipLyrics ? 'both' : 'lyrics'));
  // One column (phones, narrow windows): the lyrics go right under the clip, above the controls.
  const narrow = useMedia('(max-width: 1000px)');
  const clip = side === 'video' || side === 'both';

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open || !track) return null;
  const tab = (s: Side, icon: React.ReactNode, label: string) => (
    <button className={`chip ${side === s ? 'active' : ''}`} onClick={() => {
      if (s === 'video' || s === 'both') { useUi.getState().setMiniVideo(false); useSettings.getState().set({ clipLyrics: s === 'both' }); }
      setSide(s);
    }}>{icon} {label}</button>
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
      <div className={`np-body ${clip ? 'with-video' : ''}`}>
        <div className="np-left">
          {clip ? <VideoView variant="np" /> : <Cover src={track.thumbnail} size="min(56vh, 100%)" large radius={14} className="np-cover" />}
          {side === 'both' && narrow && <div className="np-cl-lyrics"><LyricsView big /></div>}
          <div className="np-meta">
            <div className="grow" style={{ minWidth: 0 }}>
              <h1 className="np-title">{track.title}</h1>
              {track.author && <button className="link np-artist" onClick={() => navigate({ name: 'artist', q: track.author! })}>{track.author}</button>}
            </div>
            <button className={`icon-btn tr-like ${liked ? 'liked' : ''}`} onClick={() => toggleLike(track)} aria-label="J'aime"><Heart size={26} fill={liked ? 'currentColor' : 'none'} /></button>
          </div>
          <InPlaylists url={track.url} onGo={() => setOpen(false)} />
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
            {tab('video', <MonitorPlay size={14} />, 'Clip')}
            {tab('both', <Rows2 size={14} />, 'Clip + paroles')}
            {tab('cover', <Disc3 size={14} />, 'Pochette')}
          </div>
          <div className="np-side">
            {side === 'lyrics' && <LyricsView big />}
            {side === 'queue' && <QueuePanel />}
            {side === 'video' && <div className="empty muted">{narrow ? 'Le clip est affiché en haut' : 'Le clip est affiché à gauche'}, synchronisé avec le son.</div>}
            {side === 'both' && (narrow ? <div className="empty muted">Les paroles défilent sous le clip.</div> : <LyricsView big />)}
            {side === 'cover' && <div className="np-vinyl"><Cover src={track.thumbnail} size="100%" large radius={999} className="spin-slow" /></div>}
          </div>
        </div>
      </div>
    </div>
  );
}

/** « Ce titre est dans » : the user's playlists (and shared ones) holding the current track, one tap to open them. */
function InPlaylists({ url, onGo }: { url: string; onGo: () => void }) {
  const playlists = useLibrary((s) => s.playlists);
  const shared = useShared((s) => s.list);
  const navigate = useUi((s) => s.navigate);
  const mine = playlists.filter((p) => p.tracks.some((t) => t.url === url));
  const theirs = shared.filter((p) => p.tracks.some((t) => t.url === url));
  if (!mine.length && !theirs.length) return null;
  const go = (v: { name: 'playlist' | 'shared'; id: string }) => { onGo(); navigate(v); };
  return (
    <div className="np-in">
      <span className="muted small">Ce titre est dans</span>
      {mine.map((p) => <button key={p.id} className="chip" onClick={() => go({ name: 'playlist', id: p.id })}><ListMusic size={13} /> {p.name}</button>)}
      {theirs.map((p) => <button key={`s-${p.id}`} className="chip" onClick={() => go({ name: 'shared', id: p.id })}><Users size={13} /> {p.name}</button>)}
    </div>
  );
}
