# Forge Audio : API nouvelle ou modifiée depuis la 0.14.0 (serveur 0.17.0)

Référence pour adapter les clients Android et bureau. Tout le reste de l'API (recherche, lecture,
bibliothèque `/api/me/data`, catalogue, playlists partagées, Jam hors chat, Discord) est inchangé
sauf mention ci-dessous.

## Conventions

- Corps JSON (`content-type: application/json`), réponses JSON.
- Session : cookie `forge_session` (HttpOnly, SameSite=Lax, Secure en HTTPS), posé par `/api/login`
  ou `/api/register`, valable 180 jours.
- Toute route `/api/*` hors liste publique répond **401** `{ "error": "Connexion requise", "code": "AUTH_REQUIRED" }`
  sans session. Routes publiques : `/api/health`, `/api/login`, `/api/login-key`, `/api/logout`, `/api/register`.
  `/api/bot/*` : jeton `Authorization: Bearer <FORGE_BOT_TOKEN>` (HeiphaisBot), pas de session.
- Erreurs : `{ "error": "<message affichable tel quel>", "code": "<CODE>" }` avec le statut HTTP.
  Codes génériques : `BAD_REQUEST` (400), `NOT_FOUND` (404), `FORBIDDEN` (403), `RATE_LIMITED` (429), `INTERNAL` (500).
- `:username` dans une URL : identifiant de compte, `^[a-z0-9][a-z0-9._-]{1,31}$` après passage en minuscules
  et suppression des espaces autour. Format invalide : **400** `BAD_USERNAME` ; son propre identifiant : **400** `SELF`.

---

## 1. Connexion chiffrée (0.14.0)

### `GET /api/login-key` (public)
→ `200 { "key": "<clé publique SPKI DER en base64>", "nonce": "<base64url>" }`
(`{ "key": null, "nonce": null }` sur un serveur sans comptes). Clé RSA-OAEP 4096 / SHA-256, en mémoire,
change à chaque redémarrage. Nonce à usage unique, valable 5 min.

### `POST /api/login` (public) — modifié
Requête, au choix :
- `{ "username": "evan", "password": "<clair>" }` (bureau, Android : inchangé, toujours accepté) ;
- `{ "username": "evan", "sealed": "<base64>" }` où `sealed` = RSA-OAEP(SHA-256) de
  `JSON.stringify({ "p": "<mot de passe>", "n": "<nonce>" })` (446 octets max en clair).

Réponses : `200 { "ok": true, "user": { "username", "displayName", "role": "admin"|"user" } }` + cookie ;
`401 AUTH_FAILED` (mauvais identifiants, `sealed` illisible, nonce expiré ou déjà utilisé) ;
`429 RATE_LIMITED` (8 échecs / 15 min / IP).

## 2. Inscription sur invitation (0.15.0)

### `POST /api/register` (public)
Requête : `{ "code": "FORGE-XXXX-XXXX-XXXX", "username": "loris", "displayName": "Loris" (facultatif, 40 car. max),
"password": "<clair>" | "sealed": "<comme /api/login>" }`.
Mot de passe : 70 caractères minimum avec majuscule, minuscule, chiffre et symbole.

