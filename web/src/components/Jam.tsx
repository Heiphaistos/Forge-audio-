import { Copy, Crown, Loader2, LogOut, Radio, Send, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { User } from '../lib/api';
import { useUi } from '../store/ui';
import { jam, nameOf, otherAccounts, useJam } from '../store/social';
import { useEscape } from '../hooks';

/** Top banner while in a Jam: whose Jam, how many people, opens the Jam window. */
export function JamBanner() {
  const j = useJam((s) => s.jam);
  const me = useJam((s) => s.me);
  const setOpen = useUi((s) => s.setJamOpen);
  if (!j) return null;
  return (
    <button className="jam-banner" onClick={() => setOpen(true)}>
      <Radio size={15} />
      <span className="ellipsis">{j.host === me ? 'Votre Jam' : `Jam de ${nameOf(j.host)}`} · {j.participants.length} participant{j.participants.length > 1 ? 's' : ''} · code <b>{j.code}</b></span>
    </button>
  );
}

/** Start / join / manage a Jam (group session on one shared queue, everyone hears the same thing). */
export function JamPanel() {
  const open = useUi((s) => s.jamOpen);
  const setOpen = useUi((s) => s.setJamOpen);
  const toast = useUi((s) => s.toast);
  const j = useJam((s) => s.jam);
  const me = useJam((s) => s.me);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [people, setPeople] = useState<User[]>([]);
  const close = () => setOpen(false);
  useEscape(open, close);
  useEffect(() => { if (open) otherAccounts().then(setPeople).catch(() => {}); }, [open]);
  if (!open) return null;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const host = j?.host === me;
  const inJam = new Set(j?.participants.map((p) => p.username));

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal jam-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Jam">
        <div className="modal-head">
          <h2><Radio size={20} /> Jam</h2>
          <button className="icon-btn" onClick={close} aria-label="Fermer"><X size={20} /></button>
        </div>
        {!j ? (
          <>
            <p className="muted small">Écoutez ensemble, chacun sur son appareil : tout le monde ajoute des titres à la même file et entend la même chose au même moment.</p>
            <button className="btn btn-primary full" disabled={busy} onClick={() => run(jam.start)}>
              {busy ? <Loader2 size={16} className="spin" /> : <Radio size={16} />} Lancer un Jam avec ma file d'attente
            </button>
            <form className="row gap" onSubmit={(e) => { e.preventDefault(); if (code.trim()) run(() => jam.join(code)); }}>
              <input className="input grow jam-code-input" placeholder="Code du Jam (6 caractères)" value={code} maxLength={6} onChange={(e) => setCode(e.target.value.toUpperCase())} aria-label="Code du Jam" autoCapitalize="characters" />
              <button className="btn btn-ghost" disabled={busy || code.trim().length < 6}>Rejoindre</button>
            </form>
          </>
        ) : (
          <>
            <div className="jam-code">
              <div className="muted small">Code à partager</div>
              <div className="jam-code-value">{j.code}</div>
              <button className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard?.writeText(j.code).then(() => toast('Code copié', 'success'))}><Copy size={14} /> Copier</button>
            </div>
            <div>
              <h3 className="small muted">Participants</h3>
              <ul className="jam-people">
                {j.participants.map((p) => (
                  <li key={p.username}>
                    <span className="avatar sm" aria-hidden>{p.displayName.slice(0, 1).toUpperCase()}</span>
                    <span className="grow">{p.displayName}{p.username === me ? ' (vous)' : ''}</span>
                    {p.username === j.host && <span className="muted small"><Crown size={13} /> hôte</span>}
                  </li>
                ))}
              </ul>
            </div>
            {people.some((u) => !inJam.has(u.username)) && (
              <div>
                <h3 className="small muted">Inviter</h3>
                <div className="chips">
                  {people.filter((u) => !inJam.has(u.username)).map((u) => (
                    <button key={u.username} className="chip" disabled={busy} onClick={() => run(() => jam.invite(u.username))}><Send size={13} /> {u.displayName}</button>
                  ))}
                </div>
              </div>
            )}
            {host ? (
              <label className="setting">
                <input type="checkbox" checked={j.everyoneControls} onChange={(e) => run(() => jam.everyone(e.target.checked))} />
                <span><b>Tout le monde contrôle la lecture</b><br /><span className="muted small">Sinon, seul vous (l'hôte) mettez en pause, passez ou revenez en arrière. Tout le monde peut ajouter des titres.</span></span>
              </label>
            ) : (
              <p className="muted small"><Users size={13} /> {j.everyoneControls ? 'Tout le monde peut contrôler la lecture.' : `${nameOf(j.host)} contrôle la lecture ; vous pouvez ajouter des titres (menu ⋯ ou « Ajouter à la file »).`}</p>
            )}
            <button className="btn btn-ghost danger" disabled={busy} onClick={() => run(async () => { await jam.leave(); close(); })}>
              <LogOut size={16} /> {host ? 'Terminer le Jam pour tout le monde' : 'Quitter le Jam'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
