import { CircleArrowDown, CloudOff, Heart, ListMusic, Loader2, Play, Shuffle, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useOffline, toggleSet, setLimit, cancelAll, clearOffline, LIMITS_MB } from '../store/offline';
import { offlineEligible, formatBytes } from '../lib/offline-plan';
import { useLibrary } from '../store/library';
import { usePlayer } from '../store/player';
import { useUi } from '../store/ui';
import { TrackList } from '../components/TrackList';
import type { Track } from '../lib/types';

/** « Télécharger » on the liked tracks or a playlist: keeps the whole collection offline, new titles included. */
export function OfflineButton({ set, tracks, name }: { set: string; tracks: Track[]; name: string }) {
  const on = useOffline((s) => s.sets.includes(set));
  const eligible = useMemo(() => tracks.filter(offlineEligible), [tracks]);
  const done = useOffline((s) => eligible.reduce((n, t) => n + (s.items[t.url] ? 1 : 0), 0));
  const label = !on ? 'Télécharger' : done < eligible.length ? `Téléchargement ${done}/${eligible.length}` : 'Disponible hors ligne';
  return (
    <button className={`btn btn-ghost offline-btn ${on ? 'on' : ''}`} disabled={!on && !eligible.length} aria-pressed={on}
      title={on ? 'Retirer de l’écoute hors ligne' : 'Garder ces titres sur cet appareil pour les écouter sans connexion'}
      onClick={() => {
        if (!on) { toggleSet(set, true); useUi.getState().toast(`« ${name} » sera disponible hors ligne`, 'success'); }
        else if (confirm(`Retirer « ${name} » de l’écoute hors ligne ? Les titres téléchargés pour elle seront effacés de cet appareil.`)) toggleSet(set, false);
      }}>
      {on && done < eligible.length ? <Loader2 size={16} className="spin" /> : <CircleArrowDown size={16} />} {label}
    </button>
  );
}

function Progress() {
  const active = useOffline((s) => s.active);
  const waiting = useOffline((s) => s.queue.length);
  const full = useOffline((s) => s.full);
  const online = useOffline((s) => s.online);
  if (!active && !waiting) return null;
  const pct = active?.total ? Math.min(100, Math.round((active.loaded / active.total) * 100)) : null;
  return (
    <div className="offline-progress" role="status">
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ellipsis">{active ? <>Téléchargement : <b>{active.title}</b> {pct !== null ? `${pct} %` : formatBytes(active.loaded)}</> : full ? 'En pause : espace hors ligne plein' : online ? 'En attente…' : 'En pause : pas de connexion'}</div>
        <div className="muted small">{waiting ? `${waiting} titre${waiting > 1 ? 's' : ''} en attente` : 'Dernier titre'}</div>
        <div className="offline-bar"><i style={{ width: `${pct ?? 0}%` }} /></div>
      </div>
      <button className="btn btn-ghost btn-sm" onClick={cancelAll}><X size={14} /> Annuler</button>
    </div>
  );
}