| Statut | Code | Cas |
|---|---|---|
| 201 | — | `{ "ok": true, "user": { "username", "displayName", "role": "user" } }` + cookie de session |
| 400 | `BAD_REQUEST` | mot de passe illisible (`sealed` invalide), identifiant invalide, mot de passe trop faible (message détaillé) |
| 403 | `INVITE_INVALID` | code invalide, expiré, révoqué ou déjà utilisé |
| 409 | `USERNAME_TAKEN` | identifiant pris (y compris bibliothèque d'un compte supprimé) |
| 429 | `RATE_LIMITED` | 10 essais / heure / IP (chaque essai compte, succès compris) |
| 404 | `NOT_FOUND` | serveur sans comptes |

## 3. Rôle et administration (0.15.0)

### `GET /api/me` — modifié
`200 { "user": { "username", "displayName", "role": "admin"|"user" }, "local": false, "sync": true }`
(`role` ajouté ; aussi présent dans `user` de `/api/health` et de `/api/login`).

### Routes admin (403 `FORBIDDEN` si `role` ≠ `admin`, 401 sans session)
- `GET /api/admin/invites` → `{ "invites": [Invite] }` (plus récents d'abord).
  `Invite = { id, note, createdBy, createdAt, expiresAt, usedBy|null, usedAt|null, revokedAt|null, status: "active"|"used"|"expired"|"revoked" }` (jamais le code).
- `POST /api/admin/invites` `{ "days": 1..90 (défaut 7), "note": "<100 car.>" }` → **201** `{ "code": "FORGE-…", "invite": Invite }` (le code n'est montré qu'ici).
- `DELETE /api/admin/invites/:id` → `200 { "ok": true }` ; `404 NOT_FOUND` ; `409 CONFLICT` (déjà utilisé).
- `GET /api/admin/accounts` → `{ "accounts": [{ username, displayName, role, since }] }`.

---

## 4. Amis (0.16.0, nouveau)

Rien d'automatique : demande par identifiant, l'autre accepte. Pas d'énumération des comptes :
envoyer une demande ou bloquer répond **pareil** que l'identifiant existe ou non ; une demande vers un
compte inexistant ou qui vous a bloqué est gardée dans vos « envoyées » mais n'est jamais montrée.

### `GET /api/friends`
```json
{
  "friends":  [{ "username": "polo", "displayName": "Polo", "since": 1759300000000 }],
  "incoming": [{ "username": "loan", "displayName": "Loan", "at": 1759300000000 }],
  "outgoing": [{ "username": "davy", "at": 1759300000000 }],
  "blocked":  [{ "username": "x", "at": 1759300000000 }]
}
```
`outgoing` et `blocked` ne donnent jamais le nom affiché. `incoming` exclut les comptes que vous avez bloqués.

### `POST /api/friends/requests` `{ "username": "polo" }`
- **202** `{ "status": "sent" }` : demande enregistrée (ou déjà en attente) — même réponse pour un compte inconnu.
- **200** `{ "status": "friends" }` : l'autre vous avait déjà fait une demande → vous êtes amis.
- 400 `BAD_USERNAME` / `SELF` ; 409 `ALREADY_FRIENDS` ; 409 `BLOCKED` (vous avez bloqué ce compte) ;
  400 `TOO_MANY` (100 demandes envoyées en attente) ; 429 `RATE_LIMITED` (20 demandes / heure / compte).

### `POST /api/friends/requests/:username/accept` → `200 { "ok": true }` ; 404 `NOT_FOUND` (pas de demande).
### `POST /api/friends/requests/:username/decline` → `200 { "ok": true }` ; 404 `NOT_FOUND`.
### `DELETE /api/friends/requests/:username` (annuler sa demande envoyée) → `200 { "ok": true }` ; 404 `NOT_FOUND`.
### `DELETE /api/friends/:username` (retirer un ami, des deux côtés) → `200 { "ok": true }` ; 404 `NOT_FOUND`.
### `POST /api/friends/blocks` `{ "username": "x" }` → `200 { "ok": true }` (même réponse si le compte n'existe pas)
Effets : amitié et demandes dans les deux sens supprimées ; le bloqué est retiré des playlists partagées
que vous possédez et vous des siennes ; il ne peut plus vous demander en ami (sa demande « part » mais
reste invisible), ni vous écrire, ni rejoindre votre Jam par code (404 `NO_JAM`), ni voir votre activité.
### `DELETE /api/friends/blocks/:username` → `200 { "ok": true }` ; 404 `NOT_FOUND`.

## 5. Visibilité limitée aux amis (0.16.0, modifié)

| Route | Avant | Maintenant |
|---|---|---|
| `GET /api/users` | tous les autres comptes | `{ "users": [{ username, displayName }] }` = **amis seulement** (sert aux sélecteurs partage / invitation Jam) |
| `GET /api/activity`, SSE `activity` | activité de tous | amis seulement (et `shareActivity` toujours respecté) |
| `GET /api/blend/:username` | tout compte | ami seulement ; sinon **404** `NOT_FRIENDS` « Blend possible uniquement avec vos amis » (même réponse si le compte n'existe pas) |
| `POST /api/shared`, `PATCH /api/shared/:id` (`members`) | tout compte | les **nouveaux** membres doivent être amis du propriétaire (les autres sont ignorés silencieusement, comme un compte inconnu) ; un membre qui n'est plus ami reste membre |
| `POST /api/jam/:id/invite` `{ username }` | tout compte, 400 | ami seulement ; sinon **403** `NOT_FRIENDS` (même réponse si inconnu) ; `200 { "online": bool }` |
| `POST /api/jam/join` `{ code }` | code | inchangé (le code reste une entrée explicite, comme un lien), sauf blocage hôte↔vous : 404 `NO_JAM` |
| `/api/bot/users/:discordId/activity` | tous | amis du compte lié |
| `/api/bot/users/:discordId/blend/:otherId` | tout membre lié | ami seulement : 404 `NOT_FRIENDS` |

Inchangés : les autres routes `/api/bot/*` (likes, playlists partagées du compte lié, stats, liaison),
les images `/api/covers/<user>/<fichier>` (adresse aléatoire, toute session), le lien « Partager » `/?open=<url>`.

## 6. Messages privés (0.16.0, nouveau)

Conversations à deux entre **amis**. Texte brut 1 à 1000 caractères (après suppression des caractères de
contrôle sauf retour à la ligne et tabulation, et des espaces autour) : à afficher **comme du texte**,
jamais en HTML. 500 derniers messages gardés par conversation. Débit : 30 messages / minute / compte.

`Message = { "id": "<base64url>", "from": "<username>", "text": "<texte>", "at": <ms, strictement croissant dans une conversation> }`
`Correspondent = { "username", "displayName" (= username si pas ami), "friend": bool }`

### `GET /api/messages`
→ `200 { "conversations": [{ "with": Correspondent, "last": Message, "unread": n }], "unread": total }`
(conversations non vides pour vous, la plus récente d'abord).

### `GET /api/messages/:username`
→ `200 { "with": Correspondent, "messages": [Message] (≤ 500, ordre chronologique), "readByOther": <ms lu par l'autre> }`.
Ne crée rien ; ne lit que **votre** conversation avec `:username` (inconnu = conversation vide, pas d'erreur).
Ne marque pas comme lu.

### `POST /api/messages/:username` `{ "text": "…" }`
→ **201** `{ "message": Message }` ; **403** `NOT_FRIENDS` (pas ami, bloqué, ou compte inconnu : même réponse) ;
400 `EMPTY` (vide ou pas une chaîne) ; 400 `TOO_LONG` (> 1000) ; 429 `RATE_LIMITED`.

### `POST /api/messages/:username/read` → `200 { "ok": true }` (marque lu jusqu'au dernier message).
### `DELETE /api/messages/:username` → `200 { "ok": true }`
Supprime la conversation **pour vous** ; effacée du disque dès que les deux l'ont supprimée.
Retirer un ami ou bloquer empêche d'écrire mais l'historique reste lisible par chacun.

## 7. Discussion du Jam (0.16.0, nouveau)

En mémoire seulement (200 derniers messages), perdue à la fin du Jam ou au redémarrage. Participants seulement.

- `GET /api/jam/:id/chat` → `200 { "messages": [JamMessage] }` ; 404 `NO_JAM` (pas participant ou Jam fini).
- `POST /api/jam/:id/chat` `{ "text": "…" }` → **201** `{ "message": JamMessage }` ; 404 `NO_JAM` ; 400 `EMPTY`/`TOO_LONG` ; 429 `RATE_LIMITED` (30 / minute / compte, compteur séparé des messages privés).
- `JamMessage = { id, from, displayName, text, at }`.

## 8. Temps réel : `GET /api/events` (SSE, inchangé) — nouveaux événements

Flux `text/event-stream`, une ligne `data: <JSON>` par événement, ping `: ping` toutes les 25 s.
Au (re)branchement, `{ "type": "hello" }` : recharger l'état (amis, messages, Jam…).

| `type` | Contenu | Quand / quoi faire |
|---|---|---|
| `friends` | — | une demande reçue / acceptée / refusée / annulée, ami retiré, blocage : recharger `GET /api/friends` (+ `GET /api/activity`) |
| `message` | `{ with, displayName?, message: Message }` | nouveau message dans la conversation avec `with` (envoyé par vous sur un autre appareil ou reçu ; `displayName` = nom de l'expéditeur quand c'est l'autre) |
| `message-read` | `{ with }` | vous avez lu cette conversation (autre appareil) : recharger le compteur |
| `message-read-by` | `{ with, at }` | votre ami a lu jusqu'à `at` (afficher « vu ») |
| `message-cleared` | `{ with }` | vous avez supprimé cette conversation (autre appareil) |
| `jam-chat` | `{ jamId, message: JamMessage }` | nouveau message dans le Jam |

Événements existants inchangés : `hello`, `library`, `discord`, `activity` (désormais envoyé aux amis seulement),
`shared`, `jam`, `jam-invite` (désormais seulement de la part d'un ami).

## 9. Profils (0.17.0, nouveau)

Un profil n'est visible **que par ses amis et par soi-même**. Non-ami, compte bloqué (dans un sens ou
dans l'autre), identifiant inexistant ou mal formé : **même réponse** `404 { "error": "Profil introuvable", "code": "NOT_FOUND" }`
(pas d'énumération). Même règle pour la photo et les playlists d'un profil, même avec leur adresse exacte.

`Profile = { username, displayName, bio, avatar: "/api/avatars/<user>/<fichier>"|null, self: bool,
friendsSince: <ms>|null, playlists: [ProfilePlaylist], activity: null | { now: { track, at, live }|null,
stats: { days: 28, plays, minutes, topArtists: [{ name, n }] (5), topTracks: [{ track, n }] (5) } } }`
`ProfilePlaylist = { id, name, description, cover, count, duration (s), thumbnails: [4 au plus] }`

### `GET /api/profiles/:username` → `200 { "profile": Profile }` ; 404 `NOT_FOUND`.
`activity` vaut `null` sauf si la personne a **les deux** réglages : `shareActivity` (bibliothèque, Paramètres > Lecture)
et `showStats` (profil). `playlists` = playlists de sa bibliothèque marquées `onProfile: true`.
### `GET /api/profiles/:username/playlists/:id` → `200 { "playlist": { id, name, description, cover, owner, tracks: [Track] } }`
404 si le profil n'est pas visible ou si la playlist n'est pas affichée (`onProfile` absent/faux).
### `GET /api/avatars/:username/:fichier` → l'image (`image/png|jpeg|webp`, `nosniff`, `cache-control: private, max-age=3600`)
404 si le profil n'est pas visible, ou si ce n'est pas la photo **actuelle** (ancienne adresse = 404).

### Mon profil
- `GET /api/me/profile` → `200 { "profile": { username, displayName, bio, avatar, showStats, shareActivity } }`.
- `PATCH /api/me/profile` `{ "displayName"?: "…", "bio"?: "…", "showStats"?: bool }` → `200 { "profile": … }`.
  `displayName` : 1 à 40 caractères (caractères de contrôle retirés, espaces autour retirés), enregistré dans le compte :
  nouveau nom partout (amis, messages, Jam). `bio` : texte brut 0 à 300 caractères (retours à la ligne gardés,
  caractères de contrôle/bidi retirés) — **à afficher comme du texte, jamais en HTML**. Tout est validé avant
  d'écrire quoi que ce soit : 400 `BAD_REQUEST` / `TOO_LONG`.
- `POST /api/me/avatar` corps = l'image brute, `content-type: image/png|image/jpeg|image/webp` → `200 { "avatar": "/api/avatars/…" }`.
  Type vérifié par les **octets magiques** (le `content-type` déclaré ne suffit pas) : 415 `BAD_TYPE` (SVG, GIF, autre) ;
  > 1 Mo : 413 `TOO_LARGE`. Remplace et efface l'ancienne photo ; nom de fichier aléatoire (144 bits).
- `DELETE /api/me/avatar` → `200 { "ok": true }` (fichier effacé du disque).
- Débit : 30 écritures (PATCH, POST/DELETE avatar) par heure et par compte → 429 `RATE_LIMITED`.

### Playlists affichées : champ `onProfile` dans `/api/me/data`
Chaque playlist de `library.playlists` accepte `"onProfile": true` (« Afficher sur mon profil », absent = faux).
Comme les autres champs, il passe par la synchronisation de la bibliothèque (`PUT /api/me/data`, modifier `updatedAt`).

### Temps réel
Nouvel événement SSE `{ "type": "profile", "user": "<username>" }` envoyé à la personne et à ses amis quand elle
modifie son profil : recharger `GET /api/friends` (noms) et le profil affiché.

### Divers (0.17.0)
Les erreurs « client » de Fastify ne répondent plus 500 : corps trop gros → 413 `TOO_LARGE`, `content-type` non pris
en charge → 415 `BAD_TYPE`, JSON illisible → 400 `BAD_REQUEST`.

## 10. Côté clients

- **Bureau** (`desktop/`, Electron) : charge par défaut l'interface **distante**
  `https://connect.forgeaudio.heiphaistos.org` (`win.loadURL`) : amis, messages et chat du Jam y apparaissent
  dès le déploiement du serveur, sans nouvelle version. Le mode local (sans compte) embarque le build web
  et le serveur (`desktop/app/`, `npm run prepare-app`) : pas de fonctions sociales (un seul utilisateur).
- **Android** : coque WebView sur le même serveur → idem ; pour une interface native, utiliser les routes ci-dessus.
- **Flux `/api/events`** (0.16.1) : un `EventSource` du navigateur abandonne **définitivement** après une réponse HTTP
  d'erreur (nginx renvoie 502 pendant un redémarrage du serveur). Tout client doit le rouvrir lui-même (le web : 2 s puis
  jusqu'à 30 s, et au retour au premier plan) puis, au `hello`, tout recharger.
