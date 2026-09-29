import { useState } from 'react';
import { usePlayer } from '../store/player';
import { formatTime } from '../lib/format';

/** Range input with a filled track; commits on release so dragging does not spam seeks. */
export function Slider({ value, max, onChange, onCommit, label, disabled, className = '' }: {
  value: number; max: number; onChange?: (v: number) => void; onCommit: (v: number) => void; label: string; disabled?: boolean; className?: string;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <input
      type="range" className={`slider ${className}`} aria-label={label} min={0} max={max || 1} step="any" value={Math.min(value, max || 1)} disabled={disabled}
      style={{ ['--pct' as string]: `${pct}%` }}
      onChange={(e) => { const v = Number(e.target.value); onChange?.(v); if (!onChange) onCommit(v); }}
      onPointerUp={(e) => onChange && onCommit(Number((e.target as HTMLInputElement).value))}
      onKeyUp={(e) => onChange && onCommit(Number((e.target as HTMLInputElement).value))}
    />
  );
}

export function SeekBar({ compact = false }: { compact?: boolean }) {
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.duration);
  const seek = usePlayer((s) => s.seek);
  const isLive = usePlayer((s) => !!s.queue[s.index]?.isLive);
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? position;
  return (
    <div className={`seekbar ${compact ? 'compact' : ''}`}>
      <span className="time">{formatTime(shown)}</span>
      <Slider
        label="Position" value={shown} max={duration || 0} disabled={!duration || isLive}
        onChange={setDrag} onCommit={(v) => { seek(v); setDrag(null); }}
      />
      <span className="time">{isLive ? 'DIRECT' : formatTime(duration)}</span>
    </div>
  );
}
