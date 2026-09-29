import { X, Trash2, Loader2, Maximize, Radio, GripVertical } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { usePlayer, useCurrentTrack } from '../store/player';
import { useUi } from '../store/ui';
import { api } from '../lib/api';
import { engine } from '../audio/engine';
import type { LyricsResult, Track } from '../lib/types';
import { formatTime, formatTotal } from '../lib/format';
import { Cover } from './Cover';
import { PlayingBars } from './TrackList';

function QueueItem({ track, index, current, onDrag }: { track: Track; index: number; current: boolean; onDrag: { start: (i: number) => void; over: (i: number) => void; drop: () => void; isOver: boolean } }) {
  const jumpTo = usePlayer((s) => s.jumpTo);
  const removeAt = usePlayer((s) => s.removeAt);
  const playing = usePlayer((s) => s.playing);
  const openMenu = useUi((s) => s.openMenu);
  return (
    <div
      className={`queue-item ${current ? 'current' : ''} ${onDrag.isOver ? 'drag-over' : ''}`}
      draggable={!current}
      onDragStart={() => onDrag.start(index)}
      onDragOver={(e) => { e.preventDefault(); onDrag.over(index); }}
      onDrop={(e) => { e.preventDefault(); onDrag.drop(); }}
      onDoubleClick={() => jumpTo(index)}
      onContextMenu={(e) => { e.preventDefault(); openMenu({ x: e.clientX, y: e.clientY, track, queueIndex: current ? undefined : index }); }}
    >
      {!current && <GripVertical size={14} className="grip" />}
      <button className="queue-cover" onClick={() => jumpTo(index)} aria-label={`Lire ${track.title}`}>
        <Cover src={track.thumbnail} size={40} radius={4} />
        {current && playing && <span className="cover-overlay"><PlayingBars /></span>}
      </button>
      <div className="grow ellipsis-wrap" onClick={() => jumpTo(index)}>
        <div className="ellipsis q-title">{track.title}</div>
        <div className="ellipsis muted small">{track.author}</div>
      </div>
      <span className="muted small">{formatTime(track.duration)}</span>
      {!current && <button className="icon-btn hover-only" onClick={() => removeAt(index)} aria-label="Retirer"><X size={16} /></button>}
    </div>
  );
}

