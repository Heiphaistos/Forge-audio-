import { createJSONStorage, type StateStorage } from 'zustand/middleware';

/**
 * localStorage with coalesced writes. zustand's persist middleware writes on every state change,
 * and the player changes state several times per second: serialising the whole queue each time
 * blocks the main thread (audible as stutter). Writes are grouped and flushed when the page hides.
 */
const pending = new Map<string, string>();
let timer: ReturnType<typeof setTimeout> | undefined;

function flush() {
  clearTimeout(timer);
  timer = undefined;
  for (const [k, v] of pending) {
    try { localStorage.setItem(k, v); } catch { /* quota or private mode */ }
  }
  pending.clear();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
}

const raw: StateStorage = {
  getItem: (k) => pending.get(k) ?? localStorage.getItem(k),
  setItem: (k, v) => {
    pending.set(k, v);
    if (!timer) timer = setTimeout(flush, 1000);
  },
  removeItem: (k) => {
    pending.delete(k);
    localStorage.removeItem(k);
  },
};

export const lazyStorage = createJSONStorage(() => raw);
export { flush as flushStorage };
