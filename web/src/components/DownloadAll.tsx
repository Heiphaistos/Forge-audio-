import { Download, FileAudio, Loader2, Music } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { Track } from '../lib/types';
import { useUi } from '../store/ui';

/** Same limit as the server (server/src/download-batch.js). */
const MAX = 200;

/** Let the browser (or the desktop/Android shell) download a URL as a file. */
export function startDownload(href: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * « Tout télécharger »: the whole list as ONE zip, built and streamed by the server track by track.
 * Audio only (MP3 or original): a playlist of videos would not fit in a zip under 4 GiB.
 */
export function DownloadAll({ name, tracks, label = 'Tout télécharger', small }: { name: string; tracks: Track[]; label?: string; small?: boolean }) {
  const toast = useUi((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const list = tracks.filter((t) => t.source !== 'local' && !t.isLive);
  if (!list.length) return null;
  const start = async (format: 'mp3' | 'audio') => {
    setOpen(false);
    if (list.length > MAX) { toast(`${MAX} titres maximum par archive : sélectionnez-en moins (Sélectionner)`, 'error'); return; }
    setBusy(true);
    try {
      const { id } = await api.downloadBatch(name, format, list);
      toast(`Préparation de ${list.length} titre${list.length > 1 ? 's' : ''}… le téléchargement de l'archive va démarrer`);
      startDownload(api.downloadBatchUrl(id));
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dl-all" ref={ref}>
      <button className={`btn btn-ghost${small ? ' btn-sm' : ''}`} disabled={busy} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {busy ? <Loader2 size={small ? 15 : 16} className="spin" /> : <Download size={small ? 15 : 16} />} {label}
      </button>
      {open && (
        <div className="context-menu dl-all-menu" role="menu">
          <div className="menu-title">{list.length} titre{list.length > 1 ? 's' : ''} dans une archive .zip</div>
          <button role="menuitem" onClick={() => start('mp3')}><Music size={16} /> En MP3</button>
          <button role="menuitem" onClick={() => start('audio')}><FileAudio size={16} /> Audio original</button>
        </div>
      )}
    </div>
  );
}
