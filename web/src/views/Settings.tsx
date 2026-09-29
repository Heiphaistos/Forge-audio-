import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Github } from 'lucide-react';
import { ACCENTS, useSettings } from '../store/ui';
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
  ['E', 'Égaliseur'],
  ['F', 'Lecteur plein écran'],
  ['Ctrl + K ou /', 'Rechercher'],
];

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
        <p className="muted">{counts.p} playlists · {counts.l} titres likés · {counts.h} écoutes dans l'historique. Tout est enregistré localement sur cet appareil ; utilisez Exporter / Importer dans la Bibliothèque pour transférer vos données.</p>
        <button className="btn btn-ghost danger" onClick={() => {
          if (confirm('Effacer toutes les données locales (playlists, likes, historique, réglages) ?')) {
            ['forge.library', 'forge.player', 'forge.settings', 'forge.position', 'forge.recentSearches'].forEach((k) => localStorage.removeItem(k));
            location.reload();
          }
        }}>Réinitialiser Forge Audio</button>
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
