#!/usr/bin/env bash
# Publie une nouvelle version en UNE commande :
#   ./release.sh 0.1.1 "ce que j'ai changé"
#
# Il envoie le code sur GitHub, attend que GitHub fabrique l'.exe, télécharge les
# fichiers et les dépose directement dans ton serveur (qui doit tourner : ./start.sh).
# Prérequis : git, gh (GitHub CLI, connecté avec `gh auth login`), serveur lancé.
set -euo pipefail
cd "$(dirname "$0")"

V="${1:?Usage : ./release.sh 0.1.1 [\"message\"]}"; V="${V#v}"
MSG="${2:-Version $V}"
PORT="${PORT:-3000}"
PWFILE="$HOME/.config/fadeaway/admin-password"
SRVFILE="$HOME/.config/fadeaway/server"   # ex. https://fadeaway.kazegear5.duckdns.org
if [ -z "${SERVER:-}" ]; then
  if [ -s "$SRVFILE" ]; then SERVER="$(cat "$SRVFILE")"; else SERVER="http://localhost:$PORT"; fi
fi

command -v gh >/dev/null || { echo "gh (GitHub CLI) n'est pas installé : sudo apt install gh, puis gh auth login"; exit 1; }
[ -s "$PWFILE" ] || { echo "Mot de passe admin introuvable : crée-le avec  mkdir -p ~/.config/fadeaway && printf '%s' 'TON_MOT_DE_PASSE' > ~/.config/fadeaway/admin-password"; exit 1; }
curl -fsS -m 4 -o /dev/null "$SERVER/" || { echo "Le serveur ne répond pas sur $SERVER : lance le serveur (./start.sh, ou vérifie la Raspberry)."; exit 1; }

echo "1/4 Envoi du code et de la version v$V sur GitHub…"
git add -A
git commit -m "$MSG" || echo "(rien de nouveau à enregistrer)"
git push
git tag "v$V"
git push origin "v$V"

echo "2/4 GitHub fabrique l'.exe (5 à 10 minutes)…"
RUN=""
for _ in $(seq 1 30); do
  RUN="$(gh run list --workflow release.yml --branch "v$V" --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)"
  [ -n "$RUN" ] && break
  sleep 3
done
[ -n "$RUN" ] || { echo "Je ne trouve pas la construction sur GitHub : regarde l'onglet Actions."; exit 1; }
gh run watch "$RUN" --exit-status

echo "3/4 Téléchargement des fichiers…"
rm -rf dist-download
gh run download "$RUN" -n fadeaway-update -D dist-download

echo "4/4 Dépôt dans le serveur ($SERVER)…"
TOKEN="$(curl -fsS -X POST -H 'Content-Type: application/json' \
  -d "{\"password\":\"$(cat "$PWFILE")\"}" "$SERVER/api/admin/login" \
  | sed -E 's/.*"token":"([^"]+)".*/\1/')"
# l'installeur et le blockmap d'abord, latest.yml en dernier
for f in dist-download/*.exe dist-download/*.blockmap dist-download/latest.yml; do
  n="$(basename "$f")"
  echo "    envoi de $n…"
  curl -fsS -X PUT -H "Authorization: Bearer $TOKEN" --data-binary @"$f" \
    "$SERVER/api/admin/updates?name=$n" >/dev/null
done
rm -rf dist-download

echo
echo "  ✓ Version $V publiée. Les apps installées vont se mettre à jour toutes seules."
