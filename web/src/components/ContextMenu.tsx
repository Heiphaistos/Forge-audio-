import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Play, ListPlus, ListEnd, ListMusic, Heart, Radio, User, Download, ExternalLink, Link2, Share2, Trash2, Film, FileAudio, EyeOff, Eye, UserX } from 'lucide-react';
import { useUi } from '../store/ui';
import { usePlayer } from '../store/player';
import { useLibrary, artistKey } from '../store/library';
import { api } from '../lib/api';
import { startDownload } from './DownloadAll';
import { shared, useJam } from '../store/social';

export function ContextMenu() {
  const menu = useUi((s) => s.menu);
  const openMenu = useUi((s) => s.openMenu);
  const openPicker = useUi((s) => s.openPicker);
  const navigate = useUi((s) => s.navigate);
  const toast = useUi((s) => s.toast);
  const { playNow, addNext, enqueue, removeAt, startRadio } = usePlayer.getState();
  const liked = useLibrary((s) => !!menu && s.liked.some((t) => t.url === menu.track.url));
  const inJam = useJam((s) => !!s.jam);
  const trackHidden = useLibrary((s) => !!menu && (s.hiddenTracks[menu.track.url]?.at || 0) > 0);
  const artistHidden = useLibrary((s) => !!menu?.track.author && (s.hiddenArtists[artistKey(menu.track.author)]?.at || 0) > 0);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const { offsetWidth: w, offsetHeight: h } = ref.current;
    setPos({ x: Math.max(8, Math.min(menu.x, window.innerWidth - w - 8)), y: Math.max(8, Math.min(menu.y, window.innerHeight - h - 8)) });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => openMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    document.querySelector('.main-scroll')?.addEventListener('scroll', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      document.querySelector('.main-scroll')?.removeEventListener('scroll', close);
    };
  }, [menu, openMenu]);

  if (!menu) return null;
  const t = menu.track;
  const act = (fn: () => void) => () => { fn(); openMenu(null); };
  const isLocal = t.source === 'local';
  const download = (format: 'mp3' | 'audio' | 'video') => act(() => {
    startDownload(api.downloadUrl(t.url, format));
    toast('Téléchargement lancé…');
  });

  return (
    <div className="menu-backdrop" onClick={() => openMenu(null)} onContextMenu={(e) => { e.preventDefault(); openMenu(null); }}>
      <div className="context-menu" ref={ref} style={{ left: pos.x, top: pos.y }} onClick={(e) => e.stopPropagation()} role="menu">
        <div className="menu-title" title={t.title}>{t.title}</div>
        <button role="menuitem" onClick={act(() => playNow(t))}><Play size={16} /> Lire maintenant</button>
        <button role="menuitem" onClick={act(() => addNext([t]))}><ListPlus size={16} /> Lire ensuite</button>
        <button role="menuitem" onClick={act(() => enqueue([t]))}><ListEnd size={16} /> {inJam ? 'Ajouter à l’écoute partagée' : 'Ajouter à la file d\'attente'}</button>
        <button role="menuitem" onClick={() => openPicker([t])}><ListMusic size={16} /> Ajouter à une playlist…</button>
        {menu.playlistId !== undefined && menu.index !== undefined && (
          <button role="menuitem" onClick={act(() => {
            const id = menu.playlistId!;
            if (id.startsWith('shared:')) shared.remove(id.slice(7), t.url).catch((err) => toast((err as Error).message, 'error'));
            else useLibrary.getState().removeFromPlaylist(id, menu.index!);
          })}><Trash2 size={16} /> Retirer de cette playlist</button>
        )}
        {menu.queueIndex !== undefined && (
          <button role="menuitem" onClick={act(() => removeAt(menu.queueIndex!))}><Trash2 size={16} /> Retirer de la file</button>
        )}
        <button role="menuitem" onClick={act(() => { const on = useLibrary.getState().toggleLike(t); toast(on ? 'Ajouté aux titres likés' : 'Retiré des titres likés', 'success'); })}>
          <Heart size={16} fill={liked ? 'currentColor' : 'none'} /> {liked ? 'Retirer des titres likés' : 'Ajouter aux titres likés'}
        </button>
        {!isLocal && <button role="menuitem" onClick={act(() => startRadio(t))}><Radio size={16} /> Lancer la radio du titre</button>}
        {t.author && <button role="menuitem" onClick={act(() => navigate({ name: 'artist', q: t.author! }))}><User size={16} /> Voir l'artiste</button>}
        {!isLocal && (
          <button role="menuitem" onClick={act(() => { useLibrary.getState().setHidden('track', t.url, `${t.title}${t.author ? ` · ${t.author}` : ''}`, !trackHidden); toast(trackHidden ? 'Titre réaffiché dans la radio et les recommandations' : 'Titre masqué : il ne sera plus proposé par la radio ni les recommandations'); })}>
            {trackHidden ? <><Eye size={16} /> Réafficher ce titre</> : <><EyeOff size={16} /> Masquer ce titre</>}
          </button>
        )}
        {t.author && (
          <button role="menuitem" onClick={act(() => { useLibrary.getState().setHidden('artist', artistKey(t.author!), t.author!, !artistHidden); toast(artistHidden ? `${t.author} de nouveau recommandé` : `${t.author} ne sera plus recommandé`); })}>
            <UserX size={16} /> {artistHidden ? `Recommander de nouveau ${t.author}` : `Ne plus recommander ${t.author}`}
          </button>
        )}
        {!isLocal && !t.isLive && (
          <>
            <div className="menu-sep" />
            <button role="menuitem" onClick={download('mp3')}><Download size={16} /> Télécharger en MP3</button>
            <button role="menuitem" onClick={download('audio')}><FileAudio size={16} /> Télécharger l'audio original</button>
            <button role="menuitem" onClick={download('video')}><Film size={16} /> Télécharger la vidéo (MP4)</button>
          </>
        )}
        {!isLocal && (
          <>
            <div className="menu-sep" />
            <button role="menuitem" onClick={act(() => window.open(t.url, '_blank', 'noopener'))}><ExternalLink size={16} /> Ouvrir la source</button>
            <button role="menuitem" onClick={act(() => shareLink(t.title, t.url))}><Share2 size={16} /> Partager</button>
            <button role="menuitem" onClick={act(() => { navigator.clipboard?.writeText(t.url).then(() => toast('Lien copié', 'success')).catch(() => toast('Copie impossible', 'error')); })}><Link2 size={16} /> Copier le lien</button>
          </>
        )}
      </div>
    </div>
  );
}

/** Share a Forge Audio link (opens the track in the player once signed in): system share sheet, else the clipboard. */
export function shareLink(title: string, url: string) {
  const link = `${location.origin}/?open=${encodeURIComponent(url)}`;
  const { toast } = useUi.getState();
  if (navigator.share) { navigator.share({ title, text: `${title} sur Forge Audio`, url: link }).catch(() => {}); return; }
  navigator.clipboard?.writeText(link).then(() => toast('Lien Forge Audio copié', 'success')).catch(() => toast('Copie impossible', 'error'));
}
