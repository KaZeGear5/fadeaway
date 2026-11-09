# FadeAway

Messagerie façon Discord, **100 % web** : comptes, messages privés, serveur, appels voix / caméra / écran en P2P.
Aucune installation obligatoire : on ouvre le site, et on peut **l'ajouter à l'écran d'accueil** (téléphone et PC) comme une vraie app.

| Quoi | Où | Rôle |
|---|---|---|
| **Le site** | ta Raspberry Pi, `https://fadeaway.kazegear5.duckdns.org` | l'app + les comptes + les messages |
| **Panneau admin** | `/admin` sur ta Pi, ou GitHub Pages (`https://kazegear5.github.io/fadeaway/`) | modération + console |
| **Code** | dépôt GitHub `KaZeGear5/fadeaway` | Pages publie `admin/` tout seul |

Il n'y a plus de `.exe` ni de mises à jour à distribuer : quand tu mets à jour la Pi, tout le monde a la nouvelle version au prochain chargement.

## Utiliser l'app

1. Ouvre le site, **Créer un compte** (e-mail, pseudo, sous-pseudo, mot de passe), puis entre le code reçu par e-mail.
2. Propose-toi en ami avec un **@sous-pseudo** (zone « Ajouter » à gauche), puis discute ou appelle.
3. **Installer** : sur PC (Chrome/Edge) bouton « 📲 Installer FadeAway » en bas de la liste ou icône d'installation dans la barre d'adresse ;
   sur Android (Chrome) idem ; sur iPhone (Safari) : Partager → *Sur l'écran d'accueil*.
4. Les appels demandent **HTTPS** (c'est le cas sur ton domaine) pour accéder au micro et à la caméra.

### Son et voix (🎧 à côté de ton profil, ou « Audio » pendant un appel)
Micro et haut-parleur au choix · **isolation de la voix** (Aucune / Standard / Forte : réduction de bruit du navigateur + filtre qui coupe ce qui n'est pas ta voix, sensibilité réglable) ·
annulation d'écho · volume automatique · qualité du son (32 / 64 / 128 kb/s) · volume des autres · **test du micro** avec jauge.
Pendant un appel, une ligne d'état dit si **ton micro envoie** et si **tu reçois sa voix** ; une bordure verte entoure celui qui parle.
Si le navigateur bloque la lecture, un bouton « Appuie ici pour activer le son » apparaît.

## Comptes, e-mails, OP et Premium

**E-mails** (sur la Pi, une seule fois) : `cd ~/fadeaway && ./deploy/setup-mail.sh` (Gmail avec mot de passe d'application, ou Brevo). Les réglages vont dans `/etc/fadeaway.env` (root seulement).
Tant que ce n'est pas fait, les codes s'affichent dans `sudo journalctl -u fadeaway -f`, et la commande `verify #n` de la console admin valide un compte à la main.

**Te donner OP** : crée ton compte (le premier est `#1`), puis dans la console du panneau admin : `op #1`. Dans l'app, 🛠️ ou la touche F2 ouvre la console OP.
Un OP peut modérer et donner le Premium, mais pas `op` / `deop` / `verify`, et ne peut pas sanctionner un autre OP.

| Commande (`<user>` = `#3`, `@sous-pseudo`) | Effet |
|---|---|
| `kick <user> [raison]` | expulse |
| `tempban <user> <durée> [raison]` · `ban <user> [raison]` · `unban <user>` | bannissement |
| `tempmute <user> <durée> [raison]` · `mute <user> [raison]` · `unmute <user>` | mute (texte) |
| `premium give <user> [durée]` · `premium take <user>` · `premium list` | FadeAway Premium |
| `op`, `deop`, `ops`, `verify`, `say <message>`, `list`, `whois <user>`, `help` | divers |

Durées : `30m`, `2h`, `7d`, `1w`. **Premium ✦** : badge, nom en dégradé animé, aura autour de la photo, avatar GIF animé, messages de 4000 caractères.

## Mettre en ligne sur la Raspberry Pi

**Sur ton PC** : `git add . && git commit -m "message" && git push`.

**Sur la Pi**, une seule fois :
```
sudo apt install -y git
git clone https://github.com/KaZeGear5/fadeaway.git
cd fadeaway
sudo ./deploy/install-pi.sh
./deploy/setup-mail.sh
```
Le script installe Node, enregistre le mot de passe admin, crée le service (priorité basse : les serveurs Minecraft ne sont pas gênés) et ajoute un bloc à
`/etc/caddy/Caddyfile` (sauvegarde + vérification, ton Caddyfile existant n'est pas modifié). Prérequis : le domaine DuckDNS pointe vers ta box et les ports 80/443 arrivent sur la Pi.

**Mettre à jour plus tard** : `cd ~/fadeaway && ./deploy/update-pi.sh`. **Logs** : `sudo journalctl -u fadeaway -f`.

## Si on ne s'entend pas en appel
1. Regarde la ligne d'état de l'appel : « ton micro n'envoie rien » → mauvais micro (ouvre 🎧 Audio, choisis-le, jauge de test) ; « aucun son reçu » → c'est l'autre côté ou le réseau.
2. « Impossible de relier vos deux appareils » = réseaux trop restrictifs (4G, entreprise). Il faut alors un **serveur TURN** : installe `coturn`, ouvre le port 3478 (UDP/TCP) et sa plage de relais,
   puis ajoute dans `/etc/fadeaway.env` : `TURN_URL=turn:fadeaway.kazegear5.duckdns.org:3478` et `TURN_SECRET=<le static-auth-secret de coturn>` ; redémarre le service. L'app le prend automatiquement.

## Dépannage
- Page blanche après une mise à jour : recharge avec Ctrl+Maj+R (le service worker prend la nouvelle version tout seul ensuite).
- Pas de mail de code : `sudo journalctl -u fadeaway -n 30`, ou `verify #n` dans la console admin.
- Admin : mot de passe dans `/etc/fadeaway.env` (`ADMIN_PASSWORD`) ; 5 essais ratés = blocage 10 min.