export function QueuePanel() {
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const move = usePlayer((s) => s.move);
  const clearUpcoming = usePlayer((s) => s.clearUpcoming);
  const radioLoading = usePlayer((s) => s.radioLoading);
  const startRadio = usePlayer((s) => s.startRadio);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const upcoming = queue.slice(index + 1);
  const remaining = upcoming.reduce((a, t) => a + (t.duration || 0), 0);
  const handlers = (i: number) => ({
    start: (from: number) => setDrag({ from, over: from }),
    over: (over: number) => setDrag((d) => (d ? { ...d, over } : d)),
    drop: () => { if (drag && drag.over > index) move(drag.from, drag.over); setDrag(null); },
    isOver: !!drag && drag.over === i && drag.from !== i,
  });

  return (
    <div className="panel-body" onDragEnd={() => setDrag(null)}>
      {queue[index] && (
        <>
          <div className="panel-label">En cours de lecture</div>
          <QueueItem track={queue[index]} index={index} current onDrag={handlers(index)} />
        </>
      )}
      <div className="panel-label row">
        <span className="grow">À suivre · {upcoming.length} titres{remaining ? ` · ${formatTotal(remaining)}` : ''}</span>
        {upcoming.length > 0 && <button className="btn btn-ghost btn-sm" onClick={clearUpcoming}><Trash2 size={14} /> Vider</button>}
      </div>
      {upcoming.map((t, i) => <QueueItem key={`${t.url}-${index + 1 + i}`} track={t} index={index + 1 + i} current={false} onDrag={handlers(index + 1 + i)} />)}
      {!upcoming.length && (
        <div className="empty small">
          La file est vide.
          {queue[index] && (
            <button className="btn btn-ghost" disabled={radioLoading} onClick={() => startRadio(queue[index])}>
              {radioLoading ? <Loader2 size={16} className="spin" /> : <Radio size={16} />} Lancer la radio
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function LyricsView({ big = false }: { big?: boolean }) {
  const track = useCurrentTrack();
  const position = usePlayer((s) => s.position);
  const seek = usePlayer((s) => s.seek);
  const [state, setState] = useState<{ url: string; loading: boolean; data: LyricsResult | null }>({ url: '', loading: false, data: null });
  const box = useRef<HTMLDivElement>(null);
  const userScroll = useRef(0);

  useEffect(() => {
    if (!track || track.source === 'local') return;
    const ctrl = new AbortController();
    setState({ url: track.url, loading: true, data: null });
    api.lyrics(track, ctrl.signal)
      .then((data) => setState({ url: track.url, loading: false, data }))
      .catch(() => { if (!ctrl.signal.aborted) setState({ url: track.url, loading: false, data: { found: false } }); });
    return () => ctrl.abort();
  }, [track?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  const synced = state.data?.synced;
  let active = -1;
  if (synced) for (let i = 0; i < synced.length; i += 1) { if (synced[i].time <= position + 0.2) active = i; else break; }

  useEffect(() => {
    if (active < 0 || Date.now() - userScroll.current < 4000) return;
    box.current?.querySelector(`[data-line="${active}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [active]);

  if (!track) return <div className="empty">Aucun titre en cours</div>;
  if (state.loading) return <div className="empty"><Loader2 className="spin" /> Recherche des paroles…</div>;
  const d = state.data;
  if (!d?.found) return <div className="empty">Paroles introuvables pour ce titre.<span className="muted small">Source : LRCLIB</span></div>;
  if (d.instrumental) return <div className="empty">♪ Morceau instrumental ♪</div>;

  return (
    <div className={`lyrics ${big ? 'big' : ''}`} ref={box} onWheel={() => { userScroll.current = Date.now(); }} onTouchMove={() => { userScroll.current = Date.now(); }}>
      {synced ? synced.map((l, i) => (
        <p key={i} data-line={i} className={`lyric ${i === active ? 'active' : i < active ? 'past' : ''}`} onClick={() => seek(l.time)}>{l.text || '♪'}</p>
      )) : <pre className="lyrics-plain">{d.plain}</pre>}
      <p className="muted small lyrics-credit">Paroles : LRCLIB{d.artist ? ` · ${d.artist} — ${d.title}` : ''}</p>
    </div>
  );
}

/** Muted video kept in sync with the audio engine (audio never stops when toggling video). */
export function VideoView() {
  const track = useCurrentTrack();
  const playing = usePlayer((s) => s.playing);
  const rate = usePlayer((s) => s.rate);
  const ref = useRef<HTMLVideoElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const meta = useRef<{ seekable: boolean; offset: number }>({ seekable: true, offset: 0 });

  useEffect(() => {
    const v = ref.current;
    if (!v || !track || track.source === 'local') return;
    const ctrl = new AbortController();
    setStatus('loading');
    api.playback(track.url, 'video', ctrl.signal).then((pb) => {
      const start = Math.floor(engine.currentTime);
      meta.current = { seekable: pb.seekable, offset: pb.seekable || pb.isLive ? 0 : start };
      v.src = pb.seekable || pb.isLive ? pb.src : `${pb.src}&start=${start}`;
      v.addEventListener('loadedmetadata', () => { if (pb.seekable) v.currentTime = engine.currentTime; setStatus('ready'); }, { once: true });
    }).catch(() => { if (!ctrl.signal.aborted) setStatus('error'); });
    return () => { ctrl.abort(); v.removeAttribute('src'); v.load(); };
  }, [track?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const v = ref.current;
    if (!v || status !== 'ready') return;
    v.playbackRate = rate;
    if (playing) v.play().catch(() => {}); else v.pause();
    const t = setInterval(() => {
      const target = engine.currentTime - meta.current.offset;
      const drift = v.currentTime - target;
      if (Math.abs(drift) > 0.35 && target >= 0) {
        if (meta.current.seekable) v.currentTime = target;
      }
    }, 700);
    return () => clearInterval(t);
  }, [playing, rate, status]);

  if (!track) return <div className="empty">Aucun titre en cours</div>;
  return (
    <div className="video-wrap" ref={wrap}>
      <video ref={ref} muted playsInline className="video" onClick={() => usePlayer.getState().togglePlay()} poster={track.thumbnail || undefined} />
      {status === 'loading' && <div className="video-status"><Loader2 className="spin" /> Chargement de la vidéo…</div>}
      {status === 'error' && <div className="video-status">Vidéo indisponible pour ce titre</div>}
      <button className="icon-btn video-fs" onClick={() => wrap.current?.requestFullscreen?.()} aria-label="Plein écran"><Maximize size={18} /></button>
    </div>
  );
}

export function RightPanel() {
  const panel = useUi((s) => s.panel);
  const setPanel = useUi((s) => s.setPanel);
  if (!panel) return null;
  const titles = { queue: "File d'attente", lyrics: 'Paroles', video: 'Vidéo' };
  return (
    <aside className={`right-panel panel-${panel}`}>
      <div className="panel-head">
        <h3>{titles[panel]}</h3>
        <button className="icon-btn" onClick={() => setPanel(null)} aria-label="Fermer le panneau"><X size={18} /></button>
      </div>
      {panel === 'queue' && <QueuePanel />}
      {panel === 'lyrics' && <div className="panel-body"><LyricsView /></div>}
      {panel === 'video' && <div className="panel-body"><VideoView /></div>}
    </aside>
  );
}
