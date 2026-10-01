import { useState } from 'react';
import { Copy, Eye, EyeOff, KeyRound, Loader2, Lock, Mail, Ticket, User as UserIcon, Wand2 } from 'lucide-react';
import { api, type User } from '../lib/api';
import { setupKeys } from '../store/keys';
import { useMailAvailable } from './Recovery';

export const PASSWORD_MIN = 70; // same as server/src/accounts.js

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
// Symbols that survive copy-paste anywhere (Discord, SMS, mail): no * _ ~ | ` < > quotes or spaces.
const SYMBOLS = '!#%+-=?@.:';

/** Uniform random index (rejection sampling, no modulo bias). */
function randomIndex(n: number) {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / n) * n;
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return buf[0] % n;
}

/** 80-character password with every class, generated in the browser. */
export function generatePassword(length = 80) {
  const all = UPPER + LOWER + DIGITS + SYMBOLS;
  const pick = (set: string) => set[randomIndex(set.length)];
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export function missing(pw: string) {
  const out: string[] = [];
  if (pw.length < PASSWORD_MIN) out.push(`${PASSWORD_MIN - pw.length} caractère${PASSWORD_MIN - pw.length > 1 ? 's' : ''} de plus`);
  if (!/[A-Z]/.test(pw)) out.push('une majuscule');
  if (!/[a-z]/.test(pw)) out.push('une minuscule');
  if (!/[0-9]/.test(pw)) out.push('un chiffre');
  if (!/[^A-Za-z0-9]/.test(pw)) out.push('un symbole');
  return out;
}

/** Sign-up with an invitation code given by an administrator. */
export function Register({ onDone }: { onDone: (user: User) => void }) {
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const mail = useMailAvailable();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const todo = missing(password);
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = code.trim() && username.trim() && !todo.length && confirm === password;

  return (
    <form className="login-form" onSubmit={async (e) => {
      e.preventDefault();
      if (!ready) return;
      setLoading(true);
      setError(null);
      try {
        const { user } = await api.register({ code: code.trim(), username: username.trim(), displayName: displayName.trim(), password, email: email.trim() });
        await setupKeys(user.username, password).catch(() => {});
        try { localStorage.setItem('forge.lastUser', user.username); } catch { /* quota */ }
        onDone(user);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }}>
      <p className="muted small">Un administrateur vous a donné un code d'invitation : il ne sert qu'une fois.</p>
      <label className="field">
        <span>Code d'invitation</span>
        <div className="input-icon"><Ticket size={16} /><input autoFocus autoComplete="off" autoCapitalize="characters" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="FORGE-XXXX-XXXX-XXXX" /></div>
      </label>
      <label className="field">
        <span>Identifiant</span>
        <div className="input-icon"><UserIcon size={16} /><input autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={32} value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} placeholder="ex. loris" /></div>
        <small className="muted hint">2 à 32 caractères : lettres minuscules, chiffres, point, tiret, souligné.</small>
      </label>
      <label className="field">
        <span>Nom affiché <small className="muted">(facultatif)</small></span>
        <div className="input-icon"><UserIcon size={16} /><input autoComplete="nickname" maxLength={40} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Ce que vos amis verront" /></div>
      </label>
      {mail && (
        <label className="field">
          <span>Adresse e-mail <small className="muted">(facultative)</small></span>
          <div className="input-icon"><Mail size={16} /><input type="email" autoComplete="email" spellCheck={false} maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Pour récupérer votre compte" /></div>
          <small className="muted hint">Sert seulement à récupérer le compte si vous oubliez le mot de passe. Un code vous sera envoyé : vous pourrez le saisir plus tard dans Paramètres.</small>
        </label>
      )}
      <div className="field">
        <label htmlFor="reg-pw">Mot de passe</label>
        <div className="input-icon">
          <Lock size={16} />
          <input id="reg-pw" type={show ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} value={password} onChange={(e) => { setPassword(e.target.value); setCopied(false); }} placeholder={`Au moins ${PASSWORD_MIN} caractères`} />
          <button type="button" className="icon-btn" onClick={() => setShow(!show)} aria-label={show ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}>{show ? <EyeOff size={16} /> : <Eye size={16} />}</button>
        </div>
        <small className={todo.length ? 'muted hint' : 'ok hint'}>{password.length} / {PASSWORD_MIN} caractères{todo.length ? ` · il manque ${todo.join(', ')}` : ' · mot de passe valide'}</small>
        <div className="row gap wrap">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const pw = generatePassword(80); setPassword(pw); setConfirm(pw); setShow(true); setCopied(false); }}><Wand2 size={14} /> Générer un mot de passe</button>
          {password && <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard?.writeText(password).then(() => setCopied(true))}><Copy size={14} /> {copied ? 'Copié' : 'Copier'}</button>}
        </div>
      </div>
      <label className="field">
        <span>Confirmation</span>
        <div className="input-icon"><KeyRound size={16} /><input type={show ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Retapez ou collez le mot de passe" /></div>
        {mismatch && <small className="bad hint">Les deux mots de passe sont différents.</small>}
      </label>
      <p className="muted small">Gardez ce mot de passe (gestionnaire de mots de passe ou navigateur) : il n'est stocké que haché et ne peut pas être retrouvé.</p>
      {error && <p className="bad small">{error}</p>}
      <button className="btn btn-primary full" disabled={loading || !ready}>{loading ? <Loader2 size={16} className="spin" /> : 'Créer mon compte'}</button>
    </form>
  );
}
