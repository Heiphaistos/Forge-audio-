import { Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Volume2, Volume1, VolumeX, ListMusic, Mic2, MonitorPlay, SlidersHorizontal, Maximize2, Heart, Loader2, Gauge, Moon, Radio } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { usePlayer, useCurrentTrack } from '../store/player';
import { useUi, useSettings } from '../store/ui';
import { useIsLiked, useLibrary } from '../store/library';
import { useJam } from '../store/social';
import { Cover } from './Cover';
import { SeekBar, Slider } from './Seek';
import { Visualizer } from './Visualizer';

export function PlayButton({ size = 40 }: { size?: number }) {
  const playing = usePlayer((s) => s.playing);
  const buffering = usePlayer((s) => s.buffering);
  const togglePlay = usePlayer((s) => s.togglePlay);
  const hasQueue = usePlayer((s) => s.queue.length > 0);
  const icon = size * 0.45;
  return (
    <button className="play-btn" style={{ width: size, height: size }} onClick={togglePlay} disabled={!hasQueue} aria-label={playing ? 'Pause' : 'Lecture'}>
      {buffering && playing ? <Loader2 size={icon} className="spin" /> : playing ? <Pause size={icon} fill="currentColor" /> : <Play size={icon} fill="currentColor" className="nudge" />}
    </button>
  );
}

export function TransportControls({ size = 40 }: { size?: number }) {
  const { shuffle, repeat, toggleShuffle, cycleRepeat, next, prev } = usePlayer();
  return (
    <div className="transport">
      <button className={`icon-btn ${shuffle ? 'on' : ''}`} onClick={toggleShuffle} aria-label="Lecture aléatoire" title="Lecture aléatoire (S)"><Shuffle size={18} /></button>
      <button className="icon-btn" onClick={prev} aria-label="Précédent" title="Précédent"><SkipBack size={20} fill="currentColor" /></button>
      <PlayButton size={size} />
      <button className="icon-btn" onClick={() => next(false)} aria-label="Suivant" title="Suivant"><SkipForward size={20} fill="currentColor" /></button>
      <button className={`icon-btn ${repeat !== 'off' ? 'on' : ''}`} onClick={cycleRepeat} aria-label="Répéter" title={repeat === 'one' ? 'Répéter le titre' : repeat === 'all' ? 'Répéter la file' : 'Répétition désactivée'}>
        {repeat === 'one' ? <Repeat1 size={18} /> : <Repeat size={18} />}
      </button>
    </div>
  );
}

const RATES = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2];
const SLEEP = [5, 15, 30, 45, 60, 90];

function MoreControls() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { rate, setRate, sleepAt, sleepAfterTrack, setSleep, startRadio, radioLoading } = usePlayer();
  const track = useCurrentTrack();
  const autoplay = useSettings((s) => s.autoplay);
  const setSettings = useSettings((s) => s.set);
  const [, force] = useState(0);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const t = setInterval(() => force((n) => n + 1), 1000);
    window.addEventListener('mousedown', close);
    return () => { window.removeEventListener('mousedown', close); clearInterval(t); };
  }, [open]);

  const remaining = sleepAt ? Math.max(0, Math.ceil((sleepAt - Date.now()) / 60000)) : null;
  return (
    <div className="popover-wrap" ref={ref}>
      <button className={`icon-btn ${rate !== 1 || sleepAt || sleepAfterTrack ? 'on' : ''}`} onClick={() => setOpen(!open)} aria-label="Vitesse et minuteur" title="Vitesse, minuteur, radio">
        {sleepAt || sleepAfterTrack ? <Moon size={18} /> : <Gauge size={18} />}
      </button>
      {open && (
        <div className="popover">
          <div className="pop-title">Vitesse de lecture</div>
          <div className="chips small">
            {RATES.map((r) => <button key={r} className={`chip ${rate === r ? 'active' : ''}`} onClick={() => setRate(r)}>{r}×</button>)}
          </div>
          <div className="pop-title">Minuteur de sommeil {remaining !== null && <span className="accent">· {remaining} min</span>}{sleepAfterTrack && <span className="accent">· fin du titre</span>}</div>
          <div className="chips small">
            {SLEEP.map((m) => <button key={m} className="chip" onClick={() => setSleep(m)}>{m} min</button>)}
            <button className={`chip ${sleepAfterTrack ? 'active' : ''}`} onClick={() => setSleep('track')}>Fin du titre</button>
            {(sleepAt || sleepAfterTrack) && <button className="chip danger" onClick={() => setSleep(null)}>Désactiver</button>}
          </div>
          <div className="pop-title">Radio</div>
          <label className="row gap small-text">
            <input type="checkbox" checked={autoplay} onChange={(e) => setSettings({ autoplay: e.target.checked })} />
            Lecture automatique de titres similaires en fin de file
          </label>
          <button className="btn btn-ghost full" disabled={!track || radioLoading} onClick={() => track && startRadio(track)}>
            {radioLoading ? <Loader2 size={16} className="spin" /> : <Radio size={16} />} Ajouter la radio du titre en cours
          </button>
        </div>
      )}
    </div>
  );
}

