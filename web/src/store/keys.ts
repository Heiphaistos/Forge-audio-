import { create } from 'zustand';
import { api, ApiError, type PrivateMessage } from '../lib/api';
import * as e2e from '../lib/e2e';

/**
 * This device's message key (lib/e2e.ts). `ready`: messages can be read and written; `locked`: the
 * key is not on this device (new device, data cleared, session opened before 0.18) and the
 * password must be typed once in « Déverrouiller vos messages ».
 */
export const useKeys = create<{ status: 'unknown' | 'ready' | 'locked'; fp: string | null; hasServerKey: boolean; backupCode: string | null }>(
  () => ({ status: 'unknown', fp: null, hasServerKey: false, backupCode: null }),
);

/** A private message as shown: decrypted text, or why it cannot be read. */
export interface ShownMessage { id: string; from: string; at: number; text: string; fp: string; toFp: string; unreadable?: 'locked' | 'old' | 'bad' }
export const UNREADABLE = {
  locked: 'Message chiffré : déverrouillez vos messages pour le lire',
  old: 'Message chiffré avec une ancienne clé, illisible',
  bad: 'Message illisible (altéré ou clé incorrecte)',
} as const;

let me = '';
let priv: CryptoKey | null = null;
type PeerKeys = { current: { pub: string; fp: string } | null; old: { pub: string; fp: string }[] };
const peers = new Map<string, Promise<PeerKeys>>();
const convKeys = new Map<string, Promise<CryptoKey>>();

/** Another account signed in on this tab (session expired): forget everything of the previous one. */
function switchTo(username: string) {
  if (me === username) return;
  me = username;
  priv = null;
  peers.clear();
  convKeys.clear();
  useKeys.setState({ status: 'unknown', fp: null, hasServerKey: false });
}

async function adopt(username: string, pkcs8: Uint8Array, fp: string) {
  priv = await e2e.importPrivate(pkcs8);
  me = username;
  convKeys.clear();
  await e2e.saveDeviceKey(username, { priv, fp });
  useKeys.setState({ status: 'ready', fp, hasServerKey: true });
}

/** With the password (sign-in, sign-up, unlock): open the saved key, or make the first one. */
export async function setupKeys(username: string, password: string): Promise<void> {
  switchTo(username);
  const { key } = await api.myKeys();
  if (key) {
    let pkcs8;
    try { pkcs8 = await e2e.unwrapKey(key.wrapped, password, username); } catch { throw new Error('Mot de passe incorrect'); }
    return adopt(username, pkcs8, key.fp);
  }
  const id = await e2e.generateIdentity();
  const pkcs8 = await e2e.exportPrivate(id.privateKey);
  // New key: its « code de secours » is made here too and shown once (BackupCodeDialog).
  const code = e2e.generateBackupCode();
  try {
    const r = await api.putKeys(id.pub, await e2e.wrapKey(pkcs8, password, username), await e2e.wrapKey(pkcs8, e2e.normalizeBackupCode(code)!, username, 'backup'));
    await adopt(username, pkcs8, r.key.fp);
    useKeys.setState({ backupCode: code });
    return;
  } catch (err) {
    // Another device made it at the same moment: open that one.
    if (err instanceof ApiError && err.code === 'KEY_EXISTS') return setupKeys(username, password);
    throw err;
  }
}

/** App start with a session: take the key kept on this device if it is still the account's key. */
export async function initKeys(username: string) {
  switchTo(username);
  try {
    const [local, { key }] = await Promise.all([e2e.loadDeviceKey(username), api.myKeys()]);
    if (key && local && local.fp === key.fp) {
      priv = local.priv;
      useKeys.setState({ status: 'ready', fp: key.fp, hasServerKey: true });
      return;
    }
    if (local) await e2e.deleteDeviceKey(username); // replaced after a password reset
    useKeys.setState({ status: 'locked', fp: null, hasServerKey: !!key });
  } catch {
    useKeys.setState({ status: 'locked' });
  }
}

/** « Déverrouiller vos messages ». With a saved key, the password is only used here, sent nowhere. */
export async function unlockKeys(password: string) {
  // No key yet (session older than 0.18): the password is checked by signing in again first,
  // or a mistyped one would lock the new key for good.
  if (!useKeys.getState().hasServerKey) await api.login(me, password);
  await setupKeys(me, password);
}

/** Sign-out: this device forgets the key. */
export const forgetDeviceKeys = () => e2e.clearDeviceKeys();

/** Password change: the same key, re-encrypted here with the new password. */
export async function changePassword(oldPw: string, newPw: string) {
  const { key } = await api.myKeys();
  let pkcs8: Uint8Array | null = null;
  if (key) {
    try { pkcs8 = await e2e.unwrapKey(key.wrapped, oldPw, me); } catch { throw new Error('Ancien mot de passe incorrect'); }
  }
  await api.changePassword(oldPw, newPw, pkcs8 && await e2e.wrapKey(pkcs8, newPw, me));
  if (pkcs8 && key) await adopt(me, pkcs8, key.fp);
  else await setupKeys(me, newPw);
}

