import { FriendsPanel } from './Friends';
import { X, Trash2, Loader2, Languages, MicVocal, MicOff, Maximize, Minimize, Maximize2, Radio, GripVertical, GripHorizontal, PictureInPicture2, AppWindow } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { usePlayer, useCurrentTrack } from '../store/player';
import { useUi, useSettings } from '../store/ui';
import { MediaSwitch, centerInScroller } from './ClipLyrics';
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

/** Target languages of « Paroles traduites » (server/src/translate.js LANGS). */
const LYRICS_LANGS: [string, string][] = [
  ['fr', 'Français'], ['en', 'Anglais'], ['es', 'Espagnol'], ['de', 'Allemand'], ['it', 'Italien'], ['pt', 'Portugais'], ['nl', 'Néerlandais'],
  ['pl', 'Polonais'], ['tr', 'Turc'], ['ru', 'Russe'], ['ar', 'Arabe'], ['ja', 'Japonais'], ['ko', 'Coréen'], ['zh', 'Chinois'],
];

export function LyricsView({ big = false }: { big?: boolean }) {
  const track = useCurrentTrack();
  const position = usePlayer((s) => s.position);
  const seek = usePlayer((s) => s.seek);
  const { lyricsTranslate, lyricsLang, karaoke, vocalCut, set } = useSettings();
  const [state, setState] = useState<{ url: string; loading: boolean; data: LyricsResult | null }>({ url: '', loading: false, data: null });
  const [tr, setTr] = useState<{ key: string; loading: boolean; lines: string[] | null; note: string }>({ key: '', loading: false, lines: null, note: '' });
  const box = useRef<HTMLDivElement>(null);
  const userScroll = useRef(0);

  useEffect(() => {
    if (!track || track.source === 'local' || track.source === 'radio') return;
    const ctrl = new AbortController();
    setState({ url: track.url, loading: true, data: null });
    api.lyrics(track, ctrl.signal)
      .then((data) => setState({ url: track.url, loading: false, data }))
      .catch(() => { if (!ctrl.signal.aborted) setState({ url: track.url, loading: false, data: { found: false } }); });
    return () => ctrl.abort();
  }, [track?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  const d = state.data;
  const synced = d?.synced;
  const source = d?.found && !d.instrumental ? (synced ? synced.map((l) => l.text) : (d.plain || '').split(/\r?\n/)) : null;
  const trKey = lyricsTranslate && source ? `${state.url}|${lyricsLang}` : '';

  useEffect(() => {
    if (!trKey || !source) return;
    let live = true;
    setTr({ key: trKey, loading: true, lines: null, note: '' });
    api.translateLyrics(source, lyricsLang)
      .then((r) => { if (live) setTr({ key: trKey, loading: false, lines: r.same ? null : r.lines, note: r.same ? 'Paroles déjà dans cette langue.' : '' }); })
      .catch((e: Error) => { if (live) setTr({ key: trKey, loading: false, lines: null, note: e.message || 'Traduction indisponible.' }); });
    return () => { live = false; };
  }, [trKey]); // eslint-disable-line react-hooks/exhaustive-deps

  let active = -1;
  if (synced) for (let i = 0; i < synced.length; i += 1) { if (synced[i].time <= position + 0.2) active = i; else break; }
  const kara = karaoke && !!synced;

  useEffect(() => {
    if (active < 0 || Date.now() - userScroll.current < 4000) return;
    const line = box.current?.querySelector<HTMLElement>(`[data-line="${active}"]`);
    if (line) centerInScroller(line);
  }, [active]);

  // Karaoke: the current line fills as it is sung (LRC gives line times only: progress inside the line).
  useEffect(() => {
    if (!kara || active < 0 || !synced) return;
    const el = box.current?.querySelector<HTMLElement>(`[data-line="${active}"] .lyric-text`);
    if (!el) return;
    const start = synced[active].time;
    const span = Math.max(0.5, (synced[active + 1]?.time ?? start + 5) - start - 0.3);
    let raf = 0;
    const tick = () => {
      el.style.setProperty('--p', `${Math.min(100, Math.max(0, ((engine.currentTime + 0.2 - start) / span) * 100))}%`);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => { cancelAnimationFrame(raf); el.style.removeProperty('--p'); };
  }, [kara, active, synced]);

  if (!track) return <div className="empty">Aucun titre en cours</div>;
  if (track.source === 'radio') return <div className="empty">Pas de paroles pour une radio en direct.</div>;
  if (state.loading) return <div className="empty"><Loader2 className="spin" /> Recherche des paroles…</div>;
  if (!d?.found) return <div className="empty">Paroles introuvables pour ce titre.<span className="muted small">Source : LRCLIB</span></div>;
  if (d.instrumental) return <div className="empty">♪ Morceau instrumental ♪</div>;

  const lines = tr.key === trKey ? tr.lines : null;
  const trOf = (i: number) => (lines?.[i] && lines[i] !== source?.[i] ? <span className="lyric-tr">{lines[i]}</span> : null);
  return (
    <div className={`lyrics ${big ? 'big' : ''} ${kara ? 'karaoke' : ''}`} ref={box} onWheel={() => { userScroll.current = Date.now(); }} onTouchMove={() => { userScroll.current = Date.now(); }}>
      <div className="lyrics-tools">
        <button className={`chip ${lyricsTranslate ? 'active' : ''}`} aria-pressed={lyricsTranslate} onClick={() => set({ lyricsTranslate: !lyricsTranslate })}><Languages size={13} /> Traduire</button>
        {lyricsTranslate && (
          <select className="chip" aria-label="Langue de traduction" value={lyricsLang} onChange={(e) => set({ lyricsLang: e.target.value })}>
            {LYRICS_LANGS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        )}
        {synced && <button className={`chip ${karaoke ? 'active' : ''}`} aria-pressed={karaoke} onClick={() => set({ karaoke: !karaoke })}><MicVocal size={13} /> Karaoké</button>}
        {kara && <button className={`chip ${vocalCut ? 'active' : ''}`} aria-pressed={vocalCut} title="Retire ce qui est au centre du mixage stéréo (approximatif). Le fondu enchaîné est suspendu tant qu’elle est active." onClick={() => set({ vocalCut: !vocalCut })}><MicOff size={13} /> Voix atténuée</button>}
      </div>
      {lyricsTranslate && (tr.loading || tr.note) && <p className="muted small lyrics-note">{tr.loading ? <><Loader2 size={12} className="spin" /> Traduction…</> : tr.note}</p>}
      {synced ? synced.map((l, i) => (
        <p key={i} data-line={i} className={`lyric ${i === active ? 'active' : i < active ? 'past' : ''}`} onClick={() => seek(l.time)}><span className="lyric-text">{l.text || '♪'}</span>{trOf(i)}</p>
      )) : lines ? source!.map((l, i) => (
        <p key={i} className="lyric-plain-line">{l || '\u00a0'}{trOf(i)}</p>
      )) : <pre className="lyrics-plain">{d.plain}</pre>}
      <p className="muted small lyrics-credit">Paroles : LRCLIB{d.artist ? ` · ${d.artist} — ${d.title}` : ''}{lines ? ' · traduction automatique' : ''}</p>
    </div>
  );
}

type FsDocument = Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => void };
type IosVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

function fullscreenElement() {
  const d = document as FsDocument;
  return d.fullscreenElement || d.webkitFullscreenElement || null;
}

/** Muted video kept in sync with the audio engine (audio never stops when toggling video). */
export function VideoView({ variant = 'panel' }: { variant?: 'panel' | 'mini' | 'np' }) {
  const track = useCurrentTrack();
  const playing = usePlayer((s) => s.playing);
  const rate = usePlayer((s) => s.rate);
  const setMiniVideo = useUi((s) => s.setMiniVideo);
  const ref = useRef<HTMLVideoElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [isFs, setIsFs] = useState(false);
  const [isPip, setIsPip] = useState(false);
  const meta = useRef<{ seekable: boolean; offset: number }>({ seekable: true, offset: 0 });

  useEffect(() => {
    const v = ref.current;
    if (!v || !track || track.source === 'local' || track.source === 'radio') return;
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

  // Track fullscreen / picture-in-picture state so the buttons always do the right thing.
  useEffect(() => {
    const onFs = () => setIsFs(fullscreenElement() === wrap.current);
    const v = ref.current;
    const onPipIn = () => setIsPip(true);
    const onPipOut = () => setIsPip(false);
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
    v?.addEventListener('enterpictureinpicture', onPipIn);
    v?.addEventListener('leavepictureinpicture', onPipOut);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('webkitfullscreenchange', onFs);
      v?.removeEventListener('enterpictureinpicture', onPipIn);
      v?.removeEventListener('leavepictureinpicture', onPipOut);
      if (document.pictureInPictureElement === v) document.exitPictureInPicture().catch(() => {});
    };
  }, []);

  const toggleFullscreen = () => {
    const d = document as FsDocument;
    if (fullscreenElement()) {
      (d.exitFullscreen ? d.exitFullscreen() : Promise.resolve(d.webkitExitFullscreen?.())).catch(() => {});
      return;
    }
    const el = wrap.current as FsElement | null;
    if (el?.requestFullscreen) el.requestFullscreen().catch(() => {});
    else if (el?.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else (ref.current as IosVideo | null)?.webkitEnterFullscreen?.(); // iPhone: only the video itself can go fullscreen
  };

  const togglePip = async () => {
    const v = ref.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      useUi.getState().toast("L'image dans l'image n'est pas disponible dans ce navigateur", 'error');
    }
  };

  const toMini = () => {
    if (fullscreenElement()) (document as FsDocument).exitFullscreen?.().catch(() => {});
    setMiniVideo(true);
  };

  if (!track) return <div className="empty">Aucun titre en cours</div>;
  if (track.source === 'radio') return <div className="empty">Pas de vidéo pour une radio en direct.</div>;
  const pipSupported = typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled;
  return (
    <div className={`video-wrap video-${variant} ${isFs ? 'is-fs' : ''}`} ref={wrap} onDoubleClick={toggleFullscreen}>
      <video ref={ref} muted playsInline className="video" onClick={() => usePlayer.getState().togglePlay()} poster={track.thumbnail || undefined} />
      {status === 'loading' && <div className="video-status"><Loader2 className="spin" /> Chargement de la vidéo…</div>}
      {status === 'error' && <div className="video-status">Vidéo indisponible pour ce titre</div>}
      {isPip && <div className="video-status">Lecture en image dans l'image</div>}
      <div className="video-tools" onDoubleClick={(e) => e.stopPropagation()}>
        {isFs && <span className="video-fs-title ellipsis">{track.title}</span>}
        {variant !== 'mini' && (
          <button className="icon-btn" onClick={toMini} title="Lecteur réduit" aria-label="Lecteur réduit"><PictureInPicture2 size={18} /></button>
        )}
        {pipSupported && (
          <button className={`icon-btn ${isPip ? 'on' : ''}`} onClick={togglePip} title="Image dans l'image (par-dessus les autres fenêtres)" aria-label="Image dans l'image"><AppWindow size={18} /></button>
        )}
        <button className="icon-btn" onClick={toggleFullscreen} title={isFs ? 'Quitter le plein écran (Échap)' : 'Plein écran'} aria-label={isFs ? 'Quitter le plein écran' : 'Plein écran'}>
          {isFs ? <Minimize size={18} /> : <Maximize size={18} />}
        </button>
      </div>
    </div>
  );
}

/** Floating, draggable video that stays on screen while browsing the app. */
export function MiniVideo() {
  const open = useUi((s) => s.miniVideo);
  const setMiniVideo = useUi((s) => s.setMiniVideo);
  const setPanel = useUi((s) => s.setPanel);
  const hasTrack = usePlayer((s) => !!s.queue[s.index]);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  if (!open || !hasTrack) return null;
  const onDown = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current || !box.current) return;
    const w = box.current.offsetWidth;
    const h = box.current.offsetHeight;
    setPos({
      x: Math.max(4, Math.min(window.innerWidth - w - 4, e.clientX - drag.current.dx)),
      y: Math.max(4, Math.min(window.innerHeight - h - 4, e.clientY - drag.current.dy)),
    });
  };
  return (
    <div className="mini-video" ref={box} style={pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined}>
      <div className="mini-head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }}>
        <GripHorizontal size={16} className="muted" />
        <span className="grow" />
        <button className="icon-btn" onPointerDown={(e) => e.stopPropagation()} onClick={() => { setMiniVideo(false); setPanel('video'); }} title="Agrandir dans le panneau" aria-label="Agrandir"><Maximize2 size={15} /></button>
        <button className="icon-btn" onPointerDown={(e) => e.stopPropagation()} onClick={() => setMiniVideo(false)} title="Fermer la vidéo (la musique continue)" aria-label="Fermer la vidéo"><X size={16} /></button>
      </div>
      <VideoView variant="mini" />
    </div>
  );
}

export function RightPanel() {
  const panel = useUi((s) => s.panel);
  const setPanel = useUi((s) => s.setPanel);
  const both = useSettings((s) => s.clipLyrics);
  if (!panel) return null;
  const titles = { queue: "File d'attente", lyrics: 'Paroles', video: both ? 'Clip et paroles' : 'Vidéo', friends: 'Activité des amis' };
  return (
    <aside className={`right-panel panel-${panel}`}>
      <div className="panel-head">
        <h3>{titles[panel]}</h3>
        <button className="icon-btn" onClick={() => setPanel(null)} aria-label="Fermer le panneau"><X size={18} /></button>
      </div>
      {(panel === 'video' || panel === 'lyrics') && <MediaSwitch />}
      {panel === 'queue' && <QueuePanel />}
      {panel === 'lyrics' && <div className="panel-body"><LyricsView /></div>}
      {panel === 'video' && (
        <div className={`panel-body ${both ? 'clip-lyrics' : ''}`}>
          <VideoView />
          {both && <div className="clip-lyrics-text"><LyricsView /></div>}
        </div>
      )}
      {panel === 'friends' && <FriendsPanel />}
    </aside>
  );
}
