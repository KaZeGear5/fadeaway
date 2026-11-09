'use strict';
// FadeAway - serveur (Node 18+, aucune dépendance)
//
//  - comptes (e-mail + code de vérification), amis, MP, salon du serveur officiel, profils
//  - console de commandes (op dans l'app, console dans le panneau admin)
//  - signalisation WebRTC : l'audio/vidéo ne passe JAMAIS ici
//  - panneau admin /admin ; l'app web (installable) est servie sur /
//
// Variables d'environnement :
//   ADMIN_PASSWORD  mot de passe du panneau admin
//   PORT, HOST, DATA_DIR
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM   (e-mails de vérification, voir lib/mail.js)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createStore } = require('./lib/store');
const { createModel } = require('./lib/model');
const { createCommands, fmtRec } = require('./lib/commands');
const { sniffImage } = require('./lib/images');
const mail = require('./lib/mail');
const { json, safeDecode, readJson, readBody, serveFile, serveStatic } = require('./lib/http');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const ADMIN_DIR = path.join(__dirname, 'admin');
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const MEDIA = path.join(DATA, 'media');
fs.mkdirSync(MEDIA, { recursive: true });
const startedAt = Date.now();

const store = createStore(DATA);
const model = createModel(store);

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
  console.log(`\n  ADMIN_PASSWORD non défini : mot de passe admin temporaire = ${ADMIN_PASSWORD}`);
  console.log('  (définis ADMIN_PASSWORD pour garder le même mot de passe à chaque lancement)\n');
}
if (!mail.configured()) {
  console.log('  ⚠ E-mails non configurés (SMTP_HOST absent) : les codes de vérification sont écrits ICI,');
  console.log('    dans le journal. Configure SMTP (voir README) ou valide les comptes avec la commande « verify ».\n');
}

// ---------- le serveur officiel ----------
const OFFICIAL = { id: 'fadeaway', name: 'FadeAway', channel: { id: 'general', name: 'général' } };
const CHAN_KEY = `${OFFICIAL.id}:${OFFICIAL.channel.id}`;
const inOfficial = u => u.servers.includes(OFFICIAL.id);

// ---------- utilitaires ----------
class ApiError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; } }
const bad = (m, extra) => new ApiError(400, m, extra);
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ipOf = req => String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

// limiteur : renvoie false quand on dépasse `max` appels en `ms`
const buckets = new Map();
function hit(key, max, ms) {
  const t = Date.now(); let b = buckets.get(key);
  if (!b || b.reset <= t) { b = { n: 0, reset: t + ms }; buckets.set(key, b); }
  return ++b.n <= max;
}
const limit = (key, max, ms, msg = 'Trop de requêtes, ralentis un peu.') => { if (!hit(key, max, ms)) throw new ApiError(429, msg); };

// ---------- connexions temps réel (SSE) ----------
const conns = new Map();          // uid -> { res, ping, since }
const tickets = new Map();        // ticket à usage unique -> { uid, exp }
const isOnline = id => conns.has(id);
const onlineIds = () => [...conns.keys()];
function sendTo(uid, event, data) {
  const c = conns.get(uid);
  if (c) { try { c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} }
}
const broadcast = (event, data) => { for (const id of conns.keys()) sendTo(id, event, data); };
const broadcastPresence = () => broadcast('presence', { online: onlineIds() });
const pushMe = u => sendTo(u.id, 'me', model.meView(u));

function closeConn(uid) {
  const c = conns.get(uid); if (!c) return;
  clearInterval(c.ping); conns.delete(uid);
  try { c.res.end(); } catch {}
}
function dropAllSessions(uid) {
  for (const [k, s] of Object.entries(store.db.sessions)) if (s.uid === uid) delete store.db.sessions[k];
  store.touchDb();
}

