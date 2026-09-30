import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Github, Loader2 } from 'lucide-react';
import { ACCENTS, useSettings, useUi } from '../store/ui';
import { discord, useDiscord, useJam } from '../store/social';
import { useLibrary } from '../store/library';
import { api, type Health } from '../lib/api';
import { SOURCE_LABELS } from '../lib/format';

export const SHORTCUTS: [string, string][] = [
  ['Espace', 'Lecture / pause'],
  ['Maj + → / ←', 'Titre suivant / précédent'],
  ['→ / ←', 'Avancer / reculer de 10 s'],
  ['↑ / ↓', 'Volume + / −'],
  ['M', 'Couper le son'],
  ['S', 'Lecture aléatoire'],
  ['R', 'Mode de répétition'],
  ['L', 'Paroles'],
  ['Q', "File d'attente"],
  ['V', 'Vidéo'],
  ['I', 'Lecteur vidéo réduit'],
  ['E', 'Égaliseur'],
  ['J', 'Ajouter aux titres likés / retirer'],
  ['F', 'Lecteur plein écran'],
  ['Ctrl + K ou /', 'Rechercher'],
];

/** Desktop app only: use the built-in local player or connect to a Forge Audio server (same account as the web). */
function DesktopServer() {
  const bridge = window.forgeDesktop;
  const [current, setCurrent] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { bridge?.getServer().then((u) => { setCurrent(u); setUrl(u || ''); }).catch(() => {}); }, [bridge]);
  if (!bridge) return null;
  const apply = async (value: string | null) => {
    setBusy(true);
    setError(null);
    try { await bridge.setServer(value); } catch (err) { setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); setBusy(false); }
  };
  return (
    <section className="settings-card">
      <h2>Application de bureau</h2>
      <p className="muted">
        {current ? <>Connecté au serveur <b>{current}</b> : même compte et même bibliothèque que sur le web.</> : 'Lecteur local : la bibliothèque est enregistrée sur cet ordinateur.'}
      </p>
      <form className="row gap wrap" onSubmit={(e) => { e.preventDefault(); apply(url); }}>
        <input className="input grow" placeholder="https://musique.mon-vps.fr" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Adresse du serveur" />
        <button className="btn btn-primary" disabled={busy || !url.trim()}>{busy ? <Loader2 size={16} className="spin" /> : 'Se connecter au serveur'}</button>
        {current && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => apply(null)}>Revenir au lecteur local</button>}
      </form>
      {error && <p className="bad small">{error}</p>}
    </section>
  );
}

const DESKTOP_RELEASES = 'https://github.com/Heiphaistos/Forge-audio-/releases/latest';
export const MOBILE_RELEASES = 'https://github.com/Heiphaistos/Forge-Audio-Android/releases/latest';

const inMobileApp = () => /ForgeAudioApp/.test(navigator.userAgent);
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

