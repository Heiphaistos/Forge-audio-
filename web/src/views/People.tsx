import { ArrowLeft, Ban, Blend, Check, Loader2, MessageCircle, Send, Trash2, UserMinus, UserPlus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { inbox, people, useInbox, usePeople } from '../store/social';
import { api } from '../lib/api';
import { useSync } from '../lib/sync';
import { useUi } from '../store/ui';
import { ago } from '../components/Friends';

const MAX_TEXT = 1000;
const toastOf = () => useUi.getState().toast;

/** Run an action, show its error as a toast. */
async function act(fn: () => Promise<unknown>, done?: string) {
  try {
    await fn();
    if (done) toastOf()(done, 'success');
  } catch (err) {
    toastOf()((err as Error).message, 'error');
  }
}

/** Amis: add by username, requests received / sent, friends, blocked accounts. Nothing is automatic. */
export function FriendsView() {
  const { friends, incoming, outgoing, blocked, loaded } = usePeople();
  const navigate = useUi((s) => s.navigate);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { people.refresh().catch(() => {}); }, []);

  const send = async () => {
    const who = name.trim().toLowerCase();
    if (!who) return;
    setBusy(true);
    await act(async () => {
      const status = await people.request(who);
      toastOf()(status === 'friends' ? `Vous êtes maintenant amis avec ${who}` : `Demande envoyée à ${who}`, 'success');
      setName('');
    });
    setBusy(false);
  };
  const block = (username: string, label: string) => {
    if (confirm(`Bloquer ${label} ? Cette personne ne pourra plus vous demander en ami ni vous écrire, et ne verra plus votre activité.`)) act(() => people.block(username), `${label} est bloqué`);
  };

  return (
    <div className="page people">
      <h1 className="page-title">Amis</h1>
      <section className="settings-card">
        <h2>Ajouter un ami</h2>
        <p className="muted small">Demandez son identifiant à la personne (celui qu’elle utilise pour se connecter). Elle devra accepter : rien n’est automatique, et seuls vos amis voient votre activité, vos invitations et peuvent vous écrire.</p>
        <form className="row gap wrap" onSubmit={(e) => { e.preventDefault(); send(); }}>
          <input className="input grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="Identifiant (ex. loris)" maxLength={32} autoCapitalize="none" autoComplete="off" spellCheck={false} aria-label="Identifiant de la personne" />
          <button className="btn btn-primary" disabled={busy || name.trim().length < 2}>{busy ? <Loader2 size={16} className="spin" /> : <><UserPlus size={16} /> Envoyer la demande</>}</button>
        </form>
      </section>

      {incoming.length > 0 && (
        <section className="settings-card">
          <h2>Demandes reçues ({incoming.length})</h2>
          <div className="admin-list">
            {incoming.map((r) => (
              <div key={r.username} className="admin-row">
                <span className="avatar sm" aria-hidden>{r.displayName.slice(0, 1).toUpperCase()}</span>
                <div className="grow"><b>{r.displayName}</b> <span className="muted">@{r.username}</span><div className="muted small">{ago(r.at)}</div></div>
                <button className="btn btn-primary btn-sm" onClick={() => act(() => people.accept(r.username), `Vous êtes amis avec ${r.displayName}`)}><Check size={14} /> Accepter</button>
                <button className="btn btn-ghost btn-sm" onClick={() => act(() => people.decline(r.username))}><X size={14} /> Refuser</button>
                <button className="icon-btn" title="Bloquer" aria-label={`Bloquer ${r.displayName}`} onClick={() => block(r.username, r.displayName)}><Ban size={16} /></button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="settings-card">
        <h2>Mes amis ({friends.length})</h2>
        {!loaded ? <p className="muted"><Loader2 size={14} className="spin" /> Chargement…</p> : !friends.length ? <p className="muted">Pas encore d’ami. Envoyez une demande avec l’identifiant de la personne.</p> : (
          <div className="admin-list">
            {friends.map((f) => (
              <div key={f.username} className="admin-row">
                <button className="friend-link grow" onClick={() => navigate({ name: 'profile', id: f.username })} title={`Profil de ${f.displayName}`}>
                  <span className="avatar sm" aria-hidden>{f.displayName.slice(0, 1).toUpperCase()}</span>
                  <span className="ellipsis"><b>{f.displayName}</b> <span className="muted">@{f.username}</span></span>
                </button>
                <button className="icon-btn" title="Message" aria-label={`Écrire à ${f.displayName}`} onClick={() => navigate({ name: 'messages', id: f.username })}><MessageCircle size={17} /></button>
                <button className="icon-btn" title="Blend" aria-label={`Blend avec ${f.displayName}`} onClick={() => navigate({ name: 'blend', id: f.username })}><Blend size={17} /></button>
                <button className="icon-btn" title="Retirer des amis" aria-label={`Retirer ${f.displayName} des amis`} onClick={() => { if (confirm(`Retirer ${f.displayName} de vos amis ?`)) act(() => people.remove(f.username)); }}><UserMinus size={17} /></button>
                <button className="icon-btn" title="Bloquer" aria-label={`Bloquer ${f.displayName}`} onClick={() => block(f.username, f.displayName)}><Ban size={16} /></button>
              </div>
            ))}
          </div>
        )}
      </section>

      {outgoing.length > 0 && (
        <section className="settings-card">
          <h2>Demandes envoyées ({outgoing.length})</h2>
          <div className="admin-list">
            {outgoing.map((r) => (
              <div key={r.username} className="admin-row">
                <div className="grow">@{r.username} <span className="muted small">· {ago(r.at)}</span></div>
                <button className="btn btn-ghost btn-sm" onClick={() => act(() => people.cancel(r.username))}>Annuler</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {blocked.length > 0 && (
        <section className="settings-card">
          <h2>Comptes bloqués ({blocked.length})</h2>
          <div className="admin-list">
            {blocked.map((b) => (
              <div key={b.username} className="admin-row">
                <div className="grow">@{b.username}</div>
                <button className="btn btn-ghost btn-sm" onClick={() => act(() => people.unblock(b.username))}>Débloquer</button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

const time = (at: number) => new Date(at).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Messages: list of conversations, or the conversation with `view.id`. */
export function MessagesView() {
  const id = useUi((s) => s.view.id) || null;
  useEffect(() => {
    inbox.open(id);
    const back = () => { if (id && document.visibilityState === 'visible' && useInbox.getState().thread.length) api.readMessages(id).catch(() => {}); };
    document.addEventListener('visibilitychange', back);
    return () => { document.removeEventListener('visibilitychange', back); inbox.open(null); };
  }, [id]);
  return id ? <Thread username={id} /> : <ConversationList />;
}

function ConversationList() {
  const { conversations } = useInbox();
  const friends = usePeople((s) => s.friends);
  const navigate = useUi((s) => s.navigate);
  useEffect(() => { inbox.refresh().catch(() => {}); }, []);
  const talked = new Set(conversations.map((c) => c.with.username));
  return (
    <div className="page people">
      <h1 className="page-title">Messages</h1>
      {!conversations.length && <p className="muted">Aucune conversation. Écrivez à un ami ci-dessous.</p>}
      <div className="admin-list">
        {conversations.map((c) => (
          <button key={c.with.username} className={`admin-row conv-row ${c.unread ? 'unread' : ''}`} onClick={() => navigate({ name: 'messages', id: c.with.username })}>
            <span className="avatar sm" aria-hidden>{c.with.displayName.slice(0, 1).toUpperCase()}</span>
            <div className="grow ellipsis">
              <div className="row gap"><b className="ellipsis">{c.with.displayName}</b><span className="muted small">{ago(c.last.at)}</span></div>
              <div className="muted small ellipsis">{c.last.from === c.with.username ? '' : 'Vous : '}{c.last.text}</div>
            </div>
            {c.unread > 0 && <span className="badge" aria-label={`${c.unread} non lus`}>{c.unread}</span>}
          </button>
        ))}
      </div>
      {friends.some((f) => !talked.has(f.username)) && (
        <>
          <h3 className="settings-sub">Écrire à</h3>
          <div className="chips">
            {friends.filter((f) => !talked.has(f.username)).map((f) => (
              <button key={f.username} className="chip" onClick={() => navigate({ name: 'messages', id: f.username })}><MessageCircle size={13} /> {f.displayName}</button>
            ))}
          </div>
        </>
      )}
      {!friends.length && <p className="muted small">Vous ne pouvez écrire qu’à vos amis. <button className="link accent" onClick={() => navigate({ name: 'friends' })}>Ajouter un ami</button></p>}
    </div>
  );
}

function Thread({ username }: { username: string }) {
  const { with: other, thread, readByOther, loading } = useInbox();
  const me = useSync((s) => s.user?.username);
  const navigate = useUi((s) => s.navigate);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [thread.length]);
  const name = other?.displayName || username;
  const lastMine = [...thread].reverse().find((m) => m.from === me);
  return (
    <div className="page people thread-page">
      <div className="row gap thread-head">
        <button className="icon-btn" onClick={() => navigate({ name: 'messages' })} aria-label="Toutes les conversations"><ArrowLeft size={20} /></button>
        {other?.friend ? (
          <button className="friend-link grow" onClick={() => navigate({ name: 'profile', id: username })} title={`Profil de ${name}`}>
            <span className="avatar sm" aria-hidden>{name.slice(0, 1).toUpperCase()}</span>
            <h1 className="ellipsis thread-title">{name}</h1>
          </button>
        ) : (
          <>
            <span className="avatar sm" aria-hidden>{name.slice(0, 1).toUpperCase()}</span>
            <h1 className="grow ellipsis thread-title">{name}</h1>
          </>
        )}
        {thread.length > 0 && (
          <button className="icon-btn" title="Supprimer la conversation" aria-label="Supprimer la conversation" onClick={() => {
            if (confirm(`Supprimer la conversation avec ${name} ? Elle disparaît pour vous ; les messages sont effacés du serveur quand vous l’avez supprimée tous les deux.`)) act(() => inbox.clear(username), 'Conversation supprimée');
          }}><Trash2 size={17} /></button>
        )}
      </div>
      <div className="thread" role="log" aria-live="polite">
        {loading && <p className="muted"><Loader2 size={14} className="spin" /> Chargement…</p>}
        {!loading && !thread.length && <p className="muted small center-text">Aucun message.</p>}
        {thread.map((m) => (
          // Plain text only: React escapes it, nothing is ever rendered as HTML.
          <div key={m.id} className={`bubble ${m.from === me ? 'mine' : ''}`} title={time(m.at)}>
            <div className="bubble-text">{m.text}</div>
            <div className="bubble-meta">{time(m.at)}{m === lastMine && readByOther >= m.at ? ' · vu' : ''}</div>
          </div>
        ))}
        <div ref={end} className="thread-end" />
      </div>
      {other && !other.friend ? (
        <p className="muted small notice-line">Vous n’êtes pas (ou plus) amis : vous ne pouvez pas écrire à {name}.</p>
      ) : (
        <Composer onSend={(text) => inbox.send(username, text)} placeholder={`Message à ${name}`} />
      )}
    </div>
  );
}

/** Text box + send (Entrée envoie, Maj+Entrée = nouvelle ligne); 1000 characters max. */
export function Composer({ onSend, placeholder }: { onSend: (text: string) => Promise<void>; placeholder: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try { await onSend(t); setText(''); } catch (err) { toastOf()((err as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <textarea className="input grow" rows={1} value={text} maxLength={MAX_TEXT} placeholder={placeholder} aria-label={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} />
      {text.length > MAX_TEXT - 100 && <span className="muted small">{MAX_TEXT - text.length}</span>}
      <button className="icon-btn send-btn" disabled={busy || !text.trim()} aria-label="Envoyer"><Send size={18} /></button>
    </form>
  );
}
