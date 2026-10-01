import { Ban, Blend, Camera, Copy, ListEnd, Loader2, MessageCircle, Play, Radio, ShieldCheck, Shuffle, Trash2, UserMinus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { peerKeys, useKeys } from '../store/keys';
import { securityCode } from '../lib/e2e';
import { api, type MyProfile, type Profile, type ProfilePlaylist } from '../lib/api';
import type { Track } from '../lib/types';
import { formatTotal } from '../lib/format';
import { useLibrary } from '../store/library';
import { usePlayer } from '../store/player';
import { jam, people, useJam } from '../store/social';
import { useSync } from '../lib/sync';
import { useUi } from '../store/ui';
import { Cover, Mosaic } from '../components/Cover';
import { TrackList } from '../components/TrackList';
import { ago } from '../components/Friends';

const MAX_BIO = 300;
const MAX_NAME = 40;
const toast = (text: string, kind: 'info' | 'error' | 'success' = 'info') => useUi.getState().toast(text, kind);
const fail = (err: unknown) => toast((err as Error).message, 'error');

/** Profile picture, or the first letter of the name. */
export function Avatar({ src, name, size = 40 }: { src?: string | null; name: string; size?: number }) {
  return src
    ? <img className="avatar-img" src={src} alt="" width={size} height={size} style={{ width: size, height: size }} />
    : <span className="avatar" aria-hidden style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}>{name.slice(0, 1).toUpperCase()}</span>;
}

/** Profile of a friend, or one's own (with the editor). Visible to friends only (checked by the server). */
export function ProfileView() {
  const username = useUi((s) => s.view.id) || '';
  const [state, setState] = useState<{ profile: Profile | null; error: string | null }>({ profile: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api.profile(username).then((r) => live && setState({ profile: r.profile, error: null })).catch((e) => live && setState({ profile: null, error: e.message }));
    return () => { live = false; };
  }, [username, tick]);
  // Live: the person changed their profile (SSE `profile`, see store/social.ts).
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent).detail === username) setTick((t) => t + 1); };
    window.addEventListener('forge:profile', on);
    return () => window.removeEventListener('forge:profile', on);
  }, [username]);

  if (state.error) return <div className="page"><div className="empty error">{state.error}</div></div>;
  const p = state.profile;
  if (!p) return <div className="page"><div className="empty"><Loader2 className="spin" size={28} /> Chargement du profil…</div></div>;
  return (
    <div className="page profile-page">
      <div className="hero profile-hero">
        <Avatar src={p.avatar} name={p.displayName} size={160} />
        <div className="hero-info">
          <div className="muted small">{p.self ? 'MON PROFIL · visible par mes amis' : 'PROFIL'}</div>
          <h1 className="hero-title">{p.displayName}</h1>
          <div className="muted small">@{p.username}{p.friendsSince ? ` · ami depuis le ${new Date(p.friendsSince).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}` : ''}</div>
          {/* Plain text: React escapes it, never rendered as HTML. */}
          {p.bio && <p className="profile-bio">{p.bio}</p>}
        </div>
      </div>
      {!p.self && <FriendActions p={p} />}
      {p.self && <ProfileEditor onSaved={() => setTick((t) => t + 1)} />}
      <ActivityCard p={p} />
      <ProfilePlaylists p={p} />
      <SecurityCode p={p} />
    </div>
  );
}

/** Fingerprint of the message key (computed in the browser), to compare out of band like Signal. */
function SecurityCode({ p }: { p: Profile }) {
  const mine = useKeys((s) => s.fp);
  const [theirs, setTheirs] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!p.self) peerKeys(p.username, true).then((k) => setTheirs(k.current?.fp ?? null)).catch(() => setTheirs(null));
  }, [p.username, p.self]);
  const fp = p.self ? mine : theirs;
  if (fp === undefined) return null;
  return (
    <section className="settings-card security-code">
      <h2><ShieldCheck size={18} /> Code de sécurité des messages</h2>
      <p className="muted small">{p.self
        ? 'Vos amis voient ce code sur votre profil. En le comparant avec vous (de vive voix, en personne), ils vérifient que leurs messages sont bien chiffrés pour vous, et pour personne d’autre.'
        : `Comparez ce code avec celui que ${p.displayName} voit sur son propre profil (de vive voix, en personne). S’ils sont identiques, personne ne s’est glissé entre vous, pas même le serveur.`}</p>
      {fp ? <code>{securityCode(fp)}</code> : <p className="muted small">{p.self ? 'Déverrouillez vos messages (page Messages) pour afficher votre code.' : `${p.displayName} n’a pas encore activé le chiffrement des messages.`}</p>}
    </section>
  );
}

