#!/usr/bin/env bash
# Configure l'envoi des e-mails de vérification (une seule fois) :
#   ./deploy/setup-mail.sh
# Les identifiants sont écrits dans /etc/fadeaway.env (lisible par root seulement), jamais dans le code.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-/etc/fadeaway.env}"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

cat <<'T'
Quel service d'envoi utiliser ?
  1) Gmail        (gratuit ; il faut un « mot de passe d'application », pas ton vrai mot de passe)
  2) Brevo        (gratuit, 300 mails/jour ; clé SMTP à créer dans ton compte Brevo)
  3) Autre        (tu donnes toi-même l'adresse du serveur SMTP)
T
read -rp "Choix [1-3] : " choice
case "$choice" in
  1) HOST=smtp.gmail.com; PORT=465; SECURE=tls
     echo "→ Gmail : active la validation en 2 étapes, puis crée un mot de passe d'application sur https://myaccount.google.com/apppasswords" ;;
  2) HOST=smtp-relay.brevo.com; PORT=587; SECURE=starttls
     echo "→ Brevo : identifiant = le « Login » affiché dans SMTP & API > SMTP (du type 12345@smtp-brevo.com, PAS ton e-mail), mot de passe = ta clé SMTP" ;;
  3) read -rp "Serveur SMTP (ex : smtp.exemple.fr) : " HOST
     read -rp "Port (465 = TLS direct, 587 = STARTTLS) : " PORT
     [ "$PORT" = "465" ] && SECURE=tls || SECURE=starttls ;;
  *) echo "Choix invalide."; exit 1 ;;
esac

USER_=""; while [ -z "$USER_" ]; do read -rp "Identifiant SMTP (Brevo : le Login …@smtp-brevo.com ; Gmail : ton adresse) : " USER_; done
PASS=""; while [ -z "$PASS" ]; do read -rsp "Mot de passe SMTP / clé (caché, colle puis Entrée) : " PASS; echo; done
echo "→ Identifiant utilisé : $USER_  (mot de passe : ${#PASS} caractères)"
read -rp "Adresse d'expéditeur [${USER_}] : " FROM_; FROM_="${FROM_:-$USER_}"
case "$USER_$PASS$FROM_$HOST" in *$'\n'*|*\"*|*\\*) echo "Caractère interdit (guillemet, antislash ou retour à la ligne)."; exit 1 ;; esac

# on garde le reste du fichier (ADMIN_PASSWORD…) et on remplace seulement les lignes SMTP_*
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
{ $SUDO cat "$ENV_FILE" 2>/dev/null | grep -v '^SMTP_' || true; } > "$TMP"
{
  echo "SMTP_HOST=$HOST"; echo "SMTP_PORT=$PORT"; echo "SMTP_SECURE=$SECURE"
  echo "SMTP_USER=$USER_"; echo "SMTP_PASS=$PASS"; echo "SMTP_FROM=FadeAway <$FROM_>"
} >> "$TMP"
$SUDO install -m 600 -o root -g root "$TMP" "$ENV_FILE"
echo "✓ Réglages enregistrés dans $ENV_FILE (accès root uniquement)."

read -rp "Envoyer un e-mail de test à quelle adresse ? (vide = passer) : " TEST
if [ -n "$TEST" ]; then
  SMTP_HOST="$HOST" SMTP_PORT="$PORT" SMTP_SECURE="$SECURE" SMTP_USER="$USER_" SMTP_PASS="$PASS" SMTP_FROM="FadeAway <$FROM_>" \
  TEST_TO="$TEST" node -e '
    require("./lib/mail").sendMail({ to: process.env.TEST_TO, subject: "Test FadeAway", text: "Si tu lis ceci, les e-mails de FadeAway fonctionnent ✓\n" })
      .then(r => { console.log(r.mode === "smtp" ? "✓ E-mail de test envoyé, vérifie ta boîte (et les spams)." : "✗ Non envoyé (SMTP incomplet)."); process.exit(r.mode === "smtp" ? 0 : 1); })
      .catch(e => { console.error("✗ Échec : " + e.message); process.exit(1); });' \
  || { echo "Corrige les réglages puis relance ce script (rien n'a été redémarré)."; exit 1; }
fi

if [ -z "${NO_RESTART:-}" ]; then
  $SUDO systemctl restart fadeaway; sleep 2
  systemctl is-active --quiet fadeaway && echo "✓ Serveur redémarré : les nouveaux comptes recevront leur code par e-mail." || { echo "✗ Le service ne démarre pas : sudo journalctl -u fadeaway -n 30"; exit 1; }
fi