// ---------- ce que le moteur de commandes peut faire ----------
function cleanupPremium(u) {      // ce qui n'existe plus sans Premium
  if (model.premiumOf(u)) return false;
  let changed = false;
  if (u.avatar && u.avatar.animated) { removeMedia(u.avatar); u.avatar = null; changed = true; }
  if (u.nameGradient) { u.nameGradient = null; changed = true; }
  if (u.aura) { u.aura = null; changed = true; }
  if (changed) store.touchDb();
  return changed;
}
const hooks = {
  onlineIds, isOnline,
  disconnect(uid, message, reason) {
    sendTo(uid, 'kicked', { message, reason, logout: true });
    dropAllSessions(uid);
    closeConn(uid);
    broadcastPresence();
  },
  changed(u, message) {           // après op / premium / mute / verify… : prévient l'intéressé et les autres
    cleanupPremium(u);
    pushMe(u);
    broadcast('profile', model.pub(u));
    if (message) sendTo(u.id, 'notice', { message });
  },
  announce(text) { broadcast('notice', { message: text }); },
};
const commands = createCommands(model, hooks);

// toutes les 5 minutes : un Premium qui expire perd ses avantages
setInterval(() => {
  for (const u of Object.values(store.db.users)) if (cleanupPremium(u)) { pushMe(u); broadcast('profile', model.pub(u)); }
  for (const [k, b] of buckets) if (b.reset <= Date.now()) buckets.delete(k);
  for (const [k, t] of tickets) if (t.exp <= Date.now()) tickets.delete(k);
  model.purgeSessions();
}, 5 * 60000).unref();

// ---------- médias (avatars, bannières) ----------
const MEDIA_RE = /^[a-f0-9]{16}\.(png|jpg|gif|webp)$/;
const MEDIA_TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
function removeMedia(m) { if (m && m.id && m.ext) fs.unlink(path.join(MEDIA, `${m.id}.${m.ext}`), () => {}); }
function saveMedia(buf, info) {
  const id = crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(path.join(MEDIA, `${id}.${info.ext}`), buf);
  return { id, ext: info.ext };
}

// ---------- vérifications communes ----------
const banMessage = b => `Compte banni ${fmtRec(b)}${b.reason ? ` : ${b.reason}` : '.'}`;
function textOf(b, u) {
  const text = String(b.text ?? '').replace(/\r\n/g, '\n').trim();
  const max = model.isPremium(u) ? 4000 : 2000;
  if (!text) throw bad('Message vide.');
  if ([...text].length > max) throw bad(`Message trop long (${max} caractères maximum${model.isPremium(u) ? '' : ', 4000 avec FadeAway Premium'}).`);
  return text;
}
function notMuted(u) {
  const m = model.muteOf(u);
  if (m) throw new ApiError(403, `Tu es muet ${fmtRec(m)}${m.reason ? ` : ${m.reason}` : '.'}`, { muted: true });
}
function friendOf(u, id) {
  const other = model.getUser(Number(id));
  if (!other || !model.isFriend(u, other)) throw new ApiError(403, "Cette personne n'est pas dans tes amis.");
  return other;
}
function sendCode(u) {            // -> promesse de { status: 'smtp'|'log'|'failed' } ou { error, wait }
  const r = model.issueCode(u);
  if (r.error) return Promise.resolve(r);
  return mail.sendMail({
    to: u.email,
    subject: `Ton code FadeAway : ${r.code}`,
    text: `Salut ${u.name},\n\nTon code de vérification FadeAway est : ${r.code}\n\nIl est valable 15 minutes. Si tu n'as pas créé de compte, ignore simplement ce message.\n`,
  }).then(x => ({ status: x.mode }), e => { console.error(`E-mail de vérification non envoyé à ${u.email} : ${e.message}`); return { status: 'failed' }; });
}

// ---------- routes ----------
const routes = new Map();
const route = (method, p, auth, handler, opts = {}) => routes.set(`${method} ${p}`, { auth, handler, raw: !!opts.raw });
const U = 'user', V = 'verified';        // U : connecté (e-mail pas forcément vérifié) ; V : connecté + vérifié

