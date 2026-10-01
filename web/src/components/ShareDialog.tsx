import { Check, Loader2, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { User } from '../lib/api';
import { otherAccounts } from '../store/social';
import { useEscape } from '../hooks';

/** Pick the accounts a playlist is shared with (collaborative playlist: every member edits it). */
export function ShareDialog({ title, initial = [], confirm, onDone, onClose }: {
  title: string;
  initial?: string[];
  confirm: string;
  onDone: (members: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [people, setPeople] = useState<User[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscape(true, onClose);
  useEffect(() => { otherAccounts().then(setPeople).catch((e) => setError(e.message)); }, []);

  const toggle = (u: string) => {
    const next = new Set(picked);
    if (next.has(u)) next.delete(u); else next.add(u);
    setPicked(next);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal picker" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2><Users size={20} /> {title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Fermer"><X size={20} /></button>
        </div>
        <p className="muted small">Les membres voient la playlist dans leur bibliothèque et peuvent ajouter, retirer et réordonner les titres. Seul vous la renommez, gérez les membres ou la supprimez.</p>
        <div className="picker-list">
          {!people && !error && <p className="muted"><Loader2 size={14} className="spin" /> Chargement des amis…</p>}
          {people?.map((u) => (
            <button key={u.username} className={`picker-item ${picked.has(u.username) ? 'picked' : ''}`} onClick={() => toggle(u.username)} aria-pressed={picked.has(u.username)}>
              <span className="avatar" aria-hidden>{u.displayName.slice(0, 1).toUpperCase()}</span>
              <span className="grow ellipsis">{u.displayName}</span>
              {picked.has(u.username) && <Check size={18} className="accent" />}
            </button>
          ))}
          {people && !people.length && <p className="muted small">Vous ne pouvez partager qu’avec vos amis : ajoutez-en dans « Amis ».</p>}
        </div>
        {error && <p className="bad small">{error}</p>}
        <button className="btn btn-primary full" disabled={busy} onClick={async () => {
          setBusy(true); setError(null);
          try { await onDone([...picked]); onClose(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
        }}>{busy ? <Loader2 size={16} className="spin" /> : confirm}</button>
      </div>
    </div>
  );
}
