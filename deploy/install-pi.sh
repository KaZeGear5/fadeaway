#!/usr/bin/env bash
# Installe FadeAway sur la Raspberry Pi (à lancer UNE fois, depuis le dossier du projet) :
#
#   sudo ./deploy/install-pi.sh
#
# Ce qu'il fait :
#   1. installe Node.js si besoin
#   2. enregistre le mot de passe admin (fichier privé /etc/fadeaway.env)
#   3. crée un service qui démarre au lancement de la Pi, avec des limites de mémoire/CPU
#      pour ne jamais gêner tes serveurs Minecraft
#   4. AJOUTE un bloc à ton Caddyfile (sauvegarde + vérification avant de recharger).
#      Il ne modifie rien de ce qui existe déjà.
set -euo pipefail

DOMAIN="${DOMAIN:-fadeaway.kazegear5.duckdns.org}"
PORT="${PORT:-3000}"
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
ENV_FILE="${ENV_FILE:-/etc/fadeaway.env}"
DATA_DIR="${DATA_DIR:-/var/lib/fadeaway}"
UNIT_FILE="${UNIT_FILE:-/etc/systemd/system/fadeaway.service}"
RUN_USER="${RUN_USER:-${SUDO_USER:-}}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Lance-moi avec sudo :  sudo ./deploy/install-pi.sh"
[ -n "$RUN_USER" ] && [ "$RUN_USER" != root ] && id "$RUN_USER" >/dev/null 2>&1 \
  || die "Lance-moi avec sudo depuis ton utilisateur normal (pas en root direct)."
[ -f "$APP_DIR/server.js" ] || die "server.js introuvable dans $APP_DIR"

echo "FadeAway → $DOMAIN  (utilisateur : $RUN_USER, dossier : $APP_DIR)"
echo

# ---------- 0. le port doit être libre (sauf si c'est déjà FadeAway) ----------
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; }
if ! systemctl is-active --quiet fadeaway 2>/dev/null && port_busy; then
  die "Le port $PORT est déjà utilisé par autre chose. Relance avec un autre port :  sudo PORT=3100 ./deploy/install-pi.sh"
fi

# ---------- 1. Node.js ----------
echo "1/4 Node.js"
NODE_MAJOR=0
command -v node >/dev/null 2>&1 && NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -ge 18 ]; then
  ok "Node $(node -v) déjà installé"
else
  warn "Installation de Node.js 22 (quelques minutes)…"
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  ok "Node $(node -v) installé"
fi
NODE_BIN="$(command -v node)"

# ---------- 2. mot de passe admin ----------
echo "2/4 Mot de passe admin"
if [ -s "$ENV_FILE" ] && grep -q '^ADMIN_PASSWORD=' "$ENV_FILE"; then
  ok "déjà enregistré dans $ENV_FILE (je le garde)"
else
  echo "    Tape ton mot de passe admin (10 caractères minimum, lettres/chiffres et . _ @ + = : , ! ? -)"
  echo "    ou appuie sur Entrée pour que j'en génère un solide."
  read -rsp "    Mot de passe : " PW; echo
  if [ -z "$PW" ]; then
    PW="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
    GENERATED=1
  fi
  printf '%s' "$PW" | grep -Eq '^[A-Za-z0-9._@+=:,!?-]{10,}$' \
    || die "Mot de passe refusé : 10 caractères minimum, sans espaces ni guillemets."
  umask 077
  printf 'ADMIN_PASSWORD=%s\n' "$PW" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "enregistré dans $ENV_FILE (lisible uniquement par root)"
  if [ "${GENERATED:-0}" = 1 ]; then
    echo
    echo "    ┌─ NOTE-LE MAINTENANT (affiché une seule fois) ──────────"
    echo "    │  $PW"
    echo "    └──────────────────────────────────────────────────────"
    echo
  fi
fi