// --- comptes
route('POST', '/api/register', null, async c => {
  limit('reg:' + c.ip, 10, 3600e3, 'Trop de créations de compte depuis cette adresse. Réessaie plus tard.');
  const b = c.body;
  const email = String(b.email || '').trim().toLowerCase();
  const username = String(b.username || '').trim().toLowerCase().replace(/^@/, '');
  const name = model.cleanName(b.name);
  const password = String(b.password || '');
  if (!model.validEmail(email)) throw bad('Adresse e-mail invalide.');
  if (!name) throw bad('Pseudo invalide (2 à 32 caractères, sans caractères spéciaux).');
  if (!model.validUsername(username)) throw bad('Sous-pseudo invalide : 3 à 20 caractères, minuscules, chiffres, « _ » et « . » (certains noms sont réservés).');
  if (password.length < 8 || password.length > 200) throw bad('Mot de passe : 8 caractères minimum.');
  if (model.byEmail(email)) throw new ApiError(409, 'Cette adresse e-mail a déjà un compte.');
  if (model.byUsername(username)) throw new ApiError(409, 'Ce sous-pseudo est déjà pris.');
  const r = await model.createUser({ email, password, name, username });
  if (r.error) throw new ApiError(409, r.error === 'email_taken' ? 'Cette adresse e-mail a déjà un compte.' : 'Ce sous-pseudo est déjà pris.');
  const token = model.newSession(r.user.id);
  const m = await sendCode(r.user);
  console.log(`Nouveau compte #${r.user.id} : @${username} (${email})`);
  return { token, me: model.meView(r.user), mail: m.status };
});

const failed = new Map();         // verrou anti force brute par compte
route('POST', '/api/login', null, async c => {
  limit('login:' + c.ip, 30, 600e3, 'Trop de tentatives, réessaie dans quelques minutes.');
  const q = String(c.body.login || '').trim().toLowerCase();
  const pw = String(c.body.password || '');
  if (!q || !pw || pw.length > 200) throw bad('Identifiant et mot de passe requis.');
  const u = q.includes('@') && !q.startsWith('@') ? model.byEmail(q) : model.byUsername(q.replace(/^@/, ''));
  const key = u ? u.id : 'x:' + q;
  let f = failed.get(key);
  if (f && f.until && f.until <= Date.now()) { failed.delete(key); f = null; }
  if (f && f.until > Date.now()) throw new ApiError(429, 'Compte verrouillé quelques minutes après trop d\'échecs.');
  if (!(await model.checkPassword(u, pw))) {
    const n = (f ? f.n : 0) + 1;
    failed.set(key, { n, until: n >= 8 ? Date.now() + 10 * 60000 : 0 });
    await sleep(400);
    throw new ApiError(401, 'Identifiants incorrects.');
  }
  failed.delete(key);
  const ban = model.banOf(u);
  if (ban) throw new ApiError(403, banMessage(ban), { banned: true });
  return { token: model.newSession(u.id), me: model.meView(u) };
});

route('GET', '/api/me', U, c => ({ me: model.meView(c.u) }));

route('POST', '/api/verify', U, c => {
  const u = c.u;
  limit('verify:' + u.id, 20, 3600e3, 'Trop d\'essais. Réessaie plus tard.');
  const r = model.checkCode(u, c.body.code);
  const msgs = {
    wrong: 'Code incorrect.', expired: 'Code expiré : demande-en un nouveau.', no_code: 'Aucun code en cours : demande-en un nouveau.',
    too_many: 'Trop d\'essais sur ce code : demande-en un nouveau.',
  };
  if (r !== 'ok') throw new ApiError(r === 'too_many' ? 429 : 400, msgs[r] || 'Code invalide.');
  pushMe(u); broadcast('profile', model.pub(u));
  return { me: model.meView(u) };
});

route('POST', '/api/resend', U, async c => {
  if (c.u.verified) return { ok: true, mail: 'already' };
  const m = await sendCode(c.u);
  if (m.error === 'cooldown') throw new ApiError(429, `Patiente ${m.wait} s avant de redemander un code.`, { wait: m.wait });
  if (m.error) throw new ApiError(429, 'Trop de codes demandés cette heure-ci.');
  return { ok: true, mail: m.status };
});

route('POST', '/api/logout', U, c => {
  model.dropSession(c.token); closeConn(c.u.id); broadcastPresence();
  return { ok: true };
});

route('POST', '/api/ticket', V, c => {
  const ticket = crypto.randomBytes(24).toString('base64url');
  tickets.set(ticket, { uid: c.u.id, exp: Date.now() + 30000 });
  return { ticket };
});

