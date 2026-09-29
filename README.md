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
- **Son propre** : lecture directe par le système, sans traitement ; l'**égaliseur 10 bandes** (10 préréglages) et le **visualiseur** ne s'activent que si vous les utilisez.
- **Comptes et sauvegarde automatique** sur le serveur : playlists, likes, historique et file d'attente retrouvés sur tous vos appareils.
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

**Connexion au serveur** : dans *Paramètres → Application de bureau*, entrez l'adresse de votre serveur (ex. `https://musique.mon-vps.fr`) pour utiliser le même compte et la même bibliothèque que sur le web. Sans serveur, l'application fonctionne seule et sauvegarde la bibliothèque sur l'ordinateur.

> macOS : l'application n'est pas signée ; au premier lancement faites clic droit → **Ouvrir**.

### Publier une nouvelle version

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Le workflow **Applications de bureau** construit Windows, macOS (Intel + Apple Silicon) et Linux et joint les fichiers à la release GitHub. Il peut aussi être lancé à la main depuis l'onglet *Actions* (fichiers téléchargeables dans le run).

## 🌐 Version web (auto-hébergée)

### Docker (recommandé)

```bash
docker compose up -d --build
# → http://localhost:8787
```

Les comptes, les sessions et la bibliothèque de chaque utilisateur sont dans le volume `forge-data` (`/app/data`) : ils survivent aux mises à jour (`git pull && docker compose up -d --build`).

## 👤 Comptes et sauvegarde

- La version web demande une **connexion**. Les comptes livrés sont **evan**, **tristan**, **polo** et **lohan**. Les mots de passe (80 caractères : majuscules, minuscules, chiffres, symboles) ont été remis à part : le dépôt ne contient que leurs empreintes scrypt (`server/accounts.json`, copié dans le volume au premier démarrage).
- **Tout est sauvegardé automatiquement sur le serveur**, pour chaque compte : playlists (y compris les imports Spotify, Deezer, Apple Music, YouTube, SoundCloud), titres likés, historique, titres les plus écoutés, file d'attente et position, réglages (égaliseur, couleurs…). On retrouve tout en se reconnectant, sur n'importe quel appareil ; si deux appareils modifient en même temps, les changements sont fusionnés.
- **Aucune musique n'est stockée sur le serveur.** Les fichiers audio ouverts depuis l'ordinateur (« Fichiers locaux ») sont lus directement par le navigateur et ne sont jamais envoyés.
- Protection : mots de passe hachés (scrypt), cookie de session `HttpOnly`, blocage après 8 échecs en 15 min.

Gérer les comptes (sur le serveur) :

```bash
docker exec -it forge-audio node server/src/accounts-cli.js list
docker exec -it forge-audio node server/src/accounts-cli.js add prenom Prénom   # génère et affiche un mot de passe de 80 caractères
docker exec -it forge-audio node server/src/accounts-cli.js passwd evan         # nouveau mot de passe (déconnecte ses sessions)
docker exec -it forge-audio node server/src/accounts-cli.js remove prenom
```

Sans Docker : `npm run accounts -- list` (etc.). Sans aucun compte, le serveur fonctionne sans connexion (mode local, utilisé par l'application de bureau).

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
| `DATA_DIR` | Comptes, sessions et bibliothèques des utilisateurs | `data/` |
| `ACCOUNTS_FILE` | Fichier des comptes | `$DATA_DIR/accounts.json` |
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