function FriendActions({ p }: { p: Profile }) {
  const navigate = useUi((s) => s.navigate);
  const inJam = useJam((s) => !!s.jam);
  const [busy, setBusy] = useState(false);
  const name = p.displayName;
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try { await fn(); if (done) toast(done, 'success'); } catch (err) { fail(err); } finally { setBusy(false); }
  };
  return (
    <div className="actions wrap">
      <button className="btn btn-primary" onClick={() => navigate({ name: 'messages', id: p.username })}><MessageCircle size={16} /> Message</button>
      <button className="btn btn-ghost" disabled={busy} onClick={() => run(async () => { if (!useJam.getState().jam) await jam.start(); await jam.invite(p.username); })}><Radio size={16} /> {inJam ? 'Inviter à l’écoute partagée' : 'Écouter ensemble'}</button>
      <button className="btn btn-ghost" onClick={() => navigate({ name: 'blend', id: p.username })}><Blend size={16} /> Mélange</button>
      <button className="btn btn-ghost" disabled={busy} onClick={() => { if (confirm(`Retirer ${name} de vos amis ?`)) run(async () => { await people.remove(p.username); navigate({ name: 'friends' }); }, `${name} n’est plus dans vos amis`); }}><UserMinus size={16} /> Retirer</button>
      <button className="btn btn-ghost danger" disabled={busy} onClick={() => {
        if (confirm(`Bloquer ${name} ? Cette personne ne pourra plus vous demander en ami ni vous écrire, et ne verra plus votre profil ni votre activité.`)) run(async () => { await people.block(p.username); navigate({ name: 'friends' }); }, `${name} est bloqué`);
      }}><Ban size={16} /> Bloquer</button>
    </div>
  );
}

function ActivityCard({ p }: { p: Profile }) {
  const playNow = usePlayer((s) => s.playNow);
  const a = p.activity;
  if (!a) return p.self ? <p className="muted small">Votre activité et vos stats ne sont pas affichées sur votre profil (réglage ci-dessus, ou « Partager mon activité d’écoute » coupé dans les paramètres).</p> : null;
  return (
    <section className="settings-card">
      <h2>Écoute</h2>
      {a.now && (
        <button className="friend-track profile-now" onClick={() => playNow(a.now!.track)} title={`Écouter « ${a.now.track.title} »`}>
          <Cover src={a.now.track.thumbnail} size={40} radius={6} />
          <span className="grow ellipsis"><b className="ellipsis">{a.now.track.title}</b><span className="muted small ellipsis">{a.now.track.author} · {a.now.live ? 'en écoute' : ago(a.now.at)}</span></span>
          <Play size={15} fill="currentColor" />
        </button>
      )}
      <p className="muted small">{a.stats.days} derniers jours : {a.stats.plays} écoute{a.stats.plays > 1 ? 's' : ''} · environ {a.stats.minutes} min</p>
      {a.stats.topArtists.length > 0 && (
        <>
          <h3 className="settings-sub">Artistes les plus écoutés</h3>
          <div className="chips">{a.stats.topArtists.map((x) => <span key={x.name} className="chip">{x.name} <span className="muted small">{x.n}</span></span>)}</div>
        </>
      )}
      {a.stats.topTracks.length > 0 && (
        <>
          <h3 className="settings-sub">Titres les plus écoutés</h3>
          <TrackList tracks={a.stats.topTracks.map((x) => x.track)} listKey={`profile-top:${p.username}`} />
        </>
      )}
    </section>
  );
}

