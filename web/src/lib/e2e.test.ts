// node --experimental-strip-types --test web/src/lib/e2e.test.ts (Node's Web Crypto = the browser's API)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as e2e from './e2e.ts';

test('wrap / unwrap the private key with the password; wrong password or user fails; re-wrap', async () => {
  const id = await e2e.generateIdentity();
  const pkcs8 = await e2e.exportPrivate(id.privateKey);
  const w = await e2e.wrapKey(pkcs8, 'mot de passe 1', 'evan');
  assert.equal(w.iter, 600_000);
  assert.equal(e2e.fromB64(w.salt).length, 16);
  assert.equal(e2e.fromB64(w.iv).length, 12);
  assert.deepEqual(await e2e.unwrapKey(w, 'mot de passe 1', 'evan'), pkcs8);
  await assert.rejects(e2e.unwrapKey(w, 'mot de passe 2', 'evan'), 'wrong password');
  await assert.rejects(e2e.unwrapKey(w, 'mot de passe 1', 'polo'), 'envelope bound to its account');
  await assert.rejects(e2e.unwrapKey({ ...w, iter: 1000 }, 'mot de passe 1', 'evan'), 'too few rounds refused');
  const w2 = await e2e.wrapKey(await e2e.unwrapKey(w, 'mot de passe 1', 'evan'), 'nouveau', 'evan');
  assert.notEqual(w2.salt, w.salt);
  assert.deepEqual(await e2e.unwrapKey(w2, 'nouveau', 'evan'), pkcs8);
  await assert.rejects(e2e.unwrapKey(w2, 'mot de passe 1', 'evan'));
  // Non-extractable once imported
  const k = await e2e.importPrivate(pkcs8);
  assert.equal(k.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('pkcs8', k));
});

test('messages: same key on both sides, round trip, fresh IV, wrong key / tampering / direction fail', async () => {
  const a = await e2e.generateIdentity();
  const b = await e2e.generateIdentity();
  const c = await e2e.generateIdentity();
  const kab = await e2e.conversationKey(a.privateKey, b.pub, 'evan', 'polo');
  const kba = await e2e.conversationKey(b.privateKey, a.pub, 'polo', 'evan');
  const text = 'Salut 👋 <b>é</b>\nligne 2';
  const m = await e2e.encryptText(kab, text, 'evan', 'polo');
  assert.equal(await e2e.decryptText(kba, m, 'evan', 'polo'), text);
  assert.ok(!m.ct.includes('Salut') && !atob(m.ct).includes('Salut'));
  const again = await e2e.encryptText(kab, text, 'evan', 'polo');
  assert.notEqual(again.iv, m.iv, 'new IV per message');
  assert.notEqual(again.ct, m.ct);
  const kcb = await e2e.conversationKey(c.privateKey, b.pub, 'lohan', 'polo');
  await assert.rejects(e2e.decryptText(kcb, m, 'evan', 'polo'), 'another key');
  await assert.rejects(e2e.decryptText(kba, m, 'polo', 'evan'), 'turned around');
  const bytes = e2e.fromB64(m.ct);
  bytes[0] ^= 1;
  await assert.rejects(e2e.decryptText(kba, { ...m, ct: e2e.toB64(bytes) }, 'evan', 'polo'), 'tampered');
  const big = 'é'.repeat(1000);
  assert.equal(await e2e.decryptText(kba, await e2e.encryptText(kab, big, 'evan', 'polo'), 'evan', 'polo'), big);
});

test('fingerprint and security code', async () => {
  const a = await e2e.generateIdentity();
  const fp = await e2e.fingerprint(a.pub);
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.equal(e2e.securityCode(fp).split(' ').length, 16);
});
