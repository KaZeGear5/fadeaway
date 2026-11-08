# FadeAway

Messages privés + appels vocaux / caméra / partage d'écran en **P2P (WebRTC)**.
App Windows (`.exe`) avec mises à jour automatiques et **panneau admin hébergé sur GitHub Pages**.

## Comment ça s'organise

| Morceau | Où | Rôle |
|---|---|---|
| **Panneau admin** (`admin/`) | GitHub Pages : `https://TON_PSEUDO.github.io/fadeaway/` | l'interface : utilisateurs, exclusions, dépôt des mises à jour |
| **Serveur** (`server.js`) | ton PC (+ tunnel) ou un petit serveur | MP, appels, et c'est lui qui **distribue les mises à jour** |
| **App** (.exe) | PC de chaque utilisateur | se met à jour toute seule depuis ton serveur |
| **Code + build** | dépôt GitHub | GitHub fabrique l'.exe |

Le panneau sur GitHub Pages n'est qu'une **page** : il ne stocke rien et ne contient aucun secret.
Il parle à ton serveur avec ton mot de passe admin. **Il faut donc que le serveur tourne** pour l'utiliser.

> GitHub Pages gratuit demande un dépôt **public** (le code est visible, mais jamais le mot de passe :
> il n'est que dans ta variable `ADMIN_PASSWORD`). Pages sur dépôt privé = abonnement payant.

## Étape 0 : outils (une fois)

Node.js LTS (https://nodejs.org), Git (https://git-scm.com/download/win), un compte GitHub.

## Étape 1 : mettre le code sur GitHub

1. https://github.com/new : nom `fadeaway`, **Public**, rien d'autre de coché.
2. Dans PowerShell, dans le dossier du projet :

```
git config --global user.name "KaZeGear5"
git config --global user.email "ton-email"
git init
git add .
git commit -m "Premier commit"
git branch -M main
git remote add origin https://github.com/KaZeGear5/fadeaway.git
git push -u origin main
```

## Étape 2 : activer le panneau admin

1. Sur GitHub : dépôt → **Settings → Pages → Source : GitHub Actions**.
2. Onglet **Actions** → *Admin (GitHub Pages)* → **Run workflow**.
3. Après une minute, le panneau est sur `https://kazegear5.github.io/fadeaway/`.

## Étape 3 : lancer le serveur

```
$env:ADMIN_PASSWORD="un-mot-de-passe-solide"
node server.js
```

Dans un 2e terminal, pour l'ouvrir sur Internet (tes amis + le panneau admin) :

```
cloudflared tunnel --url http://localhost:3000
```

Il affiche `https://xxxx.trycloudflare.com` : **l'adresse du serveur**. Elle change à chaque lancement.

## Étape 4 : ouvrir le panneau admin

Va sur `https://kazegear5.github.io/fadeaway/`, entre **l'adresse du serveur** (celle du tunnel) et ton **mot de passe**.
Tu peux aussi ouvrir `http://localhost:3000/admin` sur le PC qui héberge le serveur : c'est le même panneau.

## Étape 5 : fabriquer l'.exe

```
npm install
git tag v0.1.0
git push origin v0.1.0
```

Onglet **Actions** → *Build FadeAway (.exe)* (5-10 min) → ouvre l'exécution → **Artifacts** → télécharge
`fadeaway-update` → dézippe : 3 fichiers (`FadeAway-Setup-0.1.0.exe`, `latest.yml`, `.blockmap`).

## Étape 6 : publier la version

Dans le panneau admin, **glisse les 3 fichiers** dans « Mises à jour ». Donne à tes amis :
`https://adresse-du-serveur/download`.

> Le tunnel Cloudflare limite les envois à ~100 Mo (l'installeur est juste en dessous).
> Si le dépôt est refusé : dans le champ serveur du panneau, mets `http://localhost:3000`
> (le navigateur peut demander l'autorisation d'accéder au réseau local : accepte).

## Étape 7 : mettre à jour plus tard

`git add .` → `git commit -m "..."` → `git push` → `git tag v0.1.1` → `git push origin v0.1.1`
→ télécharge l'artefact → dépose les 3 fichiers dans le panneau.
Les apps vérifient à l'ouverture puis toutes les 30 min, téléchargent, et proposent de redémarrer.
**Augmente toujours le numéro de version.** Les changements de `server.js` demandent de relancer le serveur.

---

## À savoir

- **Mot de passe admin solide** : le panneau et le serveur sont joignables par quiconque connaît leurs adresses.
  5 mauvais essais = blocage 10 min ; session de 12 h.
- Les mises à jour sont du code exécuté chez tes amis : ils ne doivent se connecter qu'à **ton** serveur.
- SmartScreen : « Windows a protégé votre PC » à l'installation (exe non signé) → *Informations complémentaires → Exécuter quand même*.
- Tout est en mémoire côté serveur (MP, bannissements) ; les fichiers de mise à jour restent dans `data/`.
- Appels à deux seulement ; 4G / réseaux d'entreprise peuvent demander un serveur TURN.

## Dépannage

| Symptôme | Cause probable |
|---|---|
| Panneau : « Serveur injoignable » | serveur ou tunnel éteint, ou adresse du tunnel qui a changé |
| Panneau : « Mot de passe incorrect » | mauvais `ADMIN_PASSWORD` (sans variable, un mot de passe temporaire s'affiche dans le terminal) |
| Pages : 404 | Pages pas activé (Settings → Pages → GitHub Actions), puis relancer le workflow |
| Pas de mise à jour reçue | version non augmentée, `latest.yml` pas déposé, ou app lancée avec `npm start` |
| Dépôt refusé (413 / 502) | installeur > ~100 Mo derrière le tunnel : voir l'étape 6 |
