import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { ArrowLeft, Copy, Eye, EyeOff, KeyRound, Loader2, Lock, Mail, ShieldCheck, Wand2, X } from 'lucide-react';
import { api, type EmailState, type User } from '../lib/api';
import type { Wrapped } from '../lib/e2e';
import { useSync } from '../lib/sync';
import { useJam } from '../store/social';
import { useUi } from '../store/ui';
import { newBackupCode, rewrapWithBackup, setupKeys, useKeys } from '../store/keys';
import { PASSWORD_MIN, generatePassword, missing } from './Register';

/**
 * Account recovery (server/src/recovery.js): optional e-mail address, « Mot de passe oublié ? »,
 * and the « code de secours des messages » that keeps private messages readable after a reset.
 */

let mailStatus: Promise<boolean> | null = null;
/** Can this server send mail? (asked once, before sign-in too) */
export function useMailAvailable() {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    mailStatus ??= api.recoveryStatus().then((r) => r.mail, () => false);
    mailStatus.then(setOk);
  }, []);
  return ok;
}

/** The account's address, shared by the Settings card and the reminder. */
const useEmail = create<{ state: EmailState | null }>(() => ({ state: null }));
const loadEmail = () => api.myEmail().then((state) => useEmail.setState({ state }), () => {});

/** Signed in with a real account (not the desktop app's local mode). */
const useAccount = () => {
  const user = useSync((s) => s.user);
  const social = useJam((s) => !!s.me);
  return user && social ? user : null;
};

function PasswordField({ value, onChange, placeholder, autoComplete = 'current-password' }: { value: string; onChange: (v: string) => void; placeholder: string; autoComplete?: string }) {
  return <input className="input" type="password" autoComplete={autoComplete} spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} />;
}

// ---------------------------------------------------------------- « Mot de passe oublié ? »
type Found = { ticket: string; username: string; hasKey: boolean; backup: Wrapped | null };

