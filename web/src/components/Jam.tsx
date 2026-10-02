import { Copy, Crown, Loader2, LogOut, Radio, Send, Users, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Jam, User } from '../lib/api';
import { useUi } from '../store/ui';
import { jam, jamSay, nameOf, otherAccounts, useJam, useJamChat, usePeople } from '../store/social';
import { Composer } from '../views/People';
import { useEscape } from '../hooks';

const PERMS: [keyof Jam['perms'], string, string][] = [
  ['playback', 'Mettre en pause et avancer dans le titre', 'Lecture, pause et déplacement dans le titre en cours.'],
  ['skip', 'Changer de titre', 'Titre suivant ou précédent, choisir un titre de la file, lancer tout de suite un titre ou une playlist.'],
  ['queue', 'Gérer la file', 'Vider la file, retirer et réordonner les titres de tout le monde.'],
];

function guestRights(j: Jam) {
  const ok = PERMS.filter(([p]) => j.perms?.[p]).map(([, label]) => label.toLowerCase());
  const base = 'Vous pouvez ajouter des titres et retirer les vôtres';
  return ok.length ? `${base}, et aussi : ${ok.join(' ; ')}.` : `${base} ; ${nameOf(j.host)} garde le contrôle de la lecture.`;
}

/** Top banner while in a Jam: whose Jam, how many people, opens the Jam window. */
export function JamBanner() {
  const j = useJam((s) => s.jam);
  const me = useJam((s) => s.me);
  const setOpen = useUi((s) => s.setJamOpen);
  const unread = useJamChat((s) => s.unread);
  if (!j) return null;
  return (
    <button className="jam-banner" onClick={() => setOpen(true)}>
      <Radio size={15} />
      <span className="ellipsis grow">{j.host === me ? 'Votre écoute partagée' : `Écoute partagée de ${nameOf(j.host)}`} · code <b>{j.code}</b> · {j.participants.length} participant{j.participants.length > 1 ? 's' : ''}</span>
      {unread > 0 && <span className="badge" aria-label={`${unread} message${unread > 1 ? 's' : ''} non lu${unread > 1 ? 's' : ''} dans l’écoute partagée`}>{unread}</span>}
    </button>
  );
}

/** Chat of the Jam: participants only, kept in the server's memory until the Jam ends. */
function JamChat() {
  const messages = useJamChat((s) => s.messages);
  const me = useJam((s) => s.me);
  const box = useRef<HTMLDivElement>(null);
  // Scroll the chat box only (scrollIntoView also moved the Jam window and hid the newest lines).
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [messages.length]);
  return (
    <div>
      <h3 className="small muted">Discussion</h3>
      <div ref={box} className="thread jam-chat" role="log" aria-live="polite">
        {!messages.length && <p className="muted small">Aucun message. La discussion disparaît à la fin de l’écoute partagée.</p>}
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.from === me ? 'mine' : ''}`}>
            {m.from !== me && <div className="bubble-meta">{m.displayName || m.from}</div>}
            <div className="bubble-text">{m.text}</div>
          </div>
        ))}
      </div>
      <Composer onSend={jamSay} placeholder="Écrire aux participants" />
    </div>
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
  useEffect(() => { if (open) useJamChat.setState({ unread: 0 }); }, [open, j?.id]);
  if (!open) return null;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch (err) { toast((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  const host = j?.host === me;
  const inJam = new Set(j?.participants.map((p) => p.username));
  // A participant's profile opens for friends (and oneself): others joined with the code.
  const profileOf = (username: string) => (username === me || usePeople.getState().friends.some((f) => f.username === username)
    ? () => { close(); useUi.getState().navigate({ name: 'profile', id: username }); } : undefined);

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal jam-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Écoute partagée">
        <div className="modal-head">
          <h2><Radio size={20} /> Écoute partagée</h2>
          <button className="icon-btn" onClick={close} aria-label="Fermer"><X size={20} /></button>
        </div>
        {!j ? (
          <>
            <p className="muted small">Écoutez ensemble, chacun sur son appareil : tout le monde ajoute des titres à la même file et entend la même chose au même moment.</p>
            <button className="btn btn-primary full" disabled={busy} onClick={() => run(jam.start)}>
              {busy ? <Loader2 size={16} className="spin" /> : <Radio size={16} />} Lancer une écoute partagée avec ma file d'attente
            </button>
            <form className="row gap" onSubmit={(e) => { e.preventDefault(); if (code.trim()) run(() => jam.join(code)); }}>
              <input className="input grow jam-code-input" placeholder="Code à 6 caractères" value={code} maxLength={6} onChange={(e) => setCode(e.target.value.toUpperCase())} aria-label="Code de l’écoute partagée" autoCapitalize="characters" />
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
                    <button className="friend-link grow" disabled={!profileOf(p.username)} onClick={profileOf(p.username)} title={profileOf(p.username) ? `Profil de ${p.displayName}` : undefined}>
                      <span className="avatar sm" aria-hidden>{p.displayName.slice(0, 1).toUpperCase()}</span>
                      <span className="ellipsis">{p.displayName}{p.username === me ? ' (vous)' : ''}</span>
                    </button>
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
            <JamChat />
            {host ? (
              <div>
                <h3 className="small muted">Ce que les invités peuvent faire</h3>
                {PERMS.map(([perm, label, hint]) => (
                  <label key={perm} className="setting">
                    <input type="checkbox" checked={!!j.perms?.[perm]} disabled={busy} onChange={(e) => run(() => jam.setPerms({ [perm]: e.target.checked }))} />
                    <span><b>{label}</b><br /><span className="muted small">{hint}</span></span>
                  </label>
                ))}
                <p className="muted small">Tout le monde peut ajouter des titres et retirer les siens.</p>
              </div>
            ) : (
              <p className="muted small"><Users size={13} /> {guestRights(j)}</p>
            )}
            <button className="btn btn-ghost danger" disabled={busy} onClick={() => run(async () => { await jam.leave(); close(); })}>
              <LogOut size={16} /> {host ? 'Terminer l’écoute partagée pour tous' : 'Quitter l’écoute partagée'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
