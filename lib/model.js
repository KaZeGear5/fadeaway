'use strict';
// Comptes, sessions, amis, messages, sanctions. Tout est en mémoire et sauvegardé par store.js.
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const DAY = 86400000;
const SESSION_MS = 60 * DAY;
const CODE_MS = 15 * 60000;
const RESERVED = new Set(['admin', 'administrator', 'root', 'system', 'fadeaway', 'console', 'moderator', 'mod', 'support', 'everyone', 'here', 'null', 'undefined']);
// caractères de contrôle, invisibles et inversions de sens d'écriture (usurpation de pseudo)
const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
// une sanction / un premium est actif s'il est permanent ou pas encore expiré
const active = r => !!r && (r.perm === true || (typeof r.until === 'number' && r.until > Date.now()));

function createModel(store) {
  const { db, msgs } = store;
  const emails = new Map(), names = new Map();
  for (const u of Object.values(db.users)) { emails.set(u.email, u); names.set(u.username, u); }

  // ---------- validation ----------
  const validEmail = e => typeof e === 'string' && e.length <= 254 && /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@.]{2,}$/.test(e);
  const validUsername = s => typeof s === 'string' && /^[a-z0-9_.]{3,20}$/.test(s) && !RESERVED.has(s);
  function cleanName(s) {
    s = String(s ?? '').replace(/\s+/g, ' ').trim();
    const len = [...s].length;
    return len >= 2 && len <= 32 && !BAD_CHARS.test(s) ? s : null;
  }
  const validColor = c => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);

  // ---------- mots de passe (scrypt) ----------
  async function hashPassword(pw) {
    const salt = crypto.randomBytes(16);
    const h = await scrypt(pw, salt, 64);
    return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
  }
  const DUMMY = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;
  async function checkPassword(user, pw) {
    const [, saltHex, hashHex] = (user ? user.pass : DUMMY).split('$');   // faux calcul si le compte n'existe pas : même durée
    const h = await scrypt(String(pw), Buffer.from(saltHex, 'hex'), 64);
    const ok = crypto.timingSafeEqual(h, Buffer.from(hashHex, 'hex'));
    return !!user && ok;
  }

  // ---------- comptes ----------
  const byEmail = e => emails.get(String(e || '').trim().toLowerCase()) || null;
  const byUsername = n => names.get(String(n || '').trim().toLowerCase()) || null;
  const getUser = id => db.users[id] || null;

  // « #12 », « kaze », « kaze#12 » ; un nombre seul est un pseudo, pas un numéro
  function findUser(q) {
    q = String(q || '').trim().toLowerCase().replace(/^@/, '');
    let m = /^#(\d{1,9})$/.exec(q);
    if (m) return db.users[m[1]] || null;
    m = /^([a-z0-9_.]{3,20})#(\d{1,9})$/.exec(q);
    if (m) { const u = db.users[m[2]]; return u && u.username === m[1] ? u : null; }
    return names.get(q) || null;
  }

  async function createUser({ email, password, name, username }) {
    const pass = await hashPassword(password);
    if (emails.has(email)) return { error: 'email_taken' };       // on revérifie après l'attente
    if (names.has(username)) return { error: 'username_taken' };
    const id = db.nextNumber++;
    const u = {
      id, email, username, name, pass, verified: false, code: null, mail: { hour: 0, count: 0, last: 0 },
      createdAt: Date.now(), avatar: null, banner: { type: 'color', value: '#ff529a' }, nameGradient: null,
      premium: null, op: false, ban: null, mute: null, aura: null,
      friends: [], incoming: [], outgoing: [], servers: [], onboarded: false,
    };
    db.users[id] = u; emails.set(email, u); names.set(username, u);
    store.touchDb();
    return { user: u };
  }

  // ---------- sessions ----------
  function newSession(uid) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.sessions[sha(token)] = { uid, exp: Date.now() + SESSION_MS, at: Date.now() };
    const mine = Object.entries(db.sessions).filter(([, s]) => s.uid === uid).sort((a, b) => a[1].at - b[1].at);
    while (mine.length > 10) delete db.sessions[mine.shift()[0]];
    store.touchDb();
    return token;
  }
  function sessionUser(token) {
    if (!token) return null;
    const s = db.sessions[sha(token)];
    if (!s) return null;
    if (s.exp < Date.now()) { delete db.sessions[sha(token)]; store.touchDb(); return null; }
    return db.users[s.uid] || null;
  }
  function dropSession(token) { if (token && delete db.sessions[sha(token)]) store.touchDb(); }
  function purgeSessions() {
    let n = 0;
    for (const [k, s] of Object.entries(db.sessions)) if (s.exp < Date.now() || !db.users[s.uid]) { delete db.sessions[k]; n++; }
    if (n) store.touchDb();
  }

  // ---------- code de vérification e-mail ----------
  // renvoie { code } ou { error, wait }
  function issueCode(u) {
    const now = Date.now();
    if (now - u.mail.last < 60000) return { error: 'cooldown', wait: Math.ceil((60000 - (now - u.mail.last)) / 1000) };
    if (now - u.mail.hour > 3600000) { u.mail.hour = now; u.mail.count = 0; }
    if (u.mail.count >= 5) return { error: 'hourly' };
    u.mail.count++; u.mail.last = now;
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    u.code = { hash: sha(code + ':' + u.id), exp: now + CODE_MS, tries: 0 };
    store.touchDb();
    return { code };
  }
  function checkCode(u, code) {
    if (u.verified) return 'ok';
    const c = u.code;
    if (!c) return 'no_code';
    if (c.exp < Date.now()) return 'expired';
    if (c.tries >= 5) return 'too_many';
    c.tries++;
    const a = Buffer.from(sha(String(code).trim() + ':' + u.id)), b = Buffer.from(c.hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { store.touchDb(); return 'wrong'; }
    u.verified = true; u.code = null; store.touchDb();
    return 'ok';
  }

  // ---------- état des sanctions / premium ----------
  const isPremium = u => active(u.premium);
  function banOf(u) { if (u.ban && !active(u.ban)) { u.ban = null; store.touchDb(); } return u.ban; }
  function muteOf(u) { if (u.mute && !active(u.mute)) { u.mute = null; store.touchDb(); } return u.mute; }
  function premiumOf(u) { if (u.premium && !active(u.premium)) { u.premium = null; store.touchDb(); } return u.premium; }

  // ---------- vues ----------
  const mediaUrl = m => (m ? `/media/${m.id}.${m.ext}` : null);
  function pub(u) {
    const prem = !!premiumOf(u);
    const b = u.banner || { type: 'color', value: '#ff529a' };
    return {
      id: u.id, username: u.username, name: u.name, avatar: mediaUrl(u.avatar),
      banner: b.type === 'color' ? { type: 'color', value: b.value } : { type: b.type, value: mediaUrl(b) },
      premium: prem, op: !!u.op, gradient: prem ? u.nameGradient : null, aura: prem ? (u.aura || null) : null, since: u.createdAt,
    };
  }
  function meView(u) {
    return {
      ...pub(u), email: u.email, verified: u.verified, onboarded: u.onboarded, servers: u.servers,
      premiumUntil: premiumOf(u) ? (u.premium.perm ? null : u.premium.until) : undefined,
      mute: muteOf(u) ? { until: u.mute.perm ? null : u.mute.until, reason: u.mute.reason || '' } : null,
    };
  }

  // ---------- amis ----------
  const isFriend = (a, b) => a.friends.includes(b.id);
  const pull = (arr, x) => { const i = arr.indexOf(x); if (i !== -1) arr.splice(i, 1); };
  function requestFriend(a, b) {
    if (a.id === b.id) return 'self';
    if (isFriend(a, b)) return 'already';
    if (a.incoming.includes(b.id)) { acceptFriend(a, b); return 'accepted'; }
    if (a.outgoing.includes(b.id)) return 'pending';
    if (a.friends.length >= 200 || a.outgoing.length >= 50 || b.incoming.length >= 100) return 'limit';
    a.outgoing.push(b.id); b.incoming.push(a.id); store.touchDb();
    return 'sent';
  }
  function acceptFriend(me, other) {   // me accepte la demande de other
    if (!me.incoming.includes(other.id)) return false;
    pull(me.incoming, other.id); pull(other.outgoing, me.id);
    if (!me.friends.includes(other.id)) me.friends.push(other.id);
    if (!other.friends.includes(me.id)) other.friends.push(me.id);
    store.touchDb();
    return true;
  }
  function removeRelation(a, b) {      // retire un ami, annule ou refuse une demande
    for (const k of ['friends', 'incoming', 'outgoing']) { pull(a[k], b.id); pull(b[k], a.id); }
    store.touchDb();
  }

  // ---------- messages ----------
  const dmKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  function addDM(from, to, text) {
    const arr = (msgs.dm[dmKey(from, to)] ||= []);
    const m = { id: msgs.nextId++, from, to, text, ts: Date.now() };
    arr.push(m); if (arr.length > 300) arr.shift();
    store.touchMsgs();
    return m;
  }
  const history = (a, b) => msgs.dm[dmKey(a, b)] || [];
  function addChan(chan, from, text) {
    const arr = (msgs.chan[chan] ||= []);
    const m = { id: msgs.nextId++, from, text, ts: Date.now() };
    arr.push(m); if (arr.length > 500) arr.shift();
    store.touchMsgs();
    return m;
  }

  return {
    db, store, active, DAY,
    validEmail, validUsername, cleanName, validColor,
    createUser, checkPassword, byEmail, byUsername, getUser, findUser,
    newSession, sessionUser, dropSession, purgeSessions,
    issueCode, checkCode,
    isPremium, banOf, muteOf, premiumOf,
    pub, meView,
    isFriend, requestFriend, acceptFriend, removeRelation,
    addDM, history, addChan, chan: c => msgs.chan[c] || [],
  };
}

module.exports = { createModel };