export function ForgotPassword({ onDone, onBack }: { onDone: (user: User) => void; onBack: () => void }) {
  const mail = useMailAvailable();
  const [step, setStep] = useState<'ask' | 'code' | 'new'>('ask');
  const [login, setLogin] = useState(() => localStorage.getItem('forge.lastUser') || '');
  const [code, setCode] = useState('');
  const [found, setFound] = useState<Found | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [backupCode, setBackupCode] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<void>) => async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const todo = missing(password);

  const back = <button type="button" className="link accent small" onClick={onBack}><ArrowLeft size={14} style={{ verticalAlign: '-2px' }} /> Retour à la connexion</button>;
  if (!mail) {
    return (
      <div className="login-form">
        <p className="muted small">La récupération par e-mail n’est pas disponible sur ce serveur. Demandez à l’administrateur de réinitialiser votre mot de passe.</p>
        {back}
      </div>
    );
  }

  if (step === 'ask') {
    return (
      <form className="login-form" onSubmit={run(async () => { await api.recoveryStart(login.trim()); setCode(''); setStep('code'); })}>
        <p className="muted small"><span>Saisissez votre identifiant ou votre adresse e-mail. Si une adresse <b>vérifiée</b> est liée au compte, un code à 6 chiffres y sera envoyé.</span></p>
        <label className="field">
          <span>Identifiant ou adresse e-mail</span>
          <div className="input-icon"><Mail size={16} /><input autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={254} value={login} onChange={(e) => setLogin(e.target.value)} placeholder="ex. loris ou loris@exemple.fr" /></div>
        </label>
        {error && <p className="bad small">{error}</p>}
        <button className="btn btn-primary full" disabled={busy || !login.trim()}>{busy ? <Loader2 size={16} className="spin" /> : 'Recevoir un code'}</button>
        {back}
      </form>
    );
  }

  if (step === 'code' || !found) {
    return (
      <form className="login-form" onSubmit={run(async () => { setFound(await api.recoveryVerify(login.trim(), code)); setStep('new'); })}>
        <p className="muted small"><span>Si un compte avec une adresse vérifiée correspond, un code vient d’y être envoyé. Il est valable <b>15 minutes</b> (5 essais). Pensez aux courriers indésirables.</span></p>
        <p className="muted small">Pas d’adresse vérifiée sur le compte ? Aucun mail n’arrivera : seul l’administrateur peut alors réinitialiser le mot de passe.</p>
        <label className="field">
          <span>Code reçu par e-mail</span>
          <div className="input-icon"><KeyRound size={16} /><input autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" /></div>
        </label>
        {error && <p className="bad small">{error}</p>}
        <button className="btn btn-primary full" disabled={busy || code.length !== 6}>{busy ? <Loader2 size={16} className="spin" /> : 'Valider le code'}</button>
        <button type="button" className="link accent small" onClick={() => { setError(null); setStep('ask'); }}>Recevoir un autre code</button>
        {back}
      </form>
    );
  }

  const ready = !todo.length && confirm === password;
  return (
    <form className="login-form" onSubmit={run(async () => {
      if (!ready) return;
      // The « code de secours » opens the message key HERE; the server only gets it re-encrypted.
      const wrapped = found.hasKey && found.backup && backupCode.trim() ? await rewrapWithBackup(found.backup, backupCode, found.username, password) : null;
      const { user } = await api.recoveryReset(found.ticket, password, wrapped);
      await setupKeys(user.username, password).catch(() => {});
      try { localStorage.setItem('forge.lastUser', user.username); } catch { /* quota */ }
      useUi.getState().toast(wrapped ? 'Mot de passe réinitialisé, messages conservés' : 'Mot de passe réinitialisé', 'success');
      onDone(user);
    })}>
      <p className="muted small"><span>Code accepté pour <b>{found.username}</b>. Choisissez un nouveau mot de passe : tous vos appareils seront déconnectés.</span></p>
      <div className="field">
        <label htmlFor="reset-pw">Nouveau mot de passe</label>
        <div className="input-icon">
          <Lock size={16} />
          <input id="reset-pw" autoFocus type={show ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={`Au moins ${PASSWORD_MIN} caractères`} />
          <button type="button" className="icon-btn" onClick={() => setShow(!show)} aria-label={show ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}>{show ? <EyeOff size={16} /> : <Eye size={16} />}</button>
        </div>
        <small className={todo.length ? 'muted hint' : 'ok hint'}>{password.length} / {PASSWORD_MIN} caractères{todo.length ? ` · il manque ${todo.join(', ')}` : ' · mot de passe valide'}</small>
        <div className="row gap wrap">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const pw = generatePassword(80); setPassword(pw); setConfirm(pw); setShow(true); }}><Wand2 size={14} /> Générer un mot de passe</button>
          {password && <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard?.writeText(password)}><Copy size={14} /> Copier</button>}
        </div>
      </div>
      <label className="field">
        <span>Confirmation</span>
        <div className="input-icon"><KeyRound size={16} /><input type={show ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Retapez ou collez le mot de passe" /></div>
        {confirm && confirm !== password && <small className="bad hint">Les deux mots de passe sont différents.</small>}
      </label>
      {found.hasKey && found.backup && (
        <label className="field">
          <span>Code de secours des messages <small className="muted">(facultatif)</small></span>
          <div className="input-icon"><ShieldCheck size={16} /><input autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={40} value={backupCode} onChange={(e) => setBackupCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" /></div>
          <small className="muted hint">{backupCode.trim() ? 'Vos conversations seront conservées.' : 'Sans lui, vos anciens messages privés deviendront illisibles (ils sont chiffrés avec votre ancien mot de passe).'}</small>
        </label>
      )}
      {found.hasKey && !found.backup && <p className="muted small">Vos anciens messages privés deviendront illisibles : ils sont chiffrés avec votre ancien mot de passe et aucun code de secours n’avait été créé. Vos amis verront « la clé a changé ».</p>}
      {error && <p className="bad small">{error}</p>}
      <button className="btn btn-primary full" disabled={busy || !ready}>{busy ? <Loader2 size={16} className="spin" /> : 'Changer le mot de passe'}</button>
      {back}
    </form>
  );
}

