'use strict';
// Connexion avec Discord (OAuth 2.0, flux « code »). Aucune dépendance.
// Réglages (variables d'environnement) : DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET,
// PUBLIC_URL (ex : https://fadeaway.kazegear5.duckdns.org). Les URL OAUTH_<FOURNISSEUR>_AUTH_URL / _TOKEN_URL / _USER_URL
// ne servent qu'aux tests automatiques.
const env = (k, d) => process.env[k] || d;

const DEFS = {
  discord: {
    label: 'Discord', scope: 'identify email',
    auth: 'https://discord.com/oauth2/authorize',
    token: 'https://discord.com/api/oauth2/token',
    user: 'https://discord.com/api/users/@me',
    extra: { prompt: 'none' },
    profile: j => ({ id: String(j.id || ''), email: String(j.email || '').toLowerCase(), emailVerified: j.verified === true, name: j.global_name || j.username || '' }),
  },
};

function config(p) {
  const d = DEFS[p]; if (!d) return null;
  const P = p.toUpperCase();
  const id = env(`${P}_CLIENT_ID`), secret = env(`${P}_CLIENT_SECRET`);
  if (!id || !secret) return null;
  return { id, secret, label: d.label, scope: d.scope, extra: d.extra, profile: d.profile,
    auth: env(`OAUTH_${P}_AUTH_URL`, d.auth), token: env(`OAUTH_${P}_TOKEN_URL`, d.token), user: env(`OAUTH_${P}_USER_URL`, d.user) };
}
const providers = () => Object.fromEntries(Object.keys(DEFS).map(p => [p, !!config(p)]));

function authUrl(p, redirectUri, state) {
  const c = config(p);
  const q = new URLSearchParams({ client_id: c.id, redirect_uri: redirectUri, response_type: 'code', scope: c.scope, state, });
  return `${c.auth}?${q}`;
}

async function timed(url, opts) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}

// code -> profil { id, email, emailVerified, name }
async function fetchProfile(p, code, redirectUri) {
  const c = config(p);
  const tr = await timed(c.token, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
  });
  const tj = await tr.json().catch(() => ({}));
  if (!tr.ok || !tj.access_token) throw new Error(`${c.label} a refusé le code (${tj.error_description || tj.error || tr.status}).`);
  const ur = await timed(c.user, { headers: { Authorization: `Bearer ${tj.access_token}`, Accept: 'application/json' } });
  const uj = await ur.json().catch(() => ({}));
  if (!ur.ok) throw new Error(`${c.label} n'a pas donné le profil (${ur.status}).`);
  const prof = c.profile(uj);
  if (!prof.id) throw new Error(`${c.label} n'a pas donné d'identifiant.`);
  return prof;
}

module.exports = { providers, config, authUrl, fetchProfile, labels: { discord: 'Discord' } };
