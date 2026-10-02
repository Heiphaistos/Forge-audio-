import { useEffect, useRef, useState } from 'react';
import { Cast, Laptop, MonitorSpeaker, Pause, Play, Smartphone, SkipBack, SkipForward, Globe, Volume2 } from 'lucide-react';
import type { Device } from '../lib/api';
import { formatTime } from '../lib/format';
import { useCurrentTrack } from '../store/player';
import { useJam } from '../store/social';
import { useUi } from '../store/ui';
import { DEVICE_ID, livePosition, remote, renameDevice, transferTo, useDevices } from '../store/devices';
import { chooseCastDevice, prepareCast, toggleCast, useCast } from '../store/cast';
import { Slider } from './Seek';

const KIND_ICON = { web: Globe, desktop: Laptop, android: Smartphone };

/** Sends once on release, not on every step of a drag (commands are rate limited). */
function RemoteSlider({ label, value, max, onCommit, className }: { label: string; value: number; max: number; onCommit: (v: number) => void; className?: string }) {
  const [draft, setDraft] = useState<number | null>(null);
  return <Slider label={label} value={draft ?? value} max={max} className={className} onChange={setDraft} onCommit={(v) => { setDraft(null); onCommit(v); }} />;
}

function OtherDevice({ d, canSend }: { d: Device; canSend: boolean }) {
  const s = d.state;
  const Icon = KIND_ICON[d.kind] || Globe;
  const busy = !!s?.jam;
  return (
    <div className={`dev-item ${s?.playing ? 'playing' : ''}`} data-device={d.id}>
      <div className="dev-row">
        <Icon size={18} />
        <div className="dev-text">
          <div className="dev-name ellipsis">{d.name}</div>
          <div className="dev-state muted small ellipsis">
            {busy ? 'En écoute partagée' : s?.track ? `${s.playing ? 'En lecture' : 'En pause'} · ${s.track.title}` : 'Rien en lecture'}
          </div>
        </div>
      </div>
      {!busy && (
        <div className="dev-actions">
          {s?.track && <button className="btn btn-ghost btn-sm" onClick={() => remote(d.id, { action: 'handoff', target: DEVICE_ID })}>Écouter ici</button>}
          {canSend && <button className="btn btn-ghost btn-sm" onClick={() => transferTo(d.id).catch((err: Error) => useUi.getState().toast(err.message, 'error'))}>Transférer vers cet appareil</button>}
        </div>
      )}
      {!busy && s?.track && (
        <>
          <div className="dev-controls">
            <button className="icon-btn" aria-label={`Précédent sur ${d.name}`} onClick={() => remote(d.id, { action: 'prev' })}><SkipBack size={18} fill="currentColor" /></button>
            <button className="icon-btn" aria-label={`${s.playing ? 'Pause' : 'Lecture'} sur ${d.name}`} onClick={() => remote(d.id, { action: s.playing ? 'pause' : 'play' })}>
              {s.playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
            </button>
            <button className="icon-btn" aria-label={`Suivant sur ${d.name}`} onClick={() => remote(d.id, { action: 'next' })} disabled={!s.hasNext}><SkipForward size={18} fill="currentColor" /></button>
            <span className="dev-time muted small">{formatTime(livePosition(d))} / {formatTime(s.track.duration)}</span>
          </div>
          {!!s.track.duration && <RemoteSlider label={`Position sur ${d.name}`} value={Math.min(livePosition(d), s.track.duration)} max={s.track.duration} onCommit={(v) => remote(d.id, { action: 'seek', position: v })} />}
          <div className="dev-vol"><Volume2 size={14} /><RemoteSlider label={`Volume sur ${d.name}`} value={s.volume} max={1} onCommit={(v) => remote(d.id, { action: 'volume', volume: v })} className="vol-slider" /></div>
        </>
      )}
    </div>
  );
}

function CastRow() {
  const track = useCurrentTrack();
  const { available, connected, playing } = useCast();
  useEffect(() => { prepareCast(track).catch(() => {}); }, [track?.url]);
  if (!available && !connected) return null;
  return (
    <div className="dev-cast">
      <div className="pop-title">Enceinte ou téléviseur</div>
      <div className="row gap">
        <button className="btn btn-ghost btn-sm" onClick={chooseCastDevice}><Cast size={16} /> {connected ? 'Diffusion en cours…' : 'Diffuser'}</button>
        {connected && <button className="icon-btn" onClick={toggleCast} aria-label={playing ? 'Pause sur l’enceinte' : 'Lecture sur l’enceinte'}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>}
      </div>
    </div>
  );
}

/** « Appareils »: the devices of this account, remote control and transfer (store/devices.ts). */
export function DevicesButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const social = useJam((s) => !!s.me);
  const inJam = useJam((s) => !!s.jam);
  const { list, name } = useDevices();
  const track = useCurrentTrack();
  const casting = useCast((s) => s.connected);
  const [, force] = useState(0);
  const others = list.filter((d) => d.id !== DEVICE_ID);
  const elsewhere = others.some((d) => d.state?.playing);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const t = setInterval(() => force((n) => n + 1), 1000);
    window.addEventListener('mousedown', close);
    return () => { window.removeEventListener('mousedown', close); clearInterval(t); };
  }, [open]);

  if (!social) return null;
  return (
    <div className="popover-wrap" ref={ref}>
      <button className={`icon-btn ${elsewhere || casting ? 'on' : ''}`} onClick={() => setOpen(!open)} aria-label="Appareils" title="Appareils : télécommande et diffusion" aria-expanded={open}>
        {casting ? <Cast size={18} /> : <MonitorSpeaker size={18} />}
      </button>
      {open && (
        <div className="popover dev-pop" role="dialog" aria-label="Appareils">
          <div className="pop-title">Cet appareil</div>
          <input className="input dev-rename" aria-label="Nom de cet appareil" defaultValue={name} maxLength={60}
            onBlur={(e) => { if (e.target.value.trim() !== name) renameDevice(e.target.value); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
          <div className="pop-title">Autres appareils</div>
          {inJam ? <p className="muted small">Télécommande indisponible pendant une écoute partagée.</p>
            : others.length ? others.map((d) => <OtherDevice key={d.id} d={d} canSend={!!track && track.source !== 'local'} />)
            : <p className="muted small">Ouvrez Forge Audio sur un autre appareil avec ce compte pour le piloter d’ici.</p>}
          <CastRow />
        </div>
      )}
    </div>
  );
}