export function VolumeControl() {
  const { volume, muted, setVolume, toggleMute } = usePlayer();
  const Icon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  return (
    <div className="volume">
      <button className="icon-btn" onClick={toggleMute} aria-label={muted ? 'Rétablir le son' : 'Couper le son'} title="Muet (M)"><Icon size={18} /></button>
      <Slider label="Volume" value={muted ? 0 : volume} max={1} onCommit={setVolume} className="vol-slider" />
    </div>
  );
}

/** Jam: listen together (lit while in one). */
function JamButton() {
  const inJam = useJam((s) => !!s.jam);
  const social = useJam((s) => !!s.me);
  const setJamOpen = useUi((s) => s.setJamOpen);
  if (!social) return null;
  return (
    <button className={`icon-btn ${inJam ? 'on' : ''}`} onClick={() => setJamOpen(true)} aria-label="Jam : écouter ensemble" title={inJam ? 'Jam en cours' : 'Jam : écouter ensemble'}>
      <Radio size={18} />
    </button>
  );
}

export function PlayerBar() {
  const track = useCurrentTrack();
  const panel = useUi((s) => s.panel);
  const togglePanel = useUi((s) => s.togglePanel);
  const setNowPlaying = useUi((s) => s.setNowPlaying);
  const setEqOpen = useUi((s) => s.setEqOpen);
  const navigate = useUi((s) => s.navigate);
  const liked = useIsLiked(track?.url);
  const toggleLike = useLibrary((s) => s.toggleLike);
  const visualizer = useSettings((s) => s.visualizer);
  const eqActive = useSettings((s) => s.eqEnabled && s.eqPreset !== 'Plat');

  return (
    <footer className="player-bar">
      <div className="pb-left">
        {track ? (
          <>
            <button className="pb-cover" onClick={() => setNowPlaying(true)} aria-label="Ouvrir le lecteur plein écran">
              <Cover src={track.thumbnail} size={56} />
              <Maximize2 size={16} className="pb-cover-icon" />
            </button>
            <div className="pb-text">
              <div className="pb-title ellipsis" title={track.title} onClick={() => setNowPlaying(true)}>{track.title}</div>
              {track.author && <button className="link pb-author ellipsis" onClick={() => navigate({ name: 'artist', q: track.author! })}>{track.author}</button>}
            </div>
            <button className={`icon-btn tr-like ${liked ? 'liked' : ''}`} onClick={() => toggleLike(track)} aria-label="J'aime"><Heart size={18} fill={liked ? 'currentColor' : 'none'} /></button>
          </>
        ) : <div className="muted small">Choisissez un titre pour commencer</div>}
      </div>
      <div className="pb-center">
        <TransportControls size={38} />
        <SeekBar />
      </div>
      <div className="pb-right">
        {visualizer && <Visualizer bars={16} className="pb-viz" />}
        <MoreControls />
        {track && track.source !== 'local' && (
          <button className={`icon-btn ${liked ? 'on liked' : ''}`} onClick={() => toggleLike(track)} aria-pressed={liked}
            aria-label={liked ? 'Retirer des titres likés' : 'Ajouter aux titres likés'} title={liked ? 'Retirer des titres likés (J)' : 'Ajouter aux titres likés (J)'}>
            <Heart size={18} fill={liked ? 'currentColor' : 'none'} />
          </button>
        )}
        <JamButton />
        <button className={`icon-btn ${panel === 'lyrics' ? 'on' : ''}`} onClick={() => togglePanel('lyrics')} aria-label="Paroles" title="Paroles (L)"><Mic2 size={18} /></button>
        <button className={`icon-btn ${panel === 'video' ? 'on' : ''}`} onClick={() => togglePanel('video')} aria-label="Vidéo" title="Vidéo (V)"><MonitorPlay size={18} /></button>
        <button className={`icon-btn ${panel === 'queue' ? 'on' : ''}`} onClick={() => togglePanel('queue')} aria-label="File d'attente" title="File d'attente (Q)"><ListMusic size={18} /></button>
        <button className={`icon-btn ${eqActive ? 'on' : ''}`} onClick={() => setEqOpen(true)} aria-label="Égaliseur" title="Égaliseur (E)"><SlidersHorizontal size={18} /></button>
        <VolumeControl />
      </div>
    </footer>
  );
}
