/**
 * Sealed login: the web client encrypts `{ p: password, n: nonce }` with this server's RSA-OAEP
 * public key, so the password never appears in clear in the browser's network tools (screen
 * sharing, screenshots). The key lives in memory and changes at each start; each nonce is single
 * use and expires after 5 minutes, so a copied request cannot be replayed. Clients that do not
 * seal (desktop, Android) keep sending `password`, which is still accepted.
 */
import crypto from 'node:crypto';

const NONCE_TTL = 5 * 60_000;
const MAX_NONCES = 10_000;

export class LoginSeal {
  constructor() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 4096 });
    this.privateKey = privateKey;
    this.publicKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    this.nonces = new Map();
  }

  /** Public key + a fresh single-use nonce for one login attempt. */
  issue() {
    const now = Date.now();
    for (const [n, exp] of this.nonces) if (exp < now) this.nonces.delete(n);
    if (this.nonces.size >= MAX_NONCES) this.nonces.delete(this.nonces.keys().next().value);
    const nonce = crypto.randomBytes(18).toString('base64url');
    this.nonces.set(nonce, now + NONCE_TTL);
    return { key: this.publicKey, nonce };
  }

  /** Password from a sealed payload, or null if it does not decrypt, is expired or was already used. */
  open(sealed) {
    let msg;
    try {
      const plain = crypto.privateDecrypt(
        { key: this.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(String(sealed), 'base64'),
      );
      msg = JSON.parse(plain.toString('utf8'));
    } catch {
      return null;
    }
    if (typeof msg?.p !== 'string' || typeof msg.n !== 'string') return null;
    const exp = this.nonces.get(msg.n);
    this.nonces.delete(msg.n);
    return exp && exp >= Date.now() ? msg.p : null;
  }
}