function ProfilePlaylists({ p }: { p: Profile }) {
  const navigate = useUi((s) => s.navigate);
  const mine = useLibrary((s) => s.playlists);
  const [open, setOpen] = useState<string | null>(null);
  // Own profile: the local library is ahead of the server copy (saved a few seconds later).
  const list: ProfilePlaylist[] = p.self
    ? mine.filter((x) => x.onProfile).map((x) => ({ id: x.id, name: x.name, description: x.description, cover: x.cover, count: x.tracks.length, duration: x.tracks.reduce((a, t) => a + (t.duration || 0), 0), thumbnails: x.tracks.slice(0, 4).map((t) => t.thumbnail) }))
    : p.playlists;
  return (
    <section>
      <h2 className="section-title">Playlists{list.length ? ` (${list.length})` : ''}</h2>
      {!list.length && <p className="muted small">{p.self ? 'Aucune playlist affichée : cochez « Afficher sur mon profil » ci-dessus.' : `${p.displayName} n’affiche aucune playlist sur son profil.`}</p>}
      <div className="profile-pls">
        {list.map((pl) => (
          <button key={pl.id} className={`profile-pl ${open === pl.id ? 'active' : ''}`} onClick={() => (p.self ? navigate({ name: 'playlist', id: pl.id }) : setOpen(open === pl.id ? null : pl.id))}>
            <Mosaic covers={pl.cover ? [pl.cover] : pl.thumbnails} size={56} radius={6} />
            <span className="grow ellipsis"><b className="ellipsis">{pl.name}</b><span className="muted small">{pl.count} titre{pl.count > 1 ? 's' : ''}{pl.duration ? ` · ${formatTotal(pl.duration)}` : ''}</span></span>
          </button>
        ))}
      </div>
      {open && !p.self && <FriendPlaylist key={open} username={p.username} id={open} />}
    </section>
  );
}

/** A friend's playlist: listen, queue, or copy it into one's own library. */
function FriendPlaylist({ username, id }: { username: string; id: string }) {
  const { playList, enqueue } = usePlayer.getState();
  const [pl, setPl] = useState<{ name: string; description: string; tracks: Track[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.profilePlaylist(username, id).then((r) => setPl(r.playlist)).catch((e) => setError(e.message)); }, [username, id]);
  if (error) return <div className="empty error">{error}</div>;
  if (!pl) return <div className="empty"><Loader2 className="spin" size={22} /></div>;
  return (
    <div className="profile-open">
      <h3 className="ellipsis">{pl.name}</h3>
      {pl.description && <p className="muted small">{pl.description}</p>}
      <div className="actions wrap">
        <button className="play-btn" disabled={!pl.tracks.length} onClick={() => playList(pl.tracks)} aria-label="Lire"><Play size={22} fill="currentColor" className="nudge" /></button>
        <button className="icon-btn big" disabled={!pl.tracks.length} onClick={() => playList(pl.tracks, 0, { shuffle: true })} aria-label="Lecture aléatoire"><Shuffle size={22} /></button>
        <button className="btn btn-ghost" disabled={!pl.tracks.length} onClick={() => enqueue(pl.tracks)}><ListEnd size={16} /> File d'attente</button>
        <button className="btn btn-ghost" onClick={() => { const c = useLibrary.getState().createPlaylist(pl.name, pl.tracks); toast(`Copiée dans votre bibliothèque : « ${c.name} »`, 'success'); }}><Copy size={16} /> Copier dans ma bibliothèque</button>
      </div>
      <TrackList tracks={pl.tracks} listKey={`profile:${username}:${id}`} empty="Playlist vide." />
    </div>
  );
}

