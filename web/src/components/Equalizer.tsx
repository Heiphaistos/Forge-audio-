import { X } from 'lucide-react';
import { useEffect } from 'react';
import { EQ_BANDS, EQ_PRESETS, engine } from '../audio/engine';
import { useSettings, useUi } from '../store/ui';
import { useEscape } from '../hooks';

const label = (f: number) => (f >= 1000 ? `${f / 1000}k` : String(f));

export function Equalizer() {
  const open = useUi((s) => s.eqOpen);
  const setOpen = useUi((s) => s.setEqOpen);
  const { eqGains, eqPreset, eqEnabled, set } = useSettings();

  useEffect(() => { engine.setEq(eqGains, eqEnabled); }, [eqGains, eqEnabled]);
  useEscape(open, () => setOpen(false));

  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal eq-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Égaliseur">
        <div className="modal-head">
          <h2>Égaliseur</h2>
          <label className="switch">
            <input type="checkbox" checked={eqEnabled} onChange={(e) => set({ eqEnabled: e.target.checked })} />
            <span />
          </label>
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Fermer"><X size={20} /></button>
        </div>
        <div className="chips">
          {Object.keys(EQ_PRESETS).map((p) => (
            <button key={p} className={`chip ${eqPreset === p ? 'active' : ''}`} onClick={() => set({ eqPreset: p, eqGains: EQ_PRESETS[p], eqEnabled: true })}>{p}</button>
          ))}
          {eqPreset === 'Personnalisé' && <button className="chip active">Personnalisé</button>}
        </div>
        <div className={`eq-bands ${eqEnabled ? '' : 'disabled'}`}>
          {EQ_BANDS.map((f, i) => (
            <div className="eq-band" key={f}>
              <span className="eq-value">{eqGains[i] > 0 ? '+' : ''}{eqGains[i]}</span>
              <input
                type="range" min={-12} max={12} step={1} value={eqGains[i]} aria-label={`${label(f)} Hz`}
                onChange={(e) => {
                  const next = [...eqGains];
                  next[i] = Number(e.target.value);
                  set({ eqGains: next, eqPreset: 'Personnalisé' });
                }}
              />
              <span className="eq-freq">{label(f)}</span>
            </div>
          ))}
        </div>
        <p className="muted small">Réglages en dB appliqués en temps réel. Un gain de compensation évite la saturation.</p>
      </div>
    </div>
  );
}
