# 🔥 Forge Audio

**Votre musique, sans pub.** Un lecteur libre façon Spotify qui puise dans YouTube, YouTube Music, SoundCloud, Dailymotion, Bandcamp, Vimeo, Twitch… (plus de 1 000 sites via [yt-dlp](https://github.com/yt-dlp/yt-dlp)), avec une interface soignée, des playlists, les paroles synchronisées et la vidéo.

Disponible en **version web** (auto-hébergée) et en **application de bureau** pour **Windows, macOS et Linux**, installable ou **portable** (aucune installation).

## ✨ Fonctionnalités

- **Recherche multi-sources** : Tout / YouTube / YouTube Music / SoundCloud / Dailymotion, suggestions pendant la saisie, recherches récentes, genres à explorer.
- **Coller un lien** : une vidéo ou une playlist entière (YouTube, SoundCloud, Bandcamp…) → lecture immédiate ou import en playlist, resynchronisable.
- **Lecteur complet** : file d'attente (glisser-déposer), aléatoire, répétition (file / titre), vitesse 0,5× → 2×, minuteur de sommeil, reprise où vous vous étiez arrêté.
- **Radio / lecture automatique** : en fin de file, enchaîne sur des titres similaires (mix YouTube).
- **Vidéo synchronisée** : affichez le clip (jusqu'en 1080p) sans couper le son, en plein écran.
- **Paroles synchronisées** (LRCLIB) : cliquez une ligne pour y aller.
- **Égaliseur 10 bandes** + 10 préréglages, **visualiseur** audio.
- **Bibliothèque** : playlists (renommer, dupliquer, trier, filtrer, réordonner), titres likés, historique, les plus écoutés, export / import JSON, lecture de fichiers locaux.
- **Téléchargements** : MP3 320 kbit/s tagué, audio original, vidéo MP4.
- **Confort** : raccourcis clavier, touches multimédia du clavier / écran de verrouillage, couleurs dynamiques selon la pochette, 7 couleurs d'accent, interface mobile, installable en PWA.
- **Aucune pub, aucun compte, aucun pistage** : vos données restent sur votre appareil.

## 🖥️ Application de bureau

Téléchargez la version pour votre système dans les [Releases](https://github.com/Heiphaistos/Forge-audio-/releases) :

| Système | Installable | Portable (sans installation) |
|---|---|---|
| Windows | `ForgeAudio-x.y.z-win-x64-nsis.exe` | `ForgeAudio-x.y.z-win-portable.exe` (un seul .exe) ou le `.zip` |
| macOS (Intel / Apple Silicon) | `.dmg` | `.zip` (décompresser et lancer) |
| Linux | `.deb` | `.AppImage` (rendre exécutable et lancer) ou `.tar.gz` |

L'application embarque son serveur et ffmpeg ; **yt-dlp est téléchargé automatiquement** au premier lancement puis mis à jour tous les 3 jours. En version portable Windows, les données sont rangées dans `ForgeAudio-data` à côté de l'exécutable.

> macOS : l'application n'est pas signée ; au premier lancement faites clic droit → **Ouvrir**.

### Publier une nouvelle version

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Le workflow **Applications de bureau** construit Windows, macOS (Intel + Apple Silicon) et Linux et joint les fichiers à la release GitHub. Il peut aussi être lancé à la main depuis l'onglet *Actions* (fichiers téléchargeables dans le run).

## 🌐 Version web (auto-hébergée)

### Docker (recommandé)

```bash
ACCESS_TOKEN="un-mot-de-passe" docker compose up -d --build
# → http://localhost:8787
```

### Sans Docker

Prérequis : Node.js 20+, [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation) (`pip install -U yt-dlp`). ffmpeg est fourni par `ffmpeg-static`.

```bash
npm install
npm run build        # compile l'interface
npm start            # http://127.0.0.1:8787
```

| Variable | Rôle | Défaut |
|---|---|---|
| `PORT` / `HOST` | Adresse d'écoute | `8787` / `127.0.0.1` |
| `ACCESS_TOKEN` | Mot de passe demandé à l'ouverture (conseillé sur Internet) | aucun |
| `YTDLP_PATH` | Chemin de yt-dlp | `yt-dlp` |
| `FFMPEG_PATH` | Chemin de ffmpeg | `ffmpeg-static` puis `ffmpeg` |
| `WEB_ROOT` | Dossier de l'interface compilée | `web/dist` |

## 🛠️ Développement

```bash
npm install
npm run dev              # API (8787) + interface Vite (5173) avec rechargement
npm test                 # tests du serveur
npm run typecheck        # TypeScript de l'interface
npm run desktop:install  # dépendances Electron
npm run desktop:dev      # lance l'application de bureau
npm run desktop:dist     # construit les paquets pour le système courant
```

### Architecture

```
server/   API Fastify : recherche, résolution yt-dlp, proxy de flux avec Range (seek), transcodage HLS via ffmpeg,
          radio, paroles (LRCLIB), téléchargements, mot de passe optionnel, protection SSRF
web/      Interface React + TypeScript + Vite (Zustand), moteur audio Web Audio (égaliseur, analyseur)
desktop/  Electron : démarre le serveur en local, gère yt-dlp, construit installeurs et versions portables
```

Le navigateur annonce les codecs qu'il sait lire (Opus/WebM ou AAC/MP4) et le serveur choisit le format en conséquence. Les flux HTTP classiques sont relayés octet par octet (seek instantané) ; les flux HLS (Dailymotion…) sont transcodés à la volée.

## ⚖️ Mentions

Forge Audio ne stocke ni ne redistribue aucun contenu : il lit ce que les plateformes publient. Respectez les conditions d'utilisation des sites et le droit d'auteur, et soutenez les artistes que vous aimez. Licence MIT.