/** « Mon profil »: name, bio, picture, what friends see. */
function ProfileEditor({ onSaved }: { onSaved: () => void }) {
  const [p, setP] = useState<MyProfile | null>(null);
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [showStats, setShowStats] = useState(true);
  const [busy, setBusy] = useState(false);
  const playlists = useLibrary((s) => s.playlists);
  const updatePlaylist = useLibrary((s) => s.updatePlaylist);
  useEffect(() => { api.myProfile().then(({ profile }) => { setP(profile); setName(profile.displayName); setBio(profile.bio); setShowStats(profile.showStats); }).catch(fail); }, []);
  if (!p) return null;

  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    try { await fn(); toast(done, 'success'); onSaved(); } catch (err) { fail(err); } finally { setBusy(false); }
  };
  const save = () => run(async () => {
    const { profile } = await api.saveProfile({ displayName: name, bio, showStats });
    setP(profile);
    // The sidebar and every list show the new name.
    const user = useSync.getState().user;
    if (user) useSync.setState({ user: { ...user, displayName: profile.displayName } });
  }, 'Profil enregistré');
  const upload = (file: File | undefined) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return toast('Image PNG, JPEG ou WebP uniquement', 'error');
    if (file.size > 1024 * 1024) return toast('Image trop lourde : 1 Mo au maximum', 'error');
    run(async () => { const { avatar } = await api.uploadAvatar(file); setP({ ...p, avatar }); }, 'Photo de profil mise à jour');
  };
  const dirty = name.trim() !== p.displayName || bio.trim() !== p.bio || showStats !== p.showStats;

  return (
    <section className="settings-card profile-editor">
      <h2>Modifier mon profil</h2>
      <div className="row gap wrap">
        <Avatar src={p.avatar} name={name || p.username} size={72} />
        <label className="btn btn-ghost">
          <Camera size={16} /> {p.avatar ? 'Changer la photo' : 'Ajouter une photo'}
          <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {p.avatar && <button className="btn btn-ghost danger" disabled={busy} onClick={() => run(async () => { await api.deleteAvatar(); setP({ ...p, avatar: null }); }, 'Photo supprimée')}><Trash2 size={16} /> Supprimer</button>}
      </div>
      <p className="muted small">PNG, JPEG ou WebP, 1 Mo au maximum. Visible par vos amis seulement.</p>
      <label className="field">
        <span>Nom affiché</span>
        <input className="input" value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} aria-label="Nom affiché" />
      </label>
      <label className="field">
        <span>Biographie <span className="muted small">({bio.length}/{MAX_BIO})</span></span>
        <textarea className="input" rows={3} value={bio} maxLength={MAX_BIO} onChange={(e) => setBio(e.target.value)} placeholder="Quelques mots sur vous, vos goûts…" aria-label="Biographie" />
      </label>
      <label className="setting">
        <div className="grow">
          <div>Montrer mon activité et mes stats sur mon profil</div>
          <div className="muted small">{p.shareActivity ? 'Écoute en cours, artistes et titres les plus écoutés (28 jours)' : 'Sans effet tant que « Partager mon activité d’écoute » est coupé (Paramètres > Lecture)'}</div>
        </div>
        <span className="switch"><input type="checkbox" checked={showStats} onChange={(e) => setShowStats(e.target.checked)} /><span /></span>
      </label>
      <button className="btn btn-primary" disabled={busy || !dirty || !name.trim()} onClick={save}>{busy ? <Loader2 size={16} className="spin" /> : 'Enregistrer'}</button>

      <h3 className="settings-sub">Playlists affichées sur mon profil</h3>
      {!playlists.length ? <p className="muted small">Aucune playlist.</p> : (
        <div className="admin-list">
          {playlists.map((pl) => (
            <label key={pl.id} className="setting">
              <div className="grow ellipsis">{pl.name} <span className="muted small">· {pl.tracks.length} titre{pl.tracks.length > 1 ? 's' : ''}</span></div>
              <span className="switch"><input type="checkbox" checked={!!pl.onProfile} aria-label={`Afficher « ${pl.name} » sur mon profil`} onChange={(e) => updatePlaylist(pl.id, { onProfile: e.target.checked })} /><span /></span>
            </label>
          ))}
        </div>
      )}
    </section>
  );
}
