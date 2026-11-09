#!/usr/bin/env bash
# Lance FadeAway en local pour tester : ./start.sh  puis  http://localhost:3000
# (le mot de passe admin est demandé une fois, puis retenu dans ~/.config/fadeaway, jamais envoyé sur GitHub)
cd "$(dirname "$0")" || exit 1
PWFILE="$HOME/.config/fadeaway/admin-password"
if [ ! -s "$PWFILE" ]; then
  mkdir -p "$(dirname "$PWFILE")"
  read -rsp "Choisis ton mot de passe admin (il sera retenu) : " p; echo
  printf '%s' "$p" > "$PWFILE"; chmod 600 "$PWFILE"
fi
ADMIN_PASSWORD="$(cat "$PWFILE")"; export ADMIN_PASSWORD
exec node server.js
