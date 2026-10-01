/**
 * End-to-end encryption of private messages, Web Crypto only (no crypto code of our own).
 *
 * - Identity: ECDH P-256 key pair made in the browser. The public key goes to the server; the
 *   private key goes there only ENCRYPTED: AES-GCM 256 with a key derived from the password
 *   (PBKDF2-SHA-256, 600 000 rounds, random 16-byte salt). On this device it is kept as a
 *   non-extractable CryptoKey in IndexedDB.
 * - Conversation key: ECDH(my private key, friend's public key) → HKDF-SHA-256 (info = both
 *   usernames, sorted) → AES-GCM 256. Each message: random 12-byte IV; the authenticated data binds
 *   sender and recipient, so the server cannot turn a message around or move it elsewhere.
 *
 * No DOM or app import here: tested under Node (e2e.test.ts).
 */
export const ITERATIONS = 600_000;
export const VERSION = 1;

export interface Wrapped { v: 1; iter: number; salt: string; iv: string; ct: string }
export interface Sealed { v: 1; iv: string; ct: string }

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
type Bytes = Uint8Array;

export function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin);
}
export const fromB64 = (s: string): Bytes => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) as Bytes;
const random = (n: number): Bytes => globalThis.crypto.getRandomValues(new Uint8Array(n)) as Bytes;

/** New identity. The private key is extractable only so it can be wrapped once, then dropped. */
export async function generateIdentity(): Promise<{ privateKey: CryptoKey; pub: string }> {
  const pair = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  return { privateKey: pair.privateKey, pub: toB64(await subtle().exportKey('raw', pair.publicKey)) };
}

/** SHA-256 of the raw public key, hex (the server computes the same). */
export async function fingerprint(pub: string): Promise<string> {
  const h = new Uint8Array(await subtle().digest('SHA-256', fromB64(pub)));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** « Code de sécurité » shown to compare out of band: 16 groups of 4 characters. */
export const securityCode = (fp: string) => fp.toUpperCase().match(/.{4}/g)?.join(' ') ?? '';

async function passwordKey(password: string, salt: Bytes, iter: number) {
  const base = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const wrapAad = (username: string) => enc.encode(`forge-audio key v1|${username}`);

/** Encrypt the private key (PKCS#8) with the password. */
export async function wrapKey(pkcs8: Bytes, password: string, username: string): Promise<Wrapped> {
  const salt = random(16);
  const iv = random(12);
  const key = await passwordKey(password, salt, ITERATIONS);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: wrapAad(username) }, key, pkcs8);
  return { v: 1, iter: ITERATIONS, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) };
}

/** PKCS#8 of the private key; throws (AES-GCM check) if the password is wrong. */
export async function unwrapKey(w: Wrapped, password: string, username: string): Promise<Bytes> {
  if (w.v !== 1 || w.iter < ITERATIONS) throw new Error('Enveloppe de clé inconnue');
  const key = await passwordKey(password, fromB64(w.salt), w.iter);
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(w.iv), additionalData: wrapAad(username) }, key, fromB64(w.ct))) as Bytes;
}

export const exportPrivate = async (k: CryptoKey) => new Uint8Array(await subtle().exportKey('pkcs8', k)) as Bytes;
/** Non-extractable from here on: even this app's code cannot read it back. */
export const importPrivate = (pkcs8: Bytes) => subtle().importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);

/** AES-GCM key of the conversation between `a` and `b` (same on both sides). */
export async function conversationKey(myPrivate: CryptoKey, theirPub: string, a: string, b: string): Promise<CryptoKey> {
  const pub = await subtle().importKey('raw', fromB64(theirPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await subtle().deriveBits({ name: 'ECDH', public: pub }, myPrivate, 256);
  const hkdf = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const [x, y] = [a, b].sort();
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode(`forge-audio dm v1|${x}|${y}`) },
    hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}
const msgAad = (from: string, to: string) => enc.encode(`forge-audio msg v1|${from}|${to}`);

export async function encryptText(key: CryptoKey, text: string, from: string, to: string): Promise<Sealed> {
  const iv = random(12); // fresh for every message
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: msgAad(from, to) }, key, enc.encode(text));
  return { v: 1, iv: toB64(iv), ct: toB64(ct) };
}

/** Throws if the key is wrong or the message was altered (AES-GCM tag). */
export async function decryptText(key: CryptoKey, m: Sealed, from: string, to: string): Promise<string> {
  const plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(m.iv), additionalData: msgAad(from, to) }, key, fromB64(m.ct));
  return new TextDecoder().decode(plain);
}

// ---------------------------------------------------------------- this device (IndexedDB)
// Private mode or blocked storage: every call fails quietly, the key then lives in memory only.
interface DeviceKey { priv: CryptoKey; fp: string }

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('forge-e2e', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
  try {
    const d = await db();
    return await new Promise<T>((resolve, reject) => {
      const req = run(d.transaction('keys', mode).objectStore('keys'));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    }).finally(() => d.close());
  } catch {
    return null;
  }
}
export const loadDeviceKey = (username: string) => tx<DeviceKey>('readonly', (s) => s.get(username));
export const saveDeviceKey = (username: string, k: DeviceKey) => tx('readwrite', (s) => s.put(k, username));
export const deleteDeviceKey = (username: string) => tx('readwrite', (s) => s.delete(username));
export const clearDeviceKeys = () => tx('readwrite', (s) => s.clear());
