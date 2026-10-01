import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};
const { readResume, saveResume, resumePoint } = await import('./resume.ts');

test('resume point: saved per track, legacy bare number ignored, live and ended tracks restart', () => {
  store.set('forge.position', '93');
  assert.equal(readResume(), null, 'older versions stored seconds without the track');
  saveResume('https://www.youtube.com/watch?v=a', 90.7, 1000);
  assert.deepEqual(readResume(), { url: 'https://www.youtube.com/watch?v=a', t: 90, at: 1000 });
  assert.equal(resumePoint(90, 200), 90);
  assert.equal(resumePoint(197, 200), 0, 'saved in the last 5 s: the track had ended');
  assert.equal(resumePoint(90, 200, true), 0, 'radio: no position');
  assert.equal(resumePoint(90, null), 90, 'unknown length: trust the position');
});