// ---------------------------------------------------------------- Paramètres > Adresse e-mail
export function EmailCard() {
  const account = useAccount();
  const state = useEmail((s) => s.state);
  const toast = useUi((s) => s.toast);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (account) loadEmail(); }, [account]);
  if (!account || !state) return null;
  const run = (fn: () => Promise<EmailState>, done?: string) => async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      useEmail.setState({ state: await fn() });
      setPassword('');
      if (done) toast(done, 'success');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <section className="settings-card" id="adresse-e-mail">
      <h2>Adresse e-mail</h2>
      <p className="muted small">Facultative. Elle sert <b>uniquement</b> à récupérer votre compte si vous oubliez votre mot de passe (code envoyé par mail), et à vous prévenir quand le mot de passe est réinitialisé. Sans adresse vérifiée, un mot de passe perdu = compte perdu.</p>
      {!state.mail && <p className="muted small">L’envoi de mails n’est pas disponible sur ce serveur pour le moment.</p>}
      {state.email && <p className="ok">✓ {state.email} <span className="muted small">(vérifiée)</span></p>}
      {state.pending && (
        <form className="login-form" onSubmit={run(() => api.verifyEmail(code).finally(() => setCode('')), 'Adresse vérifiée')}>
          <p className="small">Code envoyé à <b>{state.pending}</b> (valable 15 minutes, 5 essais).</p>
          <div className="row gap wrap">
            <input className="input grow" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="Code à 6 chiffres" aria-label="Code à 6 chiffres" />
            <button className="btn btn-primary" disabled={busy || code.length !== 6}>Vérifier</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => api.resendEmail(), 'Nouveau code envoyé')()}>Renvoyer le code</button>
          </div>
        </form>
      )}
      {state.mail && (
        <form className="login-form" onSubmit={run(() => api.setEmail(email.trim(), password).then((s) => { setEmail(''); return s; }), 'Code envoyé : consultez votre boîte mail')}>
          <h3 className="settings-sub">{state.email || state.pending ? 'Changer d’adresse' : 'Ajouter une adresse'}</h3>
          <input className="input" type="email" autoComplete="email" spellCheck={false} maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="vous@exemple.fr" aria-label="Adresse e-mail" />
          <PasswordField value={password} onChange={setPassword} placeholder="Mot de passe actuel (confirmation)" />
          <small className="muted hint">Votre mot de passe est demandé pour qu’une session restée ouverte ne suffise pas à détourner le compte. L’ancienne adresse reste active jusqu’à la vérification de la nouvelle, puis elle est prévenue.</small>
          <div className="row gap wrap">
            <button className="btn btn-primary" disabled={busy || !email.trim() || !password}>{busy ? <Loader2 size={16} className="spin" /> : 'Envoyer un code'}</button>
            {(state.email || state.pending) && (
              <button type="button" className="btn btn-ghost danger" disabled={busy || !password} title={password ? undefined : 'Saisissez votre mot de passe'} onClick={() => {
                if (confirm('Retirer votre adresse e-mail ? Vous ne pourrez plus récupérer votre compte seul en cas d’oubli du mot de passe.')) run(() => api.removeEmail(password), 'Adresse retirée')();
              }}>Retirer l’adresse</button>
            )}
          </div>
        </form>
      )}
      {error && <p className="bad small">{error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------- code de secours des messages
export function BackupCodeCard() {
  const account = useAccount();
  const status = useKeys((s) => s.status);
  const shown = useKeys((s) => s.backupCode);
  const [backupAt, setBackupAt] = useState<number | null | undefined>(undefined);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (account) api.myKeys().then((r) => setBackupAt(r.key ? r.key.backupAt : undefined), () => {});
  }, [account, shown]);
  if (!account || backupAt === undefined) return null;
  return (
    <section className="settings-card">
      <h2>Code de secours des messages</h2>
      <p className="muted small">Vos messages privés sont chiffrés avec une clé protégée par votre mot de passe. Si vous réinitialisez le mot de passe par e-mail, ce code de 24 caractères permet de <b>garder vos conversations</b> ; sans lui, elles deviennent illisibles. Il est créé dans votre navigateur avec votre mot de passe (qui n’est pas envoyé) : le serveur ne voit jamais le code. Régénérer le code rend l’ancien inutilisable. Rangez-le à part (papier, gestionnaire de mots de passe).</p>
      <p className="small">{backupAt ? <span className="ok">✓ Code créé le {new Date(backupAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}</span> : <span className="muted">Aucun code de secours pour l’instant.</span>}</p>
      <form className="login-form" onSubmit={async (e) => {
        e.preventDefault();
        if (backupAt && !confirm('Créer un nouveau code ? L’ancien ne fonctionnera plus.')) return;
        setBusy(true);
        setError(null);
        try { await newBackupCode(password); setPassword(''); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
      }}>
        <PasswordField value={password} onChange={setPassword} placeholder="Mot de passe actuel" />
        {error && <p className="bad small">{error}</p>}
        <button className="btn btn-primary" disabled={busy || !password || status === 'unknown'}>{busy ? <Loader2 size={16} className="spin" /> : backupAt ? 'Régénérer le code' : 'Créer mon code de secours'}</button>
      </form>
    </section>
  );
}

/** Shown once, right after a code was made (new key or Settings). */
export function BackupCodeDialog() {
  const code = useKeys((s) => s.backupCode);
  const [copied, setCopied] = useState(false);
  if (!code) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Votre code de secours des messages">
        <div className="modal-head"><ShieldCheck size={22} /><h2>Votre code de secours des messages</h2></div>
        <p className="muted small">Il permet de garder vos messages privés si un jour vous réinitialisez votre mot de passe par e-mail. <b>Il ne sera plus jamais affiché</b> et le serveur ne le connaît pas : notez-le maintenant et rangez-le à part.</p>
        <div className="admin-code"><code style={{ fontSize: 17, letterSpacing: 1, overflowWrap: 'normal' }}>{code}</code></div>
        <div className="row gap wrap">
          <button className="btn btn-ghost" onClick={() => navigator.clipboard?.writeText(code).then(() => setCopied(true))}><Copy size={16} /> {copied ? 'Copié' : 'Copier'}</button>
          <button className="btn btn-primary" onClick={() => { setCopied(false); useKeys.setState({ backupCode: null }); }}>Je l’ai noté</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- discreet reminder
const LATER = 'forge.recovery.later';
const LATER_MS = 30 * 24 * 3600 * 1000;

export function RecoveryReminder() {
  const account = useAccount();
  const state = useEmail((s) => s.state);
  const navigate = useUi((s) => s.navigate);
  const [later, setLater] = useState(() => { try { return Date.now() - Number(localStorage.getItem(LATER) || 0) < LATER_MS; } catch { return false; } });
  useEffect(() => { if (account) loadEmail(); }, [account]);
  if (!account || !state?.mail || state.email || later) return null;
  return (
    <div className="jam-banner" role="status">
      <Mail size={15} />
      <span className="grow" style={{ minWidth: 0 }}>
        {state.pending ? <>Vérifiez votre adresse e-mail : un code a été envoyé à <b>{state.pending}</b>.</> : <>Ajoutez une adresse e-mail : sans adresse vérifiée, un mot de passe perdu = compte perdu.</>}
        {' '}<button className="link accent" onClick={() => navigate({ name: 'settings' })}>{state.pending ? 'Saisir le code' : 'Ajouter'}</button>
      </span>
      <button className="icon-btn" aria-label="Plus tard" title="Me le rappeler dans 30 jours" onClick={() => { try { localStorage.setItem(LATER, String(Date.now())); } catch { /* private mode */ } setLater(true); }}><X size={15} /></button>
    </div>
  );
}
