#!/usr/bin/env bash
# Lance FadeAway en UNE commande : le serveur + le tunnel Internet.
# Au premier lancement, il te demande un mot de passe admin et le retient
# (rangé dans ~/.config/fadeaway, donc jamais envoyé sur GitHub).
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-3000}"; export PORT
PWFILE="$HOME/.config/fadeaway/admin-password"

if [ ! -s "$PWFILE" ]; then
  mkdir -p "$(dirname "$PWFILE")"
  read -rsp "Choisis ton mot de passe admin (il sera retenu) : " p; echo
  printf '%s' "$p" > "$PWFILE"
  chmod 600 "$PWFILE"
fi
ADMIN_PASSWORD="$(cat "$PWFILE")"; export ADMIN_PASSWORD

LOG="$(mktemp)"
cleanup() { kill "$SERVER" "$TUNNEL" 2>/dev/null; rm -f "$LOG"; }
trap cleanup EXIT INT TERM

node server.js &
SERVER=$!
cloudflared tunnel --url "http://localhost:$PORT" >"$LOG" 2>&1 &
TUNNEL=$!

# on attend que cloudflared annonce l'adresse publique
URL=""
for _ in $(seq 1 40); do
  URL="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG" | head -1)"
  [ -n "$URL" ] && break
  sleep 1
done

echo
echo "  ------------------------------------------------------------"
if [ -n "$URL" ]; then
  echo "  Adresse du serveur (à donner à tes amis / à mettre dans l'admin) :"
  echo "      $URL"
  if command -v xclip >/dev/null; then printf '%s' "$URL" | xclip -selection clipboard && echo "      (copiée dans le presse-papiers)"
  elif command -v xsel >/dev/null; then printf '%s' "$URL" | xsel -ib && echo "      (copiée dans le presse-papiers)"; fi
else
  echo "  Le tunnel n'a pas démarré (cloudflared est-il installé ?)."
  echo "  Le serveur marche quand même en local : http://localhost:$PORT"
fi
echo "  Panneau admin : https://kazegear5.github.io/fadeaway/"
echo "  Ctrl+C pour tout arrêter"
echo "  ------------------------------------------------------------"
echo

wait "$SERVER"