/** Settings: a new « code de secours » for the current key (the password opens it here, sent nowhere). */
export async function newBackupCode(password: string) {
  const { key } = await api.myKeys();
  if (!key) throw new Error('Pas encore de clé de messagerie : ouvrez Messages une fois');
  let pkcs8;
  try { pkcs8 = await e2e.unwrapKey(key.wrapped, password, me); } catch { throw new Error('Mot de passe incorrect'); }
  const code = e2e.generateBackupCode();
  await api.putBackup(key.fp, await e2e.wrapKey(pkcs8, e2e.normalizeBackupCode(code)!, me, 'backup'));
  useKeys.setState({ backupCode: code });
}

/** Forgotten password: the key opened with the « code de secours », re-wrapped with the new password. */
export async function rewrapWithBackup(backup: e2e.Wrapped, code: string, username: string, newPassword: string) {
  const norm = e2e.normalizeBackupCode(code);
  if (!norm) throw new Error('Code de secours incomplet : 24 caractères (lettres et chiffres, sans 0 ni 1)');
  let pkcs8;
  try { pkcs8 = await e2e.unwrapKey(backup, norm, username, 'backup'); } catch { throw new Error('Code de secours incorrect'); }
  return e2e.wrapKey(pkcs8, newPassword, username);
}

// ---------------------------------------------------------------- friends' keys
export function peerKeys(user: string, fresh = false): Promise<PeerKeys> {
  if (fresh || !peers.has(user)) {
    peers.set(user, api.keysOf(user).then(async (k) => ({
      // Fingerprints computed here, never taken from the server's word.
      current: k.current && { pub: k.current.pub, fp: await e2e.fingerprint(k.current.pub) },
      old: await Promise.all(k.old.map(async (o) => ({ pub: o.pub, fp: await e2e.fingerprint(o.pub) }))),
    })).catch((err) => { peers.delete(user); throw err; }));
  }
  return peers.get(user)!;
}

function convKey(other: string, theirFp: string, theirPub: string) {
  const id = `${useKeys.getState().fp}|${other}|${theirFp}`;
  if (!convKeys.has(id)) convKeys.set(id, e2e.conversationKey(priv!, theirPub, me, other));
  return convKeys.get(id)!;
}

export async function openMessage(other: string, m: PrivateMessage): Promise<ShownMessage> {
  const base = { id: m.id, from: m.from, at: m.at, fp: m.fp, toFp: m.toFp, text: '' };
  if (!priv) return { ...base, unreadable: 'locked' };
  const mine = m.from === me ? m.fp : m.toFp;
  const theirs = m.from === me ? m.toFp : m.fp;
  if (mine !== useKeys.getState().fp) return { ...base, unreadable: 'old' };
  try {
    const find = (k: PeerKeys) => (k.current?.fp === theirs ? k.current.pub : k.old.find((o) => o.fp === theirs)?.pub);
    const pub = find(await peerKeys(other)) || find(await peerKeys(other, true));
    if (!pub) return { ...base, unreadable: 'old' };
    const text = await e2e.decryptText(await convKey(other, theirs, pub), m, m.from, m.from === me ? other : me);
    return { ...base, text };
  } catch {
    return { ...base, unreadable: 'bad' };
  }
}

/** Encrypt for the friend's current key (`fresh`: ask the server again, after KEY_CHANGED). */
export async function sealFor(other: string, text: string, fresh = false) {
  if (!priv) throw new Error('Déverrouillez vos messages pour écrire');
  const k = await peerKeys(other, fresh);
  if (!k.current) throw new ApiError('Votre ami n’a pas encore activé le chiffrement des messages : il doit se reconnecter une fois', 409, 'NO_KEY');
  const sealed = await e2e.encryptText(await convKey(other, k.current.fp, k.current.pub), text, me, other);
  return { ...sealed, fp: useKeys.getState().fp!, toFp: k.current.fp };
}

// ---------------------------------------------------------------- « la clé de X a changé »
const KNOWN = () => `forge.e2e.known.${me}`;
function known(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(KNOWN()) || '{}'); } catch { return {}; }
}
/** The friend's key fingerprint seen last time on this device (first time: remembered silently). */
export function keyChanged(user: string, fp: string) {
  const k = known();
  if (!k[user]) acceptKey(user, fp);
  return !!k[user] && k[user] !== fp;
}
export function acceptKey(user: string, fp: string) {
  try { localStorage.setItem(KNOWN(), JSON.stringify({ ...known(), [user]: fp })); } catch { /* private mode */ }
}