# ---------- 3. service ----------
echo "3/4 Service (démarre tout seul avec la Pi)"
mkdir -p "$DATA_DIR"
chown "$RUN_USER" "$DATA_DIR"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=FadeAway (serveur)
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
Environment=DATA_DIR=$DATA_DIR
ExecStart=$NODE_BIN --max-old-space-size=160 $APP_DIR/server.js
Restart=always
RestartSec=3
# --- ne jamais gêner Minecraft : priorité basse + plafonds de ressources ---
Nice=10
CPUWeight=20
IOWeight=20
MemoryHigh=250M
MemoryMax=400M
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now fadeaway >/dev/null 2>&1 || warn "impossible de démarrer le service : sudo journalctl -u fadeaway -n 30"
systemctl restart fadeaway >/dev/null 2>&1 || true
sleep 2
if curl -fsS -m 4 -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
  ok "le serveur répond sur le port $PORT (en local uniquement : seul Caddy peut l'atteindre)"
else
  warn "le serveur ne répond pas encore : sudo journalctl -u fadeaway -n 30"
fi

# ---------- 4. Caddy ----------
echo "4/4 Caddy (HTTPS)"
BLOCK="$DOMAIN {
	reverse_proxy 127.0.0.1:$PORT {
		flush_interval -1
	}
}"
if ! command -v caddy >/dev/null 2>&1 || [ ! -f "$CADDYFILE" ]; then
  warn "Je ne trouve pas Caddy ou son fichier ($CADDYFILE)."
  echo "    Ajoute ce bloc à ta configuration Caddy, puis recharge-la :"
  echo
  printf '%s\n' "$BLOCK" | sed 's/^/        /'
  echo
elif grep -qF "$DOMAIN" "$CADDYFILE"; then
  ok "$DOMAIN est déjà dans $CADDYFILE (je n'y touche pas)"
else
  BACKUP="$CADDYFILE.bak-fadeaway-$(date +%Y%m%d-%H%M%S)"
  cp -p "$CADDYFILE" "$BACKUP"
  printf '\n# --- FadeAway (ajouté par install-pi.sh) ---\n%s\n' "$BLOCK" >> "$CADDYFILE"
  if CHECK="$(caddy validate --config "$CADDYFILE" --adapter caddyfile 2>&1)"; then
    if systemctl reload caddy 2>/dev/null; then
      ok "bloc ajouté à $CADDYFILE et Caddy rechargé (sauvegarde : $BACKUP)"
    else
      warn "bloc ajouté, mais je n'ai pas pu recharger Caddy : sudo systemctl reload caddy"
    fi
  else
    cp -p "$BACKUP" "$CADDYFILE"
    warn "Caddy a refusé la configuration : j'ai remis ton Caddyfile comme avant."
    printf '%s\n' "$CHECK" | tail -5 | sed 's/^/        /'
    echo "    Ajoute ce bloc toi-même (ou envoie-moi ton Caddyfile) :"
    printf '%s\n' "$BLOCK" | sed 's/^/        /'
  fi
fi

# ---------- vérification finale ----------
echo
echo "Vérification de https://$DOMAIN (le certificat peut mettre jusqu'à une minute)…"
CODE=000
for _ in $(seq 1 12); do
  CODE="$(curl -sS -m 6 -o /dev/null -w '%{http_code}' "https://$DOMAIN/" 2>/dev/null || true)"
  [ "$CODE" = 200 ] && break
  sleep 5
done
if [ "$CODE" = 200 ]; then
  ok "https://$DOMAIN répond. C'est en ligne !"
else
  warn "https://$DOMAIN ne répond pas encore (code $CODE). Vérifie, dans l'ordre :"
  echo "      - le nom DuckDNS pointe bien vers ton IP publique"
  echo "      - les ports 80 et 443 de la box vont vers cette Pi"
  echo "      - sudo journalctl -u caddy -n 30   (erreur de certificat ?)"
fi
echo
echo "Panneau admin : https://kazegear5.github.io/fadeaway/   (serveur : https://$DOMAIN)"
echo "Logs          : sudo journalctl -u fadeaway -f"
