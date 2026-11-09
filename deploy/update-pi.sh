#!/usr/bin/env bash
# Met à jour le SERVEUR sur la Pi après un `git push` depuis ton PC :
#   ./deploy/update-pi.sh
# (les apps Windows, elles, se mettent à jour via le panneau admin)
# Attention : redémarrer le serveur déconnecte les gens et efface les MP en cours.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
sudo systemctl restart fadeaway
sleep 2
systemctl is-active --quiet fadeaway && echo "✓ Serveur mis à jour et redémarré." || { echo "✗ Le service ne démarre pas : sudo journalctl -u fadeaway -n 30"; exit 1; }