export function OfflineView() {
  const online = useOffline((s) => s.online);
  const items = useOffline((s) => s.items);
  const sets = useOffline((s) => s.sets);
  const limitMb = useOffline((s) => s.limitMb);
  const ready = useOffline((s) => s.ready);
  const liked = useLibrary((s) => s.liked);
  const playlists = useLibrary((s) => s.playlists);
  const { playList } = usePlayer.getState();
  const tracks = useMemo(() => Object.values(items).sort((a, b) => b.at - a.at).map((i) => i.track), [items]);
  const used = useMemo(() => Object.values(items).reduce((a, i) => a + i.size, 0), [items]);
  const [free, setFree] = useState<number | null>(null);
  useEffect(() => { navigator.storage?.estimate?.().then((e) => setFree(e.quota != null && e.usage != null ? e.quota - e.usage : null), () => {}); }, [used]);
  const nameOf = (set: string) => (set === 'liked' ? 'Titres likés' : playlists.find((p) => `pl:${p.id}` === set)?.name || 'Playlist');
  const tracksOf = (set: string) => (set === 'liked' ? liked : playlists.find((p) => `pl:${p.id}` === set)?.tracks || []);

  return (
    <div className="page">
      <div className="hero">
        <div className="hero-cover offline-gradient"><CircleArrowDown size={72} /></div>
        <div className="hero-info">
          <div className="muted small">SUR CET APPAREIL</div>
          <h1 className="hero-title">Hors ligne</h1>
          <div className="muted small">{tracks.length} titre{tracks.length > 1 ? 's' : ''} · {formatBytes(used)} sur {formatBytes(limitMb * 1024 * 1024)}</div>
        </div>
      </div>
      {!online && (
        <div className="jam-banner offline-banner" role="status"><CloudOff size={15} /><span className="grow">Pas de connexion au serveur : seuls les titres téléchargés sont proposés. Le reste revient tout seul dès que la connexion revient.</span></div>
      )}
      <div className="actions">
        <button className="play-btn big" disabled={!tracks.length} onClick={() => playList(tracks)} aria-label="Lire"><Play size={26} fill="currentColor" className="nudge" /></button>
        <button className="icon-btn big" disabled={!tracks.length} onClick={() => playList(tracks, 0, { shuffle: true })} aria-label="Lecture aléatoire"><Shuffle size={24} /></button>
      </div>
      <Progress />
      {sets.length > 0 && (
        <div className="chips offline-sets">
          {sets.map((set) => {
            const all = tracksOf(set).filter(offlineEligible);
            const done = all.filter((t) => items[t.url]).length;
            return (
              <span key={set} className="chip offline-set">
                {set === 'liked' ? <Heart size={13} fill="currentColor" /> : <ListMusic size={13} />}
                <span className="ellipsis">{nameOf(set)}</span><span className="muted">{done}/{all.length}</span>
                <button className="icon-btn" aria-label={`Retirer ${nameOf(set)} de l’écoute hors ligne`} onClick={() => { if (confirm(`Retirer « ${nameOf(set)} » de l’écoute hors ligne ?`)) toggleSet(set, false); }}><X size={13} /></button>
              </span>
            );
          })}
        </div>
      )}
      {!ready ? <div className="empty"><Loader2 className="spin" size={28} /></div> : (
        <TrackList tracks={tracks} listKey="offline" empty={<>
          <CircleArrowDown size={36} />
          <span>Aucun titre téléchargé sur cet appareil.</span>
          <span className="small">{online ? 'Touchez « Télécharger » sur vos titres likés ou une playlist, ou « Disponible hors ligne » dans le menu d’un titre.' : 'Revenez ici une fois connecté pour en télécharger.'}</span>
        </>} />
      )}
      <section className="settings-card" style={{ marginTop: 24 }}>
        <h2>Espace</h2>
        <div className="setting">
          <div className="grow">Limite de stockage<div className="muted small">{formatBytes(used)} utilisés{free !== null ? ` · ${formatBytes(free)} encore libres sur l’appareil` : ''}</div></div>
          <select className="select" value={limitMb} onChange={(e) => setLimit(Number(e.target.value))} aria-label="Limite de stockage hors ligne">
            {LIMITS_MB.map((mb) => <option key={mb} value={mb}>{formatBytes(mb * 1024 * 1024)}</option>)}
          </select>
        </div>
        <p className="muted small">Les titres sont lus depuis cet appareil même quand vous êtes connecté (aucune donnée consommée). Ils sont effacés à la déconnexion.</p>
        <button className="btn btn-ghost danger" disabled={!tracks.length && !sets.length} onClick={() => { if (confirm('Effacer tous les titres téléchargés sur cet appareil ?')) void clearOffline(); }}><Trash2 size={16} /> Tout supprimer</button>
      </section>
    </div>
  );
}