/** Inside the Android / iOS app: go back to the bundled server setup screen. */
/** « Masquer ce titre » / « Ne plus recommander » : list, and show again. */
function HiddenCard() {
  const tracks = useLibrary((st) => st.hiddenTracks);
  const artists = useLibrary((st) => st.hiddenArtists);
  const on = (m: Record<string, { at: number; label: string }>) => Object.entries(m).filter(([, v]) => v.at > 0).sort((x, y) => y[1].at - x[1].at);
  const list = [...on(artists).map(([k, v]) => ({ kind: 'artist' as const, k, v })), ...on(tracks).map(([k, v]) => ({ kind: 'track' as const, k, v }))];
  if (!list.length) return null;
  return (
    <section className="settings-card">
      <h2>Masqués de la radio et des recommandations</h2>
      <ul className="hidden-list">
        {list.map(({ kind, k, v }) => (
          <li key={`${kind}:${k}`}>
            <span className="grow ellipsis">{kind === 'artist' ? '👤 ' : '🎵 '}{v.label || k}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => useLibrary.getState().setHidden(kind, k, v.label, false)}>Réafficher</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Link with HeiphaisBot: same liked tracks in Discord (❤️ J'aime) and in Forge Audio. */
function DiscordLinkCard() {
  const { link, botEnabled } = useDiscord();
  const social = useJam((st) => !!st.me);
  const toast = useUi((st) => st.toast);
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  useEffect(() => { if (social) discord.refresh().catch(() => {}); }, [social]);
  useEffect(() => { if (link) setCode(null); }, [link]);
  if (!social || !botEnabled) return null;
  return (
    <section className="settings-card">
      <h2>Discord (HeiphaisBot)</h2>
      {link ? (
        <>
          <p className="muted">Lié au compte Discord <b>{link.discordName || link.discordId}</b>. Un ❤️ <b>J'aime</b> dans le lecteur du bot ajoute le titre à vos titres likés ici, et la playlist « Titres likés » du bot est celle de Forge Audio.</p>
          <button className="btn btn-ghost danger" onClick={() => discord.unlink().then(() => toast('Compte Discord délié')).catch((e) => toast(e.message, 'error'))}>Délier</button>
        </>
      ) : code ? (
        <>
          <p className="muted">Dans Discord, sur un serveur où se trouve HeiphaisBot, tapez :</p>
          <p className="discord-code"><code>/playlist forgeaudio code:{code.code}</code></p>
          <p className="muted small">Code valable 10 minutes, utilisable une seule fois.</p>
          <button className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard?.writeText(`/playlist forgeaudio code:${code.code}`).then(() => toast('Commande copiée', 'success'))}>Copier la commande</button>
        </>
      ) : (
        <>
          <p className="muted">Liez votre compte Discord pour avoir les mêmes titres likés dans Forge Audio et dans le lecteur du bot Discord.</p>
          <button className="btn btn-primary" onClick={() => discord.code().then(setCode).catch((e) => toast(e.message, 'error'))}>Lier mon compte Discord</button>
        </>
      )}
    </section>
  );
}

function MobileServer() {
  if (!inMobileApp()) return null;
  const local = isIos() ? 'capacitor://localhost' : 'https://localhost';
  return (
    <section className="settings-card">
      <h2>Application mobile</h2>
      <p className="muted">Connecté au serveur <b>{location.origin}</b>. La musique continue écran verrouillé ou dans une autre application, avec les commandes dans la notification et sur l'écran de verrouillage.</p>
      <a className="btn btn-ghost" href={`${local}/?change=1`}>Changer de serveur</a>
    </section>
  );
}

/** In a browser: links to the desktop and mobile apps (background playback, tray, notifications). */
function DownloadApps() {
  if (inMobileApp() || window.forgeDesktop) return null;
  return (
    <section className="settings-card">
      <h2>Applications</h2>
      <p className="muted">Un navigateur fermé arrête la musique. Les applications, elles, continuent en arrière-plan : zone de notification sur ordinateur, notification et écran de verrouillage sur téléphone.</p>
      <div className="row gap wrap">
        <a className="btn btn-primary" href={MOBILE_RELEASES} target="_blank" rel="noreferrer">Android (APK)</a>
        <a className="btn btn-ghost" href={MOBILE_RELEASES} target="_blank" rel="noreferrer">iPhone / iPad</a>
        <a className="btn btn-ghost" href={DESKTOP_RELEASES} target="_blank" rel="noreferrer">Windows · macOS · Linux</a>
      </div>
    </section>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="setting">
      <div className="grow">
        <div>{label}</div>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      <span className="switch"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /><span /></span>
    </label>
  );
}

export function Settings() {
  const s = useSettings();
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const counts = {
    p: useLibrary((st) => st.playlists.length),
    l: useLibrary((st) => st.liked.length),
    h: useLibrary((st) => st.history.length),
  };

  useEffect(() => { api.health().then(setHealth).catch((e) => setHealthError(e.message)); }, []);

  return (
    <div className="page settings">
      <h1 className="page-title">Paramètres</h1>

      <section className="settings-card">
        <h2>Apparence</h2>
        <div className="setting">
          <div className="grow">Couleur d'accent</div>
          <div className="swatches">
            {Object.entries(ACCENTS).map(([name, rgb]) => (
              <button key={name} className={`swatch ${s.accent === name ? 'active' : ''}`} style={{ background: `rgb(${rgb})` }} title={name} aria-label={name} onClick={() => s.set({ accent: name })} />
            ))}
          </div>
        </div>
        <Toggle checked={s.dynamicColors} onChange={(v) => s.set({ dynamicColors: v })} label="Couleurs dynamiques" hint="Teinte l'interface selon la pochette en cours de lecture" />
        <Toggle checked={s.visualizer} onChange={(v) => s.set({ visualizer: v })} label="Visualiseur audio" hint="Barres de fréquences animées dans le lecteur" />
      </section>

      <section className="settings-card">
        <h2>Lecture</h2>
        <div className="setting">
          <div className="grow">Source de recherche par défaut</div>
          <select className="select" value={s.defaultSource} onChange={(e) => s.set({ defaultSource: e.target.value })}>
            {['all', 'youtube', 'ytmusic', 'soundcloud', 'dailymotion'].map((k) => <option key={k} value={k}>{SOURCE_LABELS[k]}</option>)}
          </select>
        </div>
        <Toggle checked={s.autoplay} onChange={(v) => s.set({ autoplay: v })} label="Lecture automatique" hint="Quand la file est terminée, enchaîne sur des titres similaires (radio)" />
        <Toggle checked={s.eqEnabled} onChange={(v) => s.set({ eqEnabled: v })} label="Égaliseur activé" hint={`Préréglage : ${s.eqPreset}`} />
      </section>

      <DesktopServer />
      <MobileServer />
      <DiscordLinkCard />
      <HiddenCard />
      <DownloadApps />

      <section className="settings-card">
        <h2>Serveur</h2>
        {health ? (
          <>
            <div className="setting"><div className="grow">Forge Audio</div><span className="muted">v{health.version}</span></div>
            <div className="setting">
              <div className="grow">yt-dlp</div>
              {health.ytdlp ? <span className="ok"><CheckCircle2 size={16} /> {health.ytdlp}</span> : <span className="bad"><XCircle size={16} /> introuvable</span>}
            </div>
          </>
        ) : <p className={healthError ? 'bad' : 'muted'}>{healthError || 'Vérification…'}</p>}
        <p className="muted small">Sources prises en charge : YouTube, YouTube Music, SoundCloud, Dailymotion, Bandcamp, Vimeo, Twitch et plus de 1 000 sites via les liens (yt-dlp).</p>
      </section>

      <section className="settings-card">
        <h2>Données</h2>
        <p className="muted">{counts.p} playlists · {counts.l} titres likés · {counts.h} écoutes dans l'historique. Tout est sauvegardé automatiquement sur le serveur et retrouvé à chaque connexion, sur tous vos appareils. Les fichiers audio locaux sont lus depuis votre appareil et ne sont jamais envoyés.</p>
        <button className="btn btn-ghost danger" onClick={() => {
          if (confirm('Vider le cache de cet appareil ? Votre bibliothèque sauvegardée sur le serveur sera rechargée.')) {
            ['forge.library', 'forge.player', 'forge.settings', 'forge.position', 'forge.recentSearches'].forEach((k) => localStorage.removeItem(k));
            location.reload();
          }
        }}>Vider le cache de cet appareil</button>
      </section>

      <section className="settings-card">
        <h2>Raccourcis clavier</h2>
        <div className="shortcuts">
          {SHORTCUTS.map(([k, d]) => <div key={k} className="shortcut"><kbd>{k}</kbd><span>{d}</span></div>)}
        </div>
      </section>

      <section className="settings-card">
        <h2>À propos</h2>
        <p className="muted">Forge Audio est un lecteur libre et sans publicité. Le contenu appartient à ses auteurs : soutenez les artistes que vous aimez.</p>
        <a className="btn btn-ghost" href="https://github.com/Heiphaistos/Forge-audio-" target="_blank" rel="noreferrer"><Github size={16} /> Code source</a>
      </section>
    </div>
  );
}
