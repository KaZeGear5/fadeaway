#!/usr/bin/env bash
# Active « Continuer avec Discord » :
#   ./deploy/setup-oauth.sh
# Les identifiants sont écrits dans /etc/fadeaway.env (lisible par root seulement), jamais dans le code.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-/etc/fadeaway.env}"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
DEFAULT_URL="https://fadeaway.kazegear5.duckdns.org"

P=DISCORD; NAME=Discord

read -rp "Adresse publique du site [$DEFAULT_URL] : " URL_; URL_="${URL_:-$DEFAULT_URL}"; URL_="${URL_%/}"
case "$URL_" in https://*) ;; *) echo "L'adresse doit commencer par https://"; exit 1 ;; esac
echo
echo "→ Dans la console $NAME, l'adresse de redirection à autoriser est EXACTEMENT :"
echo "    $URL_/auth/$(echo "$NAME" | tr 'A-Z' 'a-z')/callback"
echo

ID=""; while [ -z "$ID" ]; do read -rp "ID client ($NAME) : " ID; done
SECRET=""; while [ -z "$SECRET" ]; do read -rsp "Secret client ($NAME, caché, colle puis Entrée) : " SECRET; echo; done
case "$ID$SECRET$URL_" in *\"*|*\\*|*" "*) echo "Caractère interdit (espace, guillemet ou antislash)."; exit 1 ;; esac
echo "→ ID utilisé : $ID  (secret : ${#SECRET} caractères)"

TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
{ $SUDO cat "$ENV_FILE" 2>/dev/null | grep -v -e "^${P}_CLIENT_" -e '^PUBLIC_URL=' || true; } > "$TMP"
{ echo "PUBLIC_URL=$URL_"; echo "${P}_CLIENT_ID=$ID"; echo "${P}_CLIENT_SECRET=$SECRET"; } >> "$TMP"
$SUDO install -m 600 -o root -g root "$TMP" "$ENV_FILE"
echo "✓ Réglages enregistrés dans $ENV_FILE (accès root uniquement)."

if [ -z "${NO_RESTART:-}" ]; then
  $SUDO systemctl restart fadeaway; sleep 2
  systemctl is-active --quiet fadeaway && echo "✓ Serveur redémarré : le bouton « Continuer avec $NAME » est maintenant sur l'écran de connexion." || { echo "✗ Le service ne démarre pas : sudo journalctl -u fadeaway -n 30"; exit 1; }
fi