// --- profils
route('GET', '/api/users', V, c => {
  const ids = String(c.url.searchParams.get('ids') || '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 60);
  return { users: ids.map(id => model.getUser(id)).filter(u => u && u.verified).map(model.pub) };
});

route('POST', '/api/profile', V, c => {
  const u = c.u, b = c.body;
  if (b.name !== undefined) {
    const n = model.cleanName(b.name);
    if (!n) throw bad('Pseudo invalide (2 à 32 caractères, sans caractères spéciaux).');
    u.name = n;
  }
  if (b.banner !== undefined) {
    if (!b.banner || b.banner.type !== 'color' || !model.validColor(b.banner.value)) throw bad('Couleur de bannière invalide.');
    if (u.banner && u.banner.id) removeMedia(u.banner);
    u.banner = { type: 'color', value: b.banner.value };
  }
  const prem = model.isPremium(u);
  if (b.nameGradient !== undefined) {
    if (!prem) throw new ApiError(403, 'Le nom en dégradé est réservé à FadeAway Premium ✦');
    const g = b.nameGradient;
    if (g !== null && !(Array.isArray(g) && g.length === 2 && g.every(model.validColor))) throw bad('Dégradé invalide.');
    u.nameGradient = g;
  }
  if (b.aura !== undefined) {
    if (!prem) throw new ApiError(403, "L'aura est réservée à FadeAway Premium ✦");
    if (b.aura !== null && !model.validColor(b.aura)) throw bad('Couleur d\'aura invalide.');
    u.aura = b.aura;
  }
  store.touchDb(); pushMe(u); broadcast('profile', model.pub(u));
  return { me: model.meView(u) };
});

route('PUT', '/api/profile/avatar', V, async c => {
  limit('up:' + c.u.id, 20, 3600e3, 'Trop de changements d\'image. Réessaie plus tard.');
  const buf = await readBody(c.req, 6 * 1024 * 1024);
  const info = sniffImage(buf);
  if (!info) throw bad('Ce fichier n\'est pas une image valide (PNG, JPEG, WebP ou GIF).');
  if (info.animated && !model.isPremium(c.u)) throw new ApiError(403, "L'avatar animé (GIF) est réservé à FadeAway Premium ✦");
  if (!info.animated && buf.length > 4 * 1024 * 1024) throw new ApiError(413, 'Image trop lourde (4 Mo maximum).');
  const old = c.u.avatar;
  c.u.avatar = { ...saveMedia(buf, info), animated: !!info.animated };
  removeMedia(old);
  store.touchDb(); pushMe(c.u); broadcast('profile', model.pub(c.u));
  return { me: model.meView(c.u) };
}, { raw: true });

route('PUT', '/api/profile/banner', V, async c => {
  limit('up:' + c.u.id, 20, 3600e3, 'Trop de changements d\'image. Réessaie plus tard.');
  const type = c.url.searchParams.get('type');
  if (type !== 'image' && type !== 'gif') throw bad('Type de bannière inconnu (image ou gif).');
  const buf = await readBody(c.req, 8 * 1024 * 1024);
  const info = sniffImage(buf);
  if (!info) throw bad('Ce fichier n\'est pas une image valide (PNG, JPEG, WebP ou GIF).');
  if (type === 'gif' && info.ext !== 'gif') throw bad('Pour une bannière GIF, choisis un fichier .gif.');
  if (type === 'image' && info.animated) throw bad('Cette image est animée : utilise l\'option GIF.');
  const old = c.u.banner;
  c.u.banner = { type, ...saveMedia(buf, info) };
  if (old && old.id) removeMedia(old);
  store.touchDb(); pushMe(c.u); broadcast('profile', model.pub(c.u));
  return { me: model.meView(c.u) };
}, { raw: true });

// --- amis
function friendsView(u) {
  const ids = [...new Set([...u.friends, ...u.incoming, ...u.outgoing])];
  return {
    friends: u.friends, incoming: u.incoming, outgoing: u.outgoing,
    users: ids.map(id => model.getUser(id)).filter(Boolean).map(model.pub),
  };
}
route('GET', '/api/friends', V, c => friendsView(c.u));

route('POST', '/api/friends/add', V, c => {
  limit('fr:' + c.u.id, 30, 3600e3, 'Trop de demandes d\'ami cette heure-ci.');
  const target = model.findUser(c.body.username);
  if (!target || !target.verified) throw new ApiError(404, 'Aucun utilisateur avec ce sous-pseudo.');
  const r = model.requestFriend(c.u, target);
  const msg = {
    self: "Tu ne peux pas t'ajouter toi-même.", already: 'Vous êtes déjà amis.', pending: 'Demande déjà envoyée.',
    limit: 'Limite de demandes ou d\'amis atteinte.',
  }[r];
  if (msg) throw bad(msg);
  sendTo(c.u.id, 'friends', {}); sendTo(target.id, 'friends', {});
  if (r === 'sent') sendTo(target.id, 'notice', { message: `${c.u.name} (@${c.u.username}) t'a envoyé une demande d'ami.` });
  return { result: r, user: model.pub(target) };
});
route('POST', '/api/friends/accept', V, c => {
  const o = model.getUser(Number(c.body.id));
  if (!o || !model.acceptFriend(c.u, o)) throw bad('Aucune demande de cette personne.');
  sendTo(c.u.id, 'friends', {}); sendTo(o.id, 'friends', {});
  return { ok: true };
});
route('POST', '/api/friends/remove', V, c => {
  const o = model.getUser(Number(c.body.id));
  if (!o) throw bad('Utilisateur introuvable.');
  model.removeRelation(c.u, o);
  sendTo(c.u.id, 'friends', {}); sendTo(o.id, 'friends', {});
  return { ok: true };
});

// --- messages privés
route('POST', '/api/dm', V, c => {
  limit('dm:' + c.u.id, 30, 10e3, 'Tu écris trop vite.');
  notMuted(c.u);
  const to = friendOf(c.u, c.body.to);
  const m = model.addDM(c.u.id, to.id, textOf(c.body, c.u));
  sendTo(c.u.id, 'dm', m); sendTo(to.id, 'dm', m);
  return { ok: true };
});
route('GET', '/api/history', V, c => {
  const o = friendOf(c.u, c.url.searchParams.get('with'));
  return { messages: model.history(c.u.id, o.id).slice(-200) };
});

// --- serveur officiel
const members = () => Object.values(store.db.users).filter(u => u.verified && inOfficial(u));
route('GET', '/api/server', V, c => {
  const joined = inOfficial(c.u), all = members();
  return { id: OFFICIAL.id, name: OFFICIAL.name, channel: OFFICIAL.channel, joined, count: all.length, members: joined ? all.map(model.pub) : [] };
});
route('POST', '/api/server/join', V, c => {
  if (!inOfficial(c.u)) c.u.servers.push(OFFICIAL.id);
  c.u.onboarded = true; store.touchDb(); pushMe(c.u);
  for (const m of members()) sendTo(m.id, 'server', {});
  return { ok: true };
});
route('POST', '/api/server/skip', V, c => { c.u.onboarded = true; store.touchDb(); pushMe(c.u); return { ok: true }; });
route('GET', '/api/server/messages', V, c => {
  if (!inOfficial(c.u)) throw new ApiError(403, 'Rejoins le serveur pour voir ses messages.');
  return { messages: model.chan(CHAN_KEY).slice(-100) };
});
route('POST', '/api/server/send', V, c => {
  limit('ch:' + c.u.id, 20, 10e3, 'Tu écris trop vite.');
  if (!inOfficial(c.u)) throw new ApiError(403, 'Rejoins le serveur pour écrire dedans.');
  notMuted(c.u);
  const m = model.addChan(CHAN_KEY, c.u.id, textOf(c.body, c.u));
  for (const mem of members()) sendTo(mem.id, 'chan', m);
  return { ok: true };
});

// --- console des opérateurs (dans l'app)
route('POST', '/api/console', V, c => {
  if (!c.u.op) throw new ApiError(403, 'Réservé aux opérateurs.');
  limit('cmd:' + c.u.id, 60, 60e3);
  return commands.run(String(c.body.line || '').slice(0, 400), { user: c.u });
});

// --- serveurs STUN/TURN pour WebRTC (TURN facultatif : TURN_URL, et TURN_SECRET ou TURN_USER + TURN_PASS)
route('GET', '/api/ice', V, c => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const urls = String(process.env.TURN_URL || '').split(',').map(x => x.trim()).filter(Boolean);
  if (urls.length) {
    if (process.env.TURN_SECRET) {        // identifiants temporaires (coturn : use-auth-secret)
      const username = String(Math.floor(Date.now() / 1000) + 6 * 3600) + ':' + c.u.id;
      iceServers.push({ urls, username, credential: crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64') });
    } else if (process.env.TURN_USER) iceServers.push({ urls, username: process.env.TURN_USER, credential: process.env.TURN_PASS || '' });
  }
  return { iceServers };
});

// --- appels : on ne fait que relayer la négociation WebRTC entre amis
route('POST', '/api/signal', V, c => {
  limit('sig:' + c.u.id, 600, 60e3);
  const to = friendOf(c.u, c.body.to);
  if (!isOnline(to.id)) throw new ApiError(404, 'Hors ligne.');
  if (JSON.stringify(c.body.data ?? null).length > 60000) throw bad('Message trop gros.');
  sendTo(to.id, 'signal', { from: c.u.id, data: c.body.data });
  return { ok: true };
});

// ---------- panneau admin ----------
const adminSessions = new Map();
const adminFails = new Map();
const isAdmin = req => {
  const t = (/^Bearer (.+)$/.exec(req.headers.authorization || '') || [])[1];
  const exp = t && adminSessions.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { adminSessions.delete(t); return false; }
  return true;
};
const passwordOk = p => crypto.timingSafeEqual(sha(p), sha(ADMIN_PASSWORD));

async function handleAdmin(req, res, url) {
  const name = url.pathname.slice('/api/admin/'.length);

  if (name === 'login' && req.method === 'POST') {
    const ip = ipOf(req);
    let f = adminFails.get(ip);
    if (f && f.until && f.until <= Date.now()) { adminFails.delete(ip); f = null; }
    if (f && f.until > Date.now()) return json(res, 429, { error: 'Trop d\'essais, réessaie dans quelques minutes' });
    let b; try { b = await readJson(req); } catch { return json(res, 400, { error: 'JSON invalide' }); }
    if (!passwordOk(b.password || '')) {
      const n = (f ? f.n : 0) + 1;
      adminFails.set(ip, { n, until: n >= 5 ? Date.now() + 10 * 60000 : 0 });
      await sleep(500);
      return json(res, 401, { error: 'Mot de passe incorrect' });
    }
    adminFails.delete(ip);
    const token = crypto.randomBytes(24).toString('base64url');
    adminSessions.set(token, Date.now() + 12 * 3600e3);
    return json(res, 200, { token });
  }
  if (!isAdmin(req)) return json(res, 401, { error: 'Non autorisé' });

  if (name === 'accounts' && req.method === 'GET') {
    const accounts = Object.values(store.db.users).sort((a, b) => a.id - b.id).map(u => {
      const ban = model.banOf(u), mute = model.muteOf(u), prem = model.premiumOf(u);
      return {
        id: u.id, name: u.name, username: u.username, email: u.email, verified: u.verified, op: !!u.op,
        premium: !!prem, premiumUntil: prem && !prem.perm ? prem.until : null,
        online: isOnline(u.id), createdAt: u.createdAt,
        ban: ban ? { until: ban.perm ? null : ban.until, reason: ban.reason || '' } : null,
        mute: mute ? { until: mute.perm ? null : mute.until, reason: mute.reason || '' } : null,
      };
    });
    return json(res, 200, { accounts, online: conns.size, uptime: Date.now() - startedAt, mailConfigured: mail.configured() });
  }
  if (name === 'command' && req.method === 'POST') {
    let b; try { b = await readJson(req); } catch { return json(res, 400, { error: 'JSON invalide' }); }
    return json(res, 200, commands.run(String(b.line || '').slice(0, 400), { console: true }));
  }
  return json(res, 404, { error: 'Inconnu' });
}

// ---------- serveur HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  res.setHeader('X-Content-Type-Options', 'nosniff');
  // CORS : l'app Windows charge l'interface depuis file://, et le panneau admin vit sur GitHub Pages
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600' });
    return res.end();
  }

  try {
    // ---- temps réel : /api/events?ticket=...
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const t = tickets.get(url.searchParams.get('ticket'));
      tickets.delete(url.searchParams.get('ticket'));
      const u = t && t.exp > Date.now() ? model.getUser(t.uid) : null;
      if (!u || !u.verified) return json(res, 401, { error: 'ticket invalide' });
      const ban = model.banOf(u);
      if (ban) return json(res, 403, { error: banMessage(ban), banned: true });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      if (conns.has(u.id)) {                                   // une seule connexion par compte
        sendTo(u.id, 'kicked', { message: 'Ce compte vient de se connecter ailleurs.', reason: 'replaced', logout: false });
        closeConn(u.id);
      }
      conns.set(u.id, { res, since: Date.now(), ping: setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20000) });
      sendTo(u.id, 'hello', { me: model.meView(u), online: onlineIds() });
      broadcastPresence();
      req.on('close', () => {
        const c = conns.get(u.id);
        if (c && c.res === res) { clearInterval(c.ping); conns.delete(u.id); broadcastPresence(); }
      });
      return;
    }

    // ---- API admin
    if (url.pathname.startsWith('/api/admin/')) return await handleAdmin(req, res, url);

    // ---- API publique
    if (url.pathname.startsWith('/api/')) {
      const r = routes.get(`${req.method} ${url.pathname}`);
      if (!r) return json(res, 404, { error: 'inconnu' });
      const c = { req, res, url, ip: ipOf(req), body: {}, u: null, token: null };
      if (r.auth) {
        c.token = (/^Bearer (.+)$/.exec(req.headers.authorization || '') || [])[1];
        c.u = model.sessionUser(c.token);
        if (!c.u) throw new ApiError(401, 'Session expirée, reconnecte-toi.', { relogin: true });
        const ban = model.banOf(c.u);
        if (ban) throw new ApiError(403, banMessage(ban), { banned: true });
        if (r.auth === V && !c.u.verified) throw new ApiError(403, 'Valide d\'abord ton adresse e-mail.', { unverified: true });
      }
      if (!r.raw && req.method !== 'GET') {
        try { c.body = await readJson(req, 200000); } catch { throw bad('Requête invalide.'); }
        if (!c.body || typeof c.body !== 'object') c.body = {};
      }
      return json(res, 200, await r.handler(c));
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }

    // ---- images de profil
    if (url.pathname.startsWith('/media/')) {
      const f = safeDecode(url.pathname.slice(7));
      if (!MEDIA_RE.test(f)) { res.writeHead(404); return res.end('Not found'); }
      return serveFile(req, res, path.join(MEDIA, f), MEDIA_TYPES[f.split('.')[1]],
        { 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Security-Policy': "default-src 'none'" });
    }
    // ---- panneau admin
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      const rel = safeDecode(url.pathname.slice('/admin'.length)).replace(/^\/+/, '') || 'index.html';
      res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Cache-Control', 'no-store');
      return serveStatic(req, res, ADMIN_DIR, rel);
    }
    // ---- version web de l'app
    const rel = url.pathname === '/' ? 'index.html' : safeDecode(url.pathname).replace(/^\/+/, '');
    if (rel === 'sw.js') { res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Service-Worker-Allowed', '/'); }
    else if (/\.(html|js|css|webmanifest)$/.test(rel) || rel === 'index.html') res.setHeader('Cache-Control', 'no-cache');
    serveStatic(req, res, PUBLIC, rel);
  } catch (e) {
    if (e instanceof ApiError) return json(res, e.status, { error: e.message, ...e.extra });
    if (e && e.status === 413) return json(res, 413, { error: e.message });
    console.error('Erreur :', e);
    json(res, 500, { error: 'Erreur interne du serveur.' });
  }
});

process.on('unhandledRejection', e => console.error('Promesse rejetée :', e));
server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log(`FadeAway sur http://localhost:${PORT}`);
  console.log(`Admin       http://localhost:${PORT}/admin`);
});
