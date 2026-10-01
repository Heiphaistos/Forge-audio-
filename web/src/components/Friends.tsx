import { Blend, Play, Settings2 } from 'lucide-react';
import { useFriends, usePeople } from '../store/social';
import { usePlayer } from '../store/player';
import { useSettings, useUi } from '../store/ui';
import { Cover } from './Cover';

export function ago(at: number) {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 60) return 'à l’instant';
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}

/** « Activité des amis »: what friends play (live) or played last, plus a Blend with each of them. */
export function FriendsPanel() {
  const { list, loaded } = useFriends();
  const sharing = useSettings((s) => s.shareActivity);
  const navigate = useUi((s) => s.navigate);
  const playNow = usePlayer((s) => s.playNow);
  const hasFriends = usePeople((s) => s.friends.length > 0);
  return (
    <div className="panel-body friends">
      {!sharing && (
        <div className="notice small">
          Votre activité est masquée : vos amis ne voient pas ce que vous écoutez.
          <button className="link accent" onClick={() => navigate({ name: 'settings' })}><Settings2 size={13} /> Paramètres</button>
        </div>
      )}
      {loaded && !list.length && (
        <div className="empty small">
          {hasFriends ? 'Aucune activité pour l’instant. Vos amis qui partagent leur écoute apparaîtront ici.' : 'Seuls vos amis apparaissent ici.'}
          <button className="link accent" onClick={() => navigate({ name: 'friends' })}>{hasFriends ? 'Gérer mes amis' : 'Ajouter un ami'}</button>
        </div>
      )}
      {list.map((f) => (
        <div key={f.user} className="friend">
          <div className="friend-avatar" aria-hidden>{f.displayName.slice(0, 1).toUpperCase()}{f.live && <span className="live-dot" title="En écoute" />}</div>
          <div className="grow ellipsis">
            <div className="friend-head"><button className="friend-link" onClick={() => navigate({ name: 'profile', id: f.user })} title={`Profil de ${f.displayName}`}><b>{f.displayName}</b></button><span className="muted small">{f.live ? 'en écoute' : ago(f.at)}</span></div>
            <button className="friend-track ellipsis" onClick={() => playNow(f.track)} title={`Écouter « ${f.track.title} »`}>
              <Cover src={f.track.thumbnail} size={28} radius={4} /><span className="ellipsis">{f.track.title}</span><Play size={13} fill="currentColor" />
            </button>
            <div className="muted small ellipsis">{f.track.author}</div>
          </div>
          <button className="icon-btn" onClick={() => navigate({ name: 'blend', id: f.user })} aria-label={`Blend avec ${f.displayName}`} title={`Blend avec ${f.displayName}`}><Blend size={17} /></button>
        </div>
      ))}
    </div>
  );
}
