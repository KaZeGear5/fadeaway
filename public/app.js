'use strict';
// FadeAway - interface (comptes, amis, MP, serveur, profils, appels WebRTC en P2P)

/* ============================== utilitaires ============================== */
const $ = id => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const initial = n => ([...String(n || '?')][0] || '?').toUpperCase();
const fmtTime = ts => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const fmtDay = ts => new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
const isHex = c => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);

const WEB = location.protocol.startsWith('http');   // l'app est servie par le serveur lui-même : même adresse, rien à configurer
let API = (WEB ? location.origin : (store.get('fa_server') || window.FADEAWAY_SERVER || '')).replace(/\/+$/, '');
function setServer(url) {
  API = String(url || '').trim().replace(/\/+$/, '');
  store.set('fa_server', API);
  if (window.fadeaway && window.fadeaway.setServer) window.fadeaway.setServer(API);
}
if (API && window.fadeaway && window.fadeaway.setServer) window.fadeaway.setServer(API);
const mediaUrl = p => (p ? (/^https?:/.test(p) ? p : API + p) : null);

/* ============================== état ============================== */
let token = store.get('fa_token');
let me = null;
const users = new Map();               // id -> profil public
let rel = { friends: [], incoming: [], outgoing: [] };
let online = new Set();
let server = null;                     // { joined, count, members, name, channel }
let view = null;                       // { type: 'dm', id } | { type: 'server' }
const dmMsgs = new Map();              // id -> messages
let chanMsgs = [];
const unread = new Map();
let showMembers = false;
let es = null, esStop = false, esTry = 0;

const putUser = u => { if (u && u.id) users.set(u.id, { ...(users.get(u.id) || {}), ...u }); };
const userOf = id => users.get(id) || { id, name: 'Inconnu', username: '?', banner: { type: 'color', value: '#ff529a' } };

/* ============================== API ============================== */
class ApiErr extends Error { constructor(s, m, d) { super(m); this.status = s; this.data = d || {}; } }
async function api(path, { method = 'GET', body, raw, auth = true } = {}) {
  if (!API) throw new ApiErr(0, "Adresse du serveur manquante (ouvre « Serveur » sur l'écran de connexion).");
  const headers = {};
  if (auth && token) headers.Authorization = 'Bearer ' + token;
  let data;
  if (raw) { data = raw; headers['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { data = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  let r;
  try { r = await fetch(API + path, { method, headers, body: data }); }
  catch { throw new ApiErr(0, 'Serveur injoignable. Vérifie ta connexion.'); }
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok) {
    if (r.status === 401 && j.relogin) { logout(j.error); }
    throw new ApiErr(r.status, j.error || `Erreur ${r.status}`, j);
  }
  return j;
}
function toast(msg, bad) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  $('toasts').append(t);
  setTimeout(() => t.remove(), Math.min(9000, 3000 + msg.length * 40));
}
const fail = e => toast(e.message || String(e), true);

/* ============================== rendu : avatars, noms ============================== */
function avatar(u, cls = '') {
  const url = mediaUrl(u.avatar);
  const el = h('div', { class: 'avatar ' + cls + (online.has(u.id) && cls.includes('st') ? ' on' : '') }, url ? null : initial(u.name));
  if (url) el.style.backgroundImage = `url("${url}")`;
  if (u.aura && isHex(u.aura)) { el.classList.add('aura'); el.style.setProperty('--aura', u.aura); }
  return el;
}
function nameEl(u, withNum = true) {
  const s = h('span', {}, u.name || '?');
  if (u.premium) {
    s.classList.add('prem');
    if (u.gradient && u.gradient.length === 2 && u.gradient.every(isHex)) {
      s.classList.add('grad');
      s.style.backgroundImage = `linear-gradient(90deg,${u.gradient[0]},${u.gradient[1]},${u.gradient[0]})`;
    }
  }
  const w = h('span', {}, s);
  if (u.premium) w.append(h('span', { class: 'star', title: 'FadeAway Premium' }, '✦'));
  if (u.op) w.append(h('span', { class: 'optag' }, 'OP'));
  if (withNum && u.id) w.append(h('span', { class: 'num' }, '#' + u.id));
  return w;
}
function bannerStyle(b) {
  if (!b) return 'background:#ff529a';
  if (b.type === 'color') return `background:${isHex(b.value) ? b.value : '#ff529a'}`;
  return `background-image:url("${mediaUrl(b.value)}")`;
}

/* ============================== écrans ============================== */
function show(which) {   // 'auth' | 'verify' | 'app'
  $('auth').hidden = which !== 'auth';
  $('verify').hidden = which !== 'verify';
  $('app').hidden = which !== 'app';
  if (which !== 'app') { $('consoleBox').hidden = true; }
}

/* ---- connexion / inscription ---- */
let mode = 'login';
function setMode(m) {
  mode = m;
  $('authForm').className = 'glass authcard ' + m;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.mode === m));
  $('authBtn').textContent = m === 'login' ? 'Se connecter' : 'Créer mon compte';
  $('fPass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  $('authErr').textContent = '';
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setMode(t.dataset.mode)));
$('fServer').value = API; if (WEB) document.querySelector('.adv').hidden = true;
$('fServer').addEventListener('change', () => setServer($('fServer').value));

let mailStatus = null;
$('authForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const err = $('authErr'); err.textContent = '';
  setServer($('fServer').value || API);
  const btn = $('authBtn'); btn.disabled = true;
  try {
    let r;
    if (mode === 'login') {
      r = await api('/api/login', { method: 'POST', auth: false, body: { login: $('fLogin').value, password: $('fPass').value } });
    } else {
      if ($('fPass').value !== $('fPass2').value) throw new Error('Les mots de passe ne sont pas identiques.');
      r = await api('/api/register', { method: 'POST', auth: false, body: {
        email: $('fEmail').value, name: $('fName').value, username: $('fUser').value, password: $('fPass').value } });
      mailStatus = r.mail;
    }
    token = r.token; store.set('fa_token', token); me = r.me; putUser(me);
    $('fPass').value = $('fPass2').value = '';
    afterAuth();
  } catch (e) { err.textContent = e.message; }
  btn.disabled = false;
});

/* ---- vérification de l'e-mail ---- */
let cooldownT = null;
function startCooldown(sec) {
  clearInterval(cooldownT);
  const b = $('resendBtn'); let n = sec;
  const tick = () => { b.disabled = n > 0; b.textContent = n > 0 ? `Renvoyer le code (${n} s)` : 'Renvoyer le code'; n--; if (n < -1) clearInterval(cooldownT); };
  tick(); cooldownT = setInterval(tick, 1000);
}
function showVerify() {
  show('verify');
  $('verifyText').textContent = `Un code à 6 chiffres a été envoyé à ${me.email}. Entre-le pour accéder à FadeAway.`;
  $('verifyNote').textContent = mailStatus === 'log' ? "L'envoi d'e-mails n'est pas encore configuré sur ce serveur : demande à l'administrateur de valider ton compte."
    : mailStatus === 'failed' ? "L'e-mail n'a pas pu être envoyé. Réessaie avec « Renvoyer le code », sinon préviens l'administrateur." : '';
  $('verifyErr').textContent = ''; $('vCode').value = '';
  startCooldown(60);
  setTimeout(() => $('vCode').focus(), 50);
}
$('vCode').addEventListener('input', () => { $('vCode').value = $('vCode').value.replace(/\D/g, '').slice(0, 6); });
$('verifyForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  $('verifyErr').textContent = '';
  try {
    const r = await api('/api/verify', { method: 'POST', body: { code: $('vCode').value } });
    me = r.me; putUser(me); enterApp();
  } catch (e) { $('verifyErr').textContent = e.message; }
});
$('resendBtn').addEventListener('click', async () => {
  $('verifyErr').textContent = '';
  try {
    const r = await api('/api/resend', { method: 'POST' });
    mailStatus = r.mail; startCooldown(60);
    $('verifyNote').textContent = r.mail === 'smtp' ? 'Nouveau code envoyé.' : "Le serveur n'a pas pu envoyer l'e-mail : préviens l'administrateur.";
  } catch (e) { $('verifyErr').textContent = e.message; if (e.data.wait) startCooldown(e.data.wait); }
});
$('verifyOut').addEventListener('click', () => logout());

function afterAuth() { me.verified ? enterApp() : showVerify(); }

async function logout(message) {
  if (token) { try { await fetch(API + '/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }); } catch {} }
  token = null; store.set('fa_token', null); me = null;
  closeStream(); endCall(false); $('modals').replaceChildren();
  view = null; users.clear(); dmMsgs.clear(); chanMsgs = []; unread.clear();
  setMode('login'); show('auth');
  $('authErr').textContent = message || '';
}

/* ============================== temps réel (SSE) ============================== */
function closeStream() { esStop = true; if (es) { es.close(); es = null; } }
async function openStream() {
  esStop = false;
  if (es) { es.close(); es = null; }
  let ticket;
  try { ticket = (await api('/api/ticket', { method: 'POST' })).ticket; }
  catch (e) { if (!esStop && token) scheduleReconnect(); return; }
  if (esStop) return;
  es = new EventSource(`${API}/api/events?ticket=${encodeURIComponent(ticket)}`);
  const on = (name, fn) => es.addEventListener(name, ev => { let d = {}; try { d = JSON.parse(ev.data); } catch {} fn(d); });
  on('hello', d => { esTry = 0; me = d.me; putUser(me); online = new Set(d.online); refreshAll(); });
  on('presence', d => { online = new Set(d.online); renderNav(); renderHeader(); });
  on('me', d => { me = d; putUser(d); renderMe(); renderHeader(); renderMuteNote(); });
  on('profile', d => { if (users.has(d.id) || d.id === me.id) { putUser(d); renderAll(); } });
  on('friends', () => loadFriends());
  on('server', () => loadServer());
  on('dm', m => {
    const other = m.from === me.id ? m.to : m.from;
    const list = dmMsgs.get(other) || []; list.push(m); dmMsgs.set(other, list);
    if (view && view.type === 'dm' && view.id === other) renderMessages(); else if (m.from !== me.id) { unread.set('dm' + other, (unread.get('dm' + other) || 0) + 1); renderNav(); }
  });
  on('chan', m => {
    chanMsgs.push(m);
    if (view && view.type === 'server') renderMessages(); else if (m.from !== me.id) { unread.set('srv', (unread.get('srv') || 0) + 1); renderNav(); }
    if (!users.has(m.from)) loadUsers([m.from]);
  });
  on('notice', d => toast(d.message));
  on('kicked', d => {
    closeStream(); endCall(false);
    if (d.logout) logout(d.message || 'Tu as été déconnecté.');
    else { toast(d.message || 'Connexion remplacée.', true); showReplaced(d.message); }
  });
  on('signal', d => onSignal(d.from, d.data));
  es.onerror = () => { if (es) { es.close(); es = null; } if (!esStop && token) scheduleReconnect(); };
}
async function scheduleReconnect() {
  const wait = Math.min(15000, 1500 * 2 ** esTry++);
  await sleep(wait);
  if (!esStop && token && !es) openStream();
}
function showReplaced(msg) {
  const ov = modal(h('div', { class: 'modal center' },
    h('h2', {}, 'Connexion remplacée'), h('p', {}, msg || 'Ce compte est connecté ailleurs.'),
    h('div', { class: 'actions' }, h('button', { onclick: () => { closeModal(); openStream(); } }, 'Reprendre ici'))));
  return ov;
}

/* ============================== chargement des données ============================== */
async function loadUsers(ids) {
  ids = ids.filter(i => !users.has(i)); if (!ids.length) return;
  try { (await api('/api/users?ids=' + ids.join(','))).users.forEach(putUser); renderAll(); } catch {}
}
async function loadFriends() {
  try { const r = await api('/api/friends'); rel = { friends: r.friends, incoming: r.incoming, outgoing: r.outgoing }; r.users.forEach(putUser); renderNav(); renderHeader(); } catch {}
}
async function loadServer() {
  try {
    server = await api('/api/server'); server.members.forEach(putUser);
    if (server.joined && view && view.type === 'server') loadChan();
    renderNav(); renderHeader(); renderMembers();
  } catch {}
}
async function loadChan() {
  try { chanMsgs = (await api('/api/server/messages')).messages; await loadUsers([...new Set(chanMsgs.map(m => m.from))]); renderMessages(); } catch (e) { fail(e); }
}
async function loadDM(id) {
  try { dmMsgs.set(id, (await api('/api/history?with=' + id)).messages); renderMessages(); } catch (e) { fail(e); }
}
async function refreshAll() {
  renderMe();
  await Promise.all([loadFriends(), loadServer()]);
  if (view) select(view, true);
  if (me && !me.onboarded) joinPopup();
}

/* ============================== installation (PWA) ============================== */
let installEv = null;
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEv = e; if (me) renderNav(); });
window.addEventListener('appinstalled', () => { installEv = null; if (me) renderNav(); toast('FadeAway est installée ✓'); });
const canInstall = () => !standalone() && (!!installEv || isIos);
async function installApp() {
  if (installEv) { installEv.prompt(); await installEv.userChoice.catch(() => {}); installEv = null; renderNav(); }
  else if (isIos) toast('Sur iPhone / iPad : bouton Partager, puis « Sur l\'écran d\'accueil ».');
}
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});

/* ============================== application ============================== */
function enterApp() {
  show('app');
  setupConsole();
  openStream();
  renderAll();
}
function renderAll() { renderMe(); renderNav(); renderHeader(); renderMessages(); renderMembers(); renderMuteNote(); }

function renderMe() {
  if (!me) return;
  const card = $('meCard');
  const btns = h('div', { class: 'btns' },
    me.op ? h('button', { class: 'ghost icon', title: 'Console OP (F2)', onclick: toggleConsole }, '🛠️') : null,
    h('button', { class: 'ghost icon', title: 'Audio et voix', onclick: audioModal }, '🎧'),
    h('button', { class: 'ghost icon', title: 'Mon profil', onclick: profileModal }, '⚙️'),
    h('button', { class: 'ghost icon', title: 'Se déconnecter', onclick: () => logout() }, '⏻'));
  card.replaceChildren(
    h('div', { class: 'bn', style: bannerStyle(me.banner) }),
    h('div', { class: 'inf' }, avatarMe(),
      h('div', { class: 'grow' }, h('span', { class: 'nm' }, nameEl(me, false)), h('span', { class: 'sb' }, `@${me.username} · #${me.id}`)), btns));
}
function avatarMe() { const a = avatar(me, 'xl'); a.style.width = a.style.height = '46px'; a.style.fontSize = '18px'; a.style.borderWidth = '3px'; return a; }

function navItem(active, av, name, sub, onclick, extra, off) {
  return h('div', { class: 'item' + (active ? ' active' : '') + (off ? ' offline' : ''), onclick },
    av, h('div', { class: 'grow' }, h('span', { class: 'nm' }, name), sub ? h('span', { class: 'sb' }, sub) : null), extra);
}
function renderNav() {
  if (!me) return;
  const nav = $('nav'); const items = [];
  // demandes reçues
  if (rel.incoming.length) {
    items.push(h('div', { class: 'sec' }, 'Demandes d\'amis'));
    for (const id of rel.incoming) {
      const u = userOf(id);
      items.push(navItem(false, avatar(u, 'st'), nameEl(u, false), `@${u.username}`, () => userCard(id),
        h('span', { class: 'row', style: 'display:flex;gap:4px' },
          h('button', { class: 'icon', title: 'Accepter', onclick: e => { e.stopPropagation(); friendAction('accept', id); } }, '✓'),
          h('button', { class: 'danger icon', title: 'Refuser', onclick: e => { e.stopPropagation(); friendAction('remove', id); } }, '✕'))));
    }
  }
  // serveur
  items.push(h('div', { class: 'sec' }, 'Serveur'));
  if (server && server.joined) {
    const n = unread.get('srv');
    items.push(navItem(view && view.type === 'server', h('div', { class: 'avatar' }, 'F'), `# ${server.channel.name}`, `${server.name} · ${server.count} membres`,
      () => select({ type: 'server' }), n ? h('span', { class: 'badge' }, n) : null));
  } else if (server) {
    items.push(h('button', { class: 'joinbtn', onclick: joinPopup }, `Rejoindre ${server.name}`));
  }
  // amis
  items.push(h('div', { class: 'sec' }, 'Amis'));
  const addRow = h('form', { class: 'item', style: 'cursor:default;gap:6px;padding:4px 6px', onsubmit: async ev => {
    ev.preventDefault(); const inp = ev.target.elements.u; const v = inp.value.trim(); if (!v) return;
    try { const r = await api('/api/friends/add', { method: 'POST', body: { username: v } }); inp.value = ''; toast(r.result === 'accepted' ? `Vous êtes maintenant amis avec ${r.user.name} !` : `Demande envoyée à ${r.user.name}.`); putUser(r.user); loadFriends(); }
    catch (e) { fail(e); }
  } }, h('input', { name: 'u', placeholder: 'Ajouter : @sous-pseudo', style: 'padding:7px 10px;font-size:13px', autocomplete: 'off', spellcheck: 'false' }), h('button', { class: 'icon', title: 'Envoyer la demande' }, '+'));
  items.push(addRow);
  const fr = [...rel.friends].sort((a, b) => (online.has(b) - online.has(a)) || userOf(a).name.localeCompare(userOf(b).name));
  if (!fr.length) items.push(h('div', { class: 'empty' }, 'Aucun ami pour le moment. Ajoute quelqu\'un avec son @sous-pseudo.'));
  for (const id of fr) {
    const u = userOf(id), n = unread.get('dm' + id);
    items.push(navItem(view && view.type === 'dm' && view.id === id, avatar(u, 'st'), nameEl(u, false), online.has(id) ? 'En ligne' : 'Hors ligne',
      () => select({ type: 'dm', id }), n ? h('span', { class: 'badge' }, n) : null, !online.has(id)));
  }
  if (rel.outgoing.length) {
    items.push(h('div', { class: 'sec' }, 'En attente'));
    for (const id of rel.outgoing) {
      const u = userOf(id);
      items.push(navItem(false, avatar(u), u.name, `@${u.username}`, () => userCard(id),
        h('button', { class: 'ghost icon', title: 'Annuler', onclick: e => { e.stopPropagation(); friendAction('remove', id); } }, '✕'), true));
    }
  }
  if (canInstall()) items.push(h('button', { class: 'joinbtn ghost', style: 'margin-top:14px', onclick: installApp }, '📲 Installer FadeAway'));
  nav.replaceChildren(...items);
}
async function friendAction(kind, id) {
  try { await api('/api/friends/' + kind, { method: 'POST', body: { id } }); if (kind === 'remove' && view && view.type === 'dm' && view.id === id) { view = null; renderAll(); } loadFriends(); }
  catch (e) { fail(e); }
}

const setChatOpen = on => document.body.classList.toggle('chat-open', !!on);
$('backBtn').addEventListener('click', () => { view = null; setChatOpen(false); renderAll(); });
function select(v, silent) {
  view = v; setChatOpen(true);
  if (v.type === 'dm') { unread.delete('dm' + v.id); if (!silent && !dmMsgs.has(v.id)) dmMsgs.set(v.id, []); loadDM(v.id); }
  else { unread.delete('srv'); loadChan(); }
  renderNav(); renderHeader(); renderMessages(); renderMembers(); renderMuteNote();
  $('msgInput').disabled = false; $('msgInput').focus();
}

function renderHeader() {
  const t = $('chatTitle'), call = $('callBtn'), mb = $('membersBtn');
  call.hidden = true; mb.hidden = true;
  if (!view) { t.replaceChildren('Sélectionne quelqu\'un'); $('msgInput').disabled = true; return; }
  if (view.type === 'dm') {
    const u = userOf(view.id);
    t.replaceChildren(avatar(u, 'st'), nameEl(u), h('span', { class: 'num' }, `@${u.username}`));
    t.style.cursor = 'pointer'; t.onclick = () => userCard(view.id);
    call.hidden = !!callState; call.disabled = !online.has(view.id);
    call.title = online.has(view.id) ? '' : 'Cette personne est hors ligne';
  } else {
    t.replaceChildren(h('span', {}, '# ' + (server ? server.channel.name : 'général')), h('span', { class: 'num' }, server ? server.name : ''));
    t.style.cursor = ''; t.onclick = null; mb.hidden = false;
  }
}

function renderMuteNote() {
  const n = $('muteNote');
  if (me && me.mute) {
    n.hidden = false;
    n.textContent = `🔇 Tu es muet ${me.mute.until ? 'jusqu\'au ' + new Date(me.mute.until).toLocaleString('fr-FR') : 'définitivement'}${me.mute.reason ? ' : ' + me.mute.reason : ''}`;
  } else n.hidden = true;
}

function currentMsgs() {
  if (!view) return [];
  return view.type === 'dm' ? (dmMsgs.get(view.id) || []) : chanMsgs;
}
function renderMessages() {
  const box = $('messages');
  const list = currentMsgs();
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (!view) { box.replaceChildren(h('div', { class: 'hello' }, h('b', {}, `Salut ${me ? me.name : ''} 👋`), 'Choisis un ami à gauche pour discuter ou l\'appeler, ou rejoins le salon du serveur.')); return; }
  if (!list.length) {
    box.replaceChildren(h('div', { class: 'hello' }, h('b', {}, view.type === 'dm' ? `Début de ta discussion avec ${userOf(view.id).name}` : 'Bienvenue dans #général'), 'Écris le premier message !'));
    return;
  }
  const out = []; let prev = null;
  for (const m of list) {
    const first = !prev || prev.from !== m.from || m.ts - prev.ts > 5 * 60000;
    const u = userOf(m.from);
    out.push(h('div', { class: 'msg' + (first ? ' first' : '') },
      first ? h('div', { onclick: () => userCard(m.from), style: 'cursor:pointer' }, avatar(u)) : h('div', { class: 'gutter' }, fmtTime(m.ts)),
      h('div', { style: 'min-width:0' },
        first ? h('div', { class: 'meta', onclick: () => userCard(m.from) }, nameEl(u, false), h('small', {}, `${fmtDay(m.ts)} ${fmtTime(m.ts)}`)) : null,
        h('div', { class: 'body2' }, m.text))));
    prev = m;
  }
  box.replaceChildren(...out);
  if (stick || list.length < 2) box.scrollTop = box.scrollHeight;
}
function renderMembers() {
  const box = $('members');
  const vis = showMembers && view && view.type === 'server' && server && server.joined;
  box.hidden = !vis; if (!vis) return;
  const ms = [...server.members].sort((a, b) => (online.has(b.id) - online.has(a.id)) || a.name.localeCompare(b.name));
  box.replaceChildren(h('div', { class: 'sec' }, `Membres — ${ms.length}`),
    ...ms.map(m => { const u = userOf(m.id); return navItem(false, avatar(u, 'st'), nameEl(u, false), `@${u.username}`, () => userCard(m.id), null, !online.has(m.id)); }));
}
$('membersBtn').addEventListener('click', () => { showMembers = !showMembers; renderMembers(); });

/* ---- envoi de messages ---- */
const msgInput = $('msgInput');
msgInput.addEventListener('input', () => { msgInput.style.height = 'auto'; msgInput.style.height = Math.min(160, msgInput.scrollHeight) + 'px'; });
msgInput.addEventListener('keydown', ev => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); $('msgForm').requestSubmit(); } });
$('msgForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const text = msgInput.value.trim(); if (!text || !view) return;
  msgInput.value = ''; msgInput.style.height = 'auto';
  try {
    if (view.type === 'dm') await api('/api/dm', { method: 'POST', body: { to: view.id, text } });
    else await api('/api/server/send', { method: 'POST', body: { text } });
  } catch (e) { msgInput.value = text; fail(e); }
});

/* ============================== fenêtres ============================== */
function modal(content, onclose) {
  const ov = h('div', { class: 'ov', onmousedown: ev => { if (ev.target === ov) closeModal(); } }, content);
  ov._onclose = onclose;
  $('modals').replaceChildren(ov);
  return ov;
}
function closeModal() { const o = $('modals').firstChild; if (o && o._onclose) o._onclose(); $('modals').replaceChildren(); }
document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && $('modals').firstChild) closeModal(); });

function joinPopup() {
  if ($('modals').querySelector('.hero')) return;
  modal(h('div', { class: 'modal center' },
    h('img', { class: 'hero', src: 'logo.svg', alt: '' }),
    h('h2', {}, `Bienvenue sur FadeAway, ${me.name} !`),
    h('p', {}, 'Veux-tu rejoindre le serveur FadeAway ? Tu y retrouveras la communauté dans le salon #général. Tu pourras toujours le rejoindre plus tard.'),
    h('div', { class: 'actions', style: 'justify-content:center' },
      h('button', { class: 'ghost', onclick: async () => { closeModal(); try { await api('/api/server/skip', { method: 'POST' }); } catch (e) { fail(e); } } }, 'Plus tard'),
      h('button', { onclick: async () => {
        try { await api('/api/server/join', { method: 'POST' }); closeModal(); await loadServer(); select({ type: 'server' }); } catch (e) { fail(e); }
      } }, 'Rejoindre le serveur'))));
}

function userCard(id) {
  const u = userOf(id);
  const isMe = id === me.id, isFriend = rel.friends.includes(id), inc = rel.incoming.includes(id), out = rel.outgoing.includes(id);
  const acts = [];
  if (!isMe) {
    if (isFriend) {
      acts.push(h('button', { onclick: () => { closeModal(); select({ type: 'dm', id }); } }, 'Message'));
      acts.push(h('button', { class: 'danger', onclick: () => { closeModal(); friendAction('remove', id); } }, 'Retirer des amis'));
    } else if (inc) acts.push(h('button', { onclick: () => { closeModal(); friendAction('accept', id); } }, 'Accepter la demande'));
    else if (out) acts.push(h('button', { class: 'ghost', onclick: () => { closeModal(); friendAction('remove', id); } }, 'Annuler la demande'));
    else acts.push(h('button', { onclick: async () => { try { await api('/api/friends/add', { method: 'POST', body: { username: u.username } }); toast('Demande envoyée.'); closeModal(); loadFriends(); } catch (e) { fail(e); } } }, 'Ajouter en ami'));
  } else acts.push(h('button', { onclick: profileModal }, 'Modifier mon profil'));
  modal(h('div', { class: 'modal pcard' },
    h('div', { class: 'bn', style: bannerStyle(u.banner) }),
    h('div', { class: 'av' }, avatar(u, 'xl')),
    h('div', { class: 'who' }, h('div', { class: 'nm' }, nameEl(u)), h('div', { class: 'sb' }, `@${u.username} · membre depuis le ${new Date(u.since).toLocaleDateString('fr-FR')}`)),
    h('div', { class: 'actions' }, ...acts, h('button', { class: 'ghost', onclick: closeModal }, 'Fermer'))));
}

/* ---- images : réduction avant envoi (sauf GIF, envoyés tels quels) ---- */
async function prepImage(file, max) {
  if (file.type === 'image/gif') return { blob: file, gif: true };
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error("Ce fichier n'est pas une image lisible.");
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise(r => c.toBlob(r, 'image/webp', 0.92));
  if (!blob) throw new Error("Impossible de traiter l'image.");
  return { blob, gif: false };
}

function profileModal() {
  const line = h('div', { class: 'msgline' });
  const say = (t, good) => { line.textContent = t; line.className = 'msgline ' + (good ? 'good' : 'bad'); };
  const body = h('div', { class: 'modal wide' });
  const wrap = h('div', {});
  body.append(wrap);
  const prem = me.premium;

  const draw = () => {
    const nameIn = h('input', { value: me.name, maxlength: 32 });
    const avFile = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
    const bnFile = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
    const colorIn = h('input', { type: 'color', value: me.banner.type === 'color' && isHex(me.banner.value) ? me.banner.value : '#ff529a' });
    const swatches = ['#ff529a', '#ff9e6b', '#ffd400', '#2ee59d', '#12b5c9', '#7c5cff', '#14091f'].map(c => h('i', { style: `background:${c}`, onclick: () => saveBannerColor(c) }));
    const saveBannerColor = async c => { try { await api('/api/profile', { method: 'POST', body: { banner: { type: 'color', value: c } } }); say('Bannière mise à jour.', true); } catch (e) { say(e.message); } };
    const up = async (kind, input, type) => {
      const f = input.files[0]; if (!f) return say('Choisis d\'abord un fichier.');
      try {
        if (kind === 'avatar' && f.type === 'image/gif' && !me.premium) return say("L'avatar animé (GIF) est réservé à FadeAway Premium ✦");
        if (type === 'gif' && f.type !== 'image/gif') return say('Choisis un fichier .gif.');
        const { blob, gif } = await prepImage(f, kind === 'avatar' ? 512 : 1400);
        await api(kind === 'avatar' ? '/api/profile/avatar' : `/api/profile/banner?type=${type === 'gif' ? 'gif' : 'image'}`, { method: 'PUT', raw: blob });
        input.value = ''; say(kind === 'avatar' ? 'Photo de profil mise à jour.' : 'Bannière mise à jour.', true);
      } catch (e) { say(e.message); }
    };
    let bnMode = 'color';
    const bnBox = h('div', {});
    const drawBn = () => {
      bnBox.replaceChildren(
        h('div', { class: 'seg' }, ...[['color', 'Couleur'], ['image', 'Image'], ['gif', 'GIF']].map(([k, l]) => h('button', { type: 'button', class: bnMode === k ? 'on' : '', onclick: () => { bnMode = k; drawBn(); } }, l))),
        bnMode === 'color' ? h('div', { class: 'row' }, colorIn, h('button', { class: 'small', onclick: () => saveBannerColor(colorIn.value) }, 'Appliquer'), h('div', { class: 'sw' }, ...swatches))
          : h('div', { class: 'row' }, bnMode === 'gif' ? bnFile : bnFile, h('button', { class: 'small', onclick: () => up('banner', bnFile, bnMode) }, 'Envoyer')));
      bnFile.accept = bnMode === 'gif' ? 'image/gif' : 'image/png,image/jpeg,image/webp';
    };
    drawBn();

    const g1 = h('input', { type: 'color', value: (me.gradient && me.gradient[0]) || '#ff529a' });
    const g2 = h('input', { type: 'color', value: (me.gradient && me.gradient[1]) || '#ffd400' });
    const au = h('input', { type: 'color', value: me.aura || '#ff529a' });
    const premium = me.premium ? h('div', {},
      h('h3', {}, '✦ Avantages Premium'),
      h('div', { class: 'row' }, h('span', {}, 'Nom en dégradé'), g1, g2,
        h('button', { class: 'small', onclick: async () => { try { await api('/api/profile', { method: 'POST', body: { nameGradient: [g1.value, g2.value] } }); say('Dégradé appliqué.', true); } catch (e) { say(e.message); } } }, 'Appliquer'),
        h('button', { class: 'small ghost', onclick: async () => { try { await api('/api/profile', { method: 'POST', body: { nameGradient: null } }); say('Dégradé retiré.', true); } catch (e) { say(e.message); } } }, 'Retirer')),
      h('div', { class: 'row', style: 'margin-top:8px' }, h('span', {}, 'Aura de la photo'), au,
        h('button', { class: 'small', onclick: async () => { try { await api('/api/profile', { method: 'POST', body: { aura: au.value } }); say('Aura appliquée.', true); } catch (e) { say(e.message); } } }, 'Appliquer'),
        h('button', { class: 'small ghost', onclick: async () => { try { await api('/api/profile', { method: 'POST', body: { aura: null } }); say('Aura retirée.', true); } catch (e) { say(e.message); } } }, 'Retirer')),
      h('p', { style: 'margin:8px 0 0;font-size:13px' }, `Avatar animé (GIF) · messages jusqu'à 4000 caractères · badge ✦. ${me.premiumUntil ? 'Expire le ' + new Date(me.premiumUntil).toLocaleDateString('fr-FR') + '.' : 'À vie.'}`))
      : h('div', { class: 'lock' }, h('b', {}, '✦ FadeAway Premium'), 'Badge ✦, nom en dégradé animé, aura autour de ta photo, avatar GIF animé et messages de 4000 caractères. Il se débloque uniquement via un administrateur.');

    wrap.replaceChildren(
      h('h2', {}, 'Mon profil'),
      h('p', {}, `@${me.username} · #${me.id} · ${me.email}`),
      h('h3', {}, 'Pseudo'),
      h('div', { class: 'row' }, nameIn, h('button', { class: 'small', onclick: async () => { try { await api('/api/profile', { method: 'POST', body: { name: nameIn.value } }); say('Pseudo mis à jour.', true); } catch (e) { say(e.message); } } }, 'Enregistrer')),
      h('h3', {}, 'Photo de profil (image obligatoire)'),
      h('div', { class: 'row' }, avFile, h('button', { class: 'small', onclick: () => up('avatar', avFile) }, 'Envoyer')),
      h('h3', {}, 'Bannière'), bnBox, premium, line,
      h('div', { class: 'actions' }, h('button', { class: 'ghost', onclick: closeModal }, 'Fermer')));
  };
  draw();
  modal(body);
  // redessine quand le profil change (ex : Premium donné pendant que la fenêtre est ouverte), sans casser la saisie
  let last = JSON.stringify([me.premium, me.op]);
  const iv = setInterval(() => { if (!$('modals').contains(body)) return clearInterval(iv); const now = JSON.stringify([me.premium, me.op]); if (now !== last) { last = now; draw(); } }, 800);
}

/* ============================== console OP ============================== */
let cmdHist = [], cmdPos = 0;
function setupConsole() { $('consoleBox').hidden = true; }
function toggleConsole() {
  if (!me || !me.op) return;
  const b = $('consoleBox'); b.hidden = !b.hidden;
  if (!b.hidden) { if (!$('consoleOut').childNodes.length) cprint('Console OP — tape « help » pour la liste des commandes.', 'dim'); $('consoleIn').focus(); }
}
function cprint(t, cls) { const d = h('div', { class: cls || '' }, t); $('consoleOut').append(d); $('consoleOut').scrollTop = 1e9; }
$('consoleClose').addEventListener('click', () => { $('consoleBox').hidden = true; });
$('consoleForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const line = $('consoleIn').value.trim(); if (!line) return;
  $('consoleIn').value = ''; cmdHist.push(line); cmdPos = cmdHist.length;
  cprint('> ' + line, 'in');
  try { const r = await api('/api/console', { method: 'POST', body: { line } }); (r.out || []).forEach(l => cprint(l, r.ok ? '' : 'bad')); }
  catch (e) { cprint(e.message, 'bad'); if (e.status === 403) toggleConsole(); }
});
$('consoleIn').addEventListener('keydown', ev => {
  if (ev.key === 'ArrowUp' && cmdPos > 0) { $('consoleIn').value = cmdHist[--cmdPos]; ev.preventDefault(); }
  if (ev.key === 'ArrowDown') { cmdPos = Math.min(cmdHist.length, cmdPos + 1); $('consoleIn').value = cmdHist[cmdPos] || ''; ev.preventDefault(); }
});
document.addEventListener('keydown', ev => { if (ev.key === 'F2' && !$('app').hidden) { ev.preventDefault(); toggleConsole(); } });

/* ============================== audio : micro, qualité, isolation de la voix ============================== */
const AUDIO_DEF = { mic: '', spk: '', echo: true, agc: true, iso: 'standard', gateDb: -48, quality: 'high', vol: 1 };
let audioCfg = { ...AUDIO_DEF };
try { audioCfg = { ...AUDIO_DEF, ...JSON.parse(store.get('fa_audio') || '{}') }; } catch {}
const saveAudio = () => store.set('fa_audio', JSON.stringify(audioCfg));
const BITRATE = { normal: 32000, high: 64000, max: 128000 };

let actx = null;
function ctx() {
  if (!actx) { const C = window.AudioContext || window.webkitAudioContext; if (C) { try { actx = new C({ latencyHint: 'interactive' }); } catch {} } }
  if (actx && actx.state === 'suspended') actx.resume().catch(() => {});
  return actx;
}

// filtre anti-bruit (gate) : coupe le son quand tu ne parles pas, ouverture rapide, fermeture douce
const GATE_CODE = `class FaGate extends AudioWorkletProcessor {
  constructor() { super(); this.thr = Math.pow(10, -48 / 20); this.g = 0; this.target = 0; this.hold = 0;
    this.port.onmessage = e => { if (e.data && e.data.thr != null) this.thr = Math.pow(10, e.data.thr / 20); }; }
  process(inputs, outputs) {
    const i = inputs[0], o = outputs[0];
    if (!i || !i[0]) return true;
    const n = i[0].length; let s = 0;
    for (let k = 0; k < n; k++) s += i[0][k] * i[0][k];
    const rms = Math.sqrt(s / n);
    if (rms > this.thr) { this.hold = sampleRate * 0.3; this.target = 1; }
    else if (this.hold > 0) this.hold -= n; else this.target = 0;
    const rate = this.target > this.g ? 0.015 : 0.0004;
    for (let k = 0; k < n; k++) {
      this.g += (this.target - this.g) * rate;
      for (let c = 0; c < o.length; c++) o[c][k] = (i[c] || i[0])[k] * this.g;
    }
    return true;
  }
}
registerProcessor('fa-gate', FaGate);`;
let gateReady = null;
function loadGate(c) {
  if (!gateReady) gateReady = c.audioWorklet.addModule(URL.createObjectURL(new Blob([GATE_CODE], { type: 'text/javascript' })));
  return gateReady;
}

// ouvre le micro avec les réglages ; renvoie { track, stream, level(), setGate(db), stop(), strong }
async function openMic(cfg = audioCfg) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("Le micro n'est pas disponible ici (il faut une connexion HTTPS).");
  const base = { echoCancellation: cfg.echo, noiseSuppression: cfg.iso !== 'off', autoGainControl: cfg.agc, channelCount: 1, voiceIsolation: cfg.iso === 'strong' };
  let raw = null, err = null;
  for (const a of [cfg.mic ? { ...base, deviceId: { exact: cfg.mic } } : base, base, true]) {
    try { raw = await navigator.mediaDevices.getUserMedia({ audio: a }); break; } catch (e) { err = e; }
  }
  if (!raw) throw err;
  const hd = { raw, strong: false, nodes: [] };
  let out = raw, analyser = null, gate = null;
  const c = ctx();
  if (c) {
    try {
      const src = c.createMediaStreamSource(raw);
      analyser = c.createAnalyser(); analyser.fftSize = 1024; src.connect(analyser);
      hd.nodes.push(src, analyser);
      if (cfg.iso === 'strong') {
        await loadGate(c);
        const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 100; hp.Q.value = 0.7;
        gate = new AudioWorkletNode(c, 'fa-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        gate.port.postMessage({ thr: cfg.gateDb });
        const dest = c.createMediaStreamDestination();
        src.connect(hp); hp.connect(gate); gate.connect(dest);
        hd.nodes.push(hp, gate, dest); out = dest.stream; hd.strong = true;
      }
    } catch (e) { console.warn('traitement audio indisponible', e); out = raw; gate = null; hd.strong = false; }
  }
  hd.track = out.getAudioTracks()[0];
  hd.stream = new MediaStream([hd.track]);
  const buf = analyser ? new Uint8Array(analyser.fftSize) : null;
  hd.level = () => {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(buf); let s = 0;
    for (const v of buf) { const x = (v - 128) / 128; s += x * x; }
    return Math.sqrt(s / buf.length);
  };
  hd.setGate = db => { if (gate) gate.port.postMessage({ thr: db }); };
  hd.stop = () => {
    raw.getTracks().forEach(t => t.stop()); out.getTracks().forEach(t => t.stop());
    hd.nodes.forEach(n => { try { n.disconnect(); } catch {} });
  };
  return hd;
}
const micError = e => (e && e.name === 'NotAllowedError') ? "Micro refusé : autorise-le dans les réglages du navigateur."
  : (e && e.name === 'NotFoundError') ? 'Aucun micro détecté.' : (e && e.message) || 'Micro indisponible.';

// règle l'Opus de WebRTC : débit, correction d'erreurs, mono
function tuneSdp(sdp) {
  const m = /a=rtpmap:(\d+) opus\/48000\/2/.exec(sdp); if (!m) return sdp;
  const pt = m[1], re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), f = re.exec(sdp);
  const params = new Map(f ? f[1].split(';').filter(Boolean).map(p => p.split('=')) : []);
  const want = { maxaveragebitrate: BITRATE[audioCfg.quality] || 64000, useinbandfec: 1, usedtx: 0, stereo: 0, 'sprop-stereo': 0, cbr: 0 };
  for (const [k, v] of Object.entries(want)) params.set(k, String(v));
  const line = `a=fmtp:${pt} ` + [...params].map(([k, v]) => (v === undefined ? k : `${k}=${v}`)).join(';');
  return f ? sdp.replace(re, line) : sdp.replace(m[0], m[0] + '\r\n' + line);
}
async function applyBitrate(c) {
  if (!c || !c.micSender) return;
  try {
    const p = c.micSender.getParameters(); if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = BITRATE[audioCfg.quality] || 64000; p.encodings[0].networkPriority = 'high'; p.encodings[0].priority = 'high';
    await c.micSender.setParameters(p);
  } catch {}
}

/* ---- sortie audio : une balise <audio> par flux reçu (plus fiable qu'une balise vidéo cachée) ---- */
const audios = new Map();
function addAudio(stream) {
  if (audios.has(stream.id)) return;
  const a = h('audio', { autoplay: true, playsinline: true }); a.srcObject = stream; a.volume = audioCfg.vol;
  if (audioCfg.spk && a.setSinkId) a.setSinkId(audioCfg.spk).catch(() => {});
  $('audios').append(a); audios.set(stream.id, a);
  const p = a.play(); if (p && p.catch) p.catch(() => { $('audioFix').hidden = false; });
}
function clearAudios() { audios.forEach(a => { a.srcObject = null; a.remove(); }); audios.clear(); $('audioFix').hidden = true; }
$('audioFix').addEventListener('click', () => {
  ctx(); audios.forEach(a => a.play().catch(() => {})); callState && callState.tiles.forEach(t => t.v.play && t.v.play().catch(() => {}));
  $('audioFix').hidden = true;
});
function applyOutput() {
  audios.forEach(a => { a.volume = audioCfg.vol; if (audioCfg.spk && a.setSinkId) a.setSinkId(audioCfg.spk).catch(() => {}); });
}

// indicateur « parle » autour d'une tuile
function watchLevel(stream, el) {
  const c = ctx(); if (!c || !stream.getAudioTracks().length) return () => {};
  let an, src;
  try { src = c.createMediaStreamSource(stream); an = c.createAnalyser(); an.fftSize = 512; src.connect(an); } catch { return () => {}; }
  const b = new Uint8Array(an.fftSize);
  const iv = setInterval(() => {
    an.getByteTimeDomainData(b); let s = 0; for (const v of b) { const x = (v - 128) / 128; s += x * x; }
    el.classList.toggle('speaking', Math.sqrt(s / b.length) > 0.03);
  }, 120);
  return () => { clearInterval(iv); try { src.disconnect(); } catch {} el.classList.remove('speaking'); };
}

/* ---- fenêtre « Audio et voix » ---- */
function audioModal() {
  let test = null, loop = null, meter = null;
  const stopTest = () => { clearInterval(meter); meter = null; if (test) { test.stop(); test = null; } if (loop) { loop.srcObject = null; loop = null; } bar.style.width = '0'; testBtn.textContent = '🎙️ Tester mon micro'; };
  const bar = h('i', { style: 'display:block;height:100%;width:0;background:linear-gradient(90deg,#2ee59d,#ffd400,#ff529a);transition:width .08s' });
  const testBtn = h('button', { class: 'small', type: 'button' }, '🎙️ Tester mon micro');
  const hear = h('input', { type: 'checkbox', style: 'width:auto' });
  const startTest = async () => {
    stopTest();
    try {
      test = await openMic();
      testBtn.textContent = '⏹ Arrêter le test';
      loop = h('audio', { autoplay: true }); loop.srcObject = test.stream; loop.muted = !hear.checked;
      meter = setInterval(() => { bar.style.width = Math.min(100, test ? test.level() * 400 : 0) + '%'; }, 60);
    } catch (e) { toast(micError(e), true); }
  };
  testBtn.onclick = () => (test ? stopTest() : startTest());
  hear.onchange = () => { if (loop) loop.muted = !hear.checked; };

  const changed = async () => {
    saveAudio();
    if (callState && callState.pc) { await rebuildMic(); applyBitrate(callState); }
    applyOutput();
    if (test) startTest();
  };
  const sel = (key, opts, extra) => {
    const s = h('select', { style: 'width:100%' }, ...opts.map(([v, l]) => h('option', { value: v }, l)));
    s.value = audioCfg[key]; s.onchange = () => { audioCfg[key] = s.value; changed(); if (extra) extra(); }; return s;
  };
  const seg = (key, opts) => {
    const box = h('div', { class: 'seg' });
    const draw = () => box.replaceChildren(...opts.map(([v, l]) => h('button', { type: 'button', class: audioCfg[key] === v ? 'on' : '', onclick: () => { audioCfg[key] = v; draw(); changed(); gateRow.hidden = audioCfg.iso !== 'strong'; } }, l)));
    draw(); return box;
  };
  const chk = (key, label) => {
    const i = h('input', { type: 'checkbox', style: 'width:auto' }); i.checked = !!audioCfg[key];
    i.onchange = () => { audioCfg[key] = i.checked; changed(); };
    return h('label', { style: 'display:flex;gap:10px;align-items:center;margin:6px 0;cursor:pointer' }, i, label);
  };
  const gateIn = h('input', { type: 'range', min: -70, max: -25, step: 1, value: audioCfg.gateDb });
  const gateVal = h('span', {}, audioCfg.gateDb + ' dB');
  gateIn.oninput = () => { audioCfg.gateDb = Number(gateIn.value); gateVal.textContent = audioCfg.gateDb + ' dB'; if (test) test.setGate(audioCfg.gateDb); if (callState && callState.mic) callState.mic.setGate(audioCfg.gateDb); saveAudio(); };
  const gateRow = h('div', { style: 'margin-top:8px' }, h('div', { class: 'row', style: 'justify-content:space-between' }, h('span', {}, 'Sensibilité du filtre (plus bas = plus sensible)'), gateVal), gateIn);
  gateRow.hidden = audioCfg.iso !== 'strong';
  const volIn = h('input', { type: 'range', min: 0, max: 100, step: 1, value: Math.round(audioCfg.vol * 100) });
  volIn.oninput = () => { audioCfg.vol = volIn.value / 100; saveAudio(); applyOutput(); };

  const micSel = h('select', { style: 'width:100%' }), spkSel = h('select', { style: 'width:100%' });
  const spkRow = h('div', {}, h('h3', {}, 'Haut-parleur / casque'), spkSel);
  const fillDevices = async () => {
    try { const t = await navigator.mediaDevices.getUserMedia({ audio: true }); t.getTracks().forEach(x => x.stop()); } catch {}
    let devs = []; try { devs = await navigator.mediaDevices.enumerateDevices(); } catch {}
    const mics = devs.filter(d => d.kind === 'audioinput'), spks = devs.filter(d => d.kind === 'audiooutput');
    micSel.replaceChildren(h('option', { value: '' }, 'Par défaut'), ...mics.map((d, i) => h('option', { value: d.deviceId }, d.label || 'Micro ' + (i + 1))));
    micSel.value = mics.some(d => d.deviceId === audioCfg.mic) ? audioCfg.mic : '';
    spkSel.replaceChildren(h('option', { value: '' }, 'Par défaut'), ...spks.map((d, i) => h('option', { value: d.deviceId }, d.label || 'Sortie ' + (i + 1))));
    spkSel.value = spks.some(d => d.deviceId === audioCfg.spk) ? audioCfg.spk : '';
  };
  micSel.onchange = () => { audioCfg.mic = micSel.value; changed(); };
  spkSel.onchange = () => { audioCfg.spk = spkSel.value; changed(); };
  spkRow.hidden = !('setSinkId' in HTMLMediaElement.prototype);
  fillDevices();

  modal(h('div', { class: 'modal wide' },
    h('h2', {}, '🎧 Audio et voix'),
    h('p', {}, 'Les réglages s\'appliquent tout de suite, même pendant un appel.'),
    h('h3', {}, 'Micro'), micSel,
    spkRow,
    h('h3', {}, 'Isolation de la voix'),
    seg('iso', [['off', 'Aucune'], ['standard', 'Standard'], ['strong', 'Forte']]),
    h('p', { style: 'font-size:12.5px;margin:4px 0' }, 'Standard : réduction de bruit du navigateur. Forte : réduction du navigateur + isolation de la voix quand l\'appareil le permet + filtre qui coupe tout ce qui n\'est pas ta voix.'),
    gateRow,
    h('h3', {}, 'Traitements'), chk('echo', 'Annulation d\'écho (évite que l\'autre s\'entende)'), chk('agc', 'Volume automatique du micro'),
    h('h3', {}, 'Qualité du son envoyé'),
    sel('quality', [['normal', 'Économique — 32 kb/s'], ['high', 'Haute — 64 kb/s (recommandé)'], ['max', 'Maximale — 128 kb/s']]),
    h('h3', {}, 'Volume de la voix des autres'), volIn,
    h('h3', {}, 'Test'),
    h('div', { class: 'row' }, testBtn, h('label', { style: 'display:flex;gap:6px;align-items:center;cursor:pointer;font-size:13px' }, hear, 'M\'écouter (mets un casque)')),
    h('div', { style: 'height:8px;border-radius:8px;background:rgba(255,255,255,.1);overflow:hidden;margin-top:10px' }, bar),
    h('div', { class: 'actions' }, h('button', { class: 'ghost', onclick: () => { audioCfg = { ...AUDIO_DEF }; saveAudio(); closeModal(); changed(); audioModal(); } }, 'Réinitialiser'), h('button', { onclick: closeModal }, 'Fermer'))),
    stopTest);
}

/* ============================== appels WebRTC (pair à pair) ============================== */
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
async function loadIce() { try { const r = await api('/api/ice'); if (r.iceServers && r.iceServers.length) iceServers = r.iceServers; } catch {} }
let callState = null;   // { peer, phase: 'out'|'in'|'on', pc, polite, making, ignore, mic, main, micSender, screen, camTrack, camSender, scrSender, remoteScreenIds, tiles, pendingIce, ringT }

const sig = (to, data) => api('/api/signal', { method: 'POST', body: { to, data } }).catch(() => {});
let sigChain = Promise.resolve();       // les messages de signalisation sont traités UN PAR UN, dans l'ordre
const onSignal = (from, d) => { sigChain = sigChain.then(() => handleSignal(from, d)).catch(e => console.warn('signal', e)); };

async function startCall(peer) {
  if (callState) return;
  if (!online.has(peer)) return toast('Cette personne est hors ligne.', true);
  callState = { phase: 'out', peer, tiles: new Map(), remoteScreenIds: new Set(), pendingIce: [] };
  renderHeader(); renderCallUi();
  const [mic] = await Promise.all([openMic().catch(e => { toast(micError(e) + ' Tu seras en écoute seulement.', true); return null; }), loadIce()]);
  if (!callState) { mic && mic.stop(); return; }
  callState.mic = mic; callState.main = new MediaStream(mic ? [mic.track] : []);
  await sig(peer, { t: 'invite' });
  callState.ringT = setTimeout(() => { if (callState && callState.phase === 'out') { toast('Pas de réponse.', true); endCall(true); } }, 40000);
}
function incomingCall(from) {
  callState = { phase: 'in', peer: from, tiles: new Map(), remoteScreenIds: new Set(), pendingIce: [] };
  callState.ringT = setTimeout(() => { if (callState && callState.phase === 'in') endCall(false); }, 40000);
  renderHeader(); renderCallUi(); renderNav();
}
async function acceptCall() {
  if (!callState || callState.phase !== 'in') return;
  const c = callState, peer = c.peer; clearTimeout(c.ringT);
  c.phase = 'on'; ctx();                  // le clic débloque la lecture audio du navigateur
  const [mic] = await Promise.all([openMic().catch(e => { toast(micError(e) + ' Tu seras en écoute seulement.', true); return null; }), loadIce()]);
  if (callState !== c) { mic && mic.stop(); return; }
  c.mic = mic; c.main = new MediaStream(mic ? [mic.track] : []);
  await sig(peer, { t: 'accept' });
  makePeer(false); renderCallUi(); select({ type: 'dm', id: peer });
}
function declineCall() { if (callState && callState.phase === 'in') endCall(true); }

function setStatus(t) { $('callStatus').textContent = t || ''; }

function makePeer() {
  const c = callState, pc = new RTCPeerConnection({ iceServers });
  $('tiles').replaceChildren();
  c.pc = pc; c.polite = me.id > c.peer; c.making = false; c.ignore = false; c.restarts = 0;
  const audioTrack = c.main.getAudioTracks()[0];
  if (audioTrack) c.micSender = pc.addTrack(audioTrack, c.main);
  else { c.micTr = pc.addTransceiver('audio', { direction: 'recvonly' }); }   // écoute seule : il faut quand même une ligne audio
  c.main.getVideoTracks().forEach(t => pc.addTrack(t, c.main));
  addTile('me', me, c.main, true);
  pc.onnegotiationneeded = async () => {
    try {
      c.making = true;
      const o = await pc.createOffer(); if (pc.signalingState !== 'stable') return;
      o.sdp = tuneSdp(o.sdp); await pc.setLocalDescription(o);
      sig(c.peer, { t: 'desc', d: pc.localDescription });
    } catch (e) { console.warn('négociation', e); } finally { c.making = false; }
  };
  pc.onicecandidate = ev => { if (ev.candidate) sig(c.peer, { t: 'ice', c: ev.candidate }); };
  pc.ontrack = ev => {
    let s = ev.streams[0];
    if (!s) { s = c.orphan || (c.orphan = new MediaStream()); s.addTrack(ev.track); }
    addAudio(s); addTile('s' + s.id, userOf(c.peer), s, false);
    const refresh = () => { if (!s.getTracks().length) removeTile('s' + s.id); else refreshTile('s' + s.id); };
    s.onremovetrack = refresh; s.onaddtrack = refresh;
    ev.track.onmute = refresh; ev.track.onunmute = refresh; ev.track.onended = refresh;
  };
  pc.oniceconnectionstatechange = () => {
    const st = pc.iceConnectionState;
    if (st === 'checking') setStatus('Connexion en cours…');
    else if (st === 'connected' || st === 'completed') { c.restarts = 0; applyBitrate(c); updateStatus(c); }
    else if (st === 'disconnected') { setStatus('Connexion instable…'); setTimeout(() => { if (callState === c && pc.iceConnectionState === 'disconnected' && !c.polite) pc.restartIce(); }, 4000); }
    else if (st === 'failed') {
      if (c.restarts++ < 2) { setStatus('Nouvelle tentative de connexion…'); if (!c.polite) pc.restartIce(); else sig(c.peer, { t: 'restart' }); }
      else { toast("Impossible de relier vos deux appareils (réseaux très restrictifs). Un serveur TURN est nécessaire : voir le README.", true); endCall(true); }
    }
  };
  c.statsT = setInterval(() => updateStatus(c), 3000);
  setStatus('Connexion en cours…');
}

// diagnostic en direct : ton micro envoie-t-il ? reçois-tu du son ?
async function updateStatus(c) {
  if (callState !== c || !c.pc) return;
  const st = c.pc.iceConnectionState;
  if (st !== 'connected' && st !== 'completed') return;
  let sent = 0, got = 0;
  try { (await c.pc.getStats()).forEach(r => { if (r.kind !== 'audio') return; if (r.type === 'outbound-rtp') sent += r.bytesSent || 0; if (r.type === 'inbound-rtp') got += r.bytesReceived || 0; }); } catch { return; }
  c.sentOk = sent > (c.lastSent || 0) + 200; c.gotOk = got > (c.lastGot || 0) + 200; c.lastSent = sent; c.lastGot = got;
  const mic = c.mic && c.mic.track;
  setStatus('Connecté ✓ · ' + (!mic ? 'tu écoutes seulement' : !mic.enabled ? 'ton micro est coupé' : c.sentOk ? 'ton micro envoie' : 'ton micro n\'envoie rien') + ' · ' + (c.gotOk ? 'tu reçois sa voix' : 'aucun son reçu pour l\'instant'));
}

async function handleSignal(from, d) {
  if (!d || typeof d !== 'object') return;
  if (d.t === 'invite') {
    if (callState) return sig(from, { t: 'busy' });
    if (!rel.friends.includes(from)) return;
    incomingCall(from); toast(`${userOf(from).name} t'appelle…`); return;
  }
  if (!callState || callState.peer !== from) return;
  const c = callState;
  switch (d.t) {
    case 'accept': if (c.phase === 'out') { clearTimeout(c.ringT); c.phase = 'on'; makePeer(); renderCallUi(); } break;
    case 'busy': toast(`${userOf(from).name} est déjà en appel.`, true); endCall(false); break;
    case 'decline': toast(`${userOf(from).name} a refusé l'appel.`, true); endCall(false); break;
    case 'end': toast('Appel terminé.'); endCall(false); break;
    case 'restart': if (c.pc && !c.polite) c.pc.restartIce(); break;
    case 'meta': if (d.screen) c.remoteScreenIds.add(d.screen); refreshTile('s' + d.screen); break;
    case 'desc': {
      const pc = c.pc; if (!pc) return;
      const collision = d.d.type === 'offer' && (c.making || pc.signalingState !== 'stable');
      c.ignore = !c.polite && collision; if (c.ignore) return;
      try {
        await pc.setRemoteDescription(d.d);
        for (const cand of c.pendingIce.splice(0)) await pc.addIceCandidate(cand).catch(() => {});
        if (d.d.type === 'offer') {
          const a = await pc.createAnswer(); a.sdp = tuneSdp(a.sdp); await pc.setLocalDescription(a);
          sig(from, { t: 'desc', d: pc.localDescription });
        }
      } catch (e) { console.warn('desc', e); }
      break;
    }
    case 'ice':
      if (!c.pc) return;
      if (!c.pc.remoteDescription) c.pendingIce.push(d.c);          // en avance sur l'offre : on garde pour plus tard
      else { try { await c.pc.addIceCandidate(d.c); } catch (e) { if (!c.ignore) console.warn('ice', e); } }
      break;
  }
}

function endCall(notify) {
  const c = callState; if (!c) return;
  callState = null;
  clearTimeout(c.ringT); clearInterval(c.statsT);
  if (notify) sig(c.peer, { t: c.phase === 'in' ? 'decline' : 'end' });
  c.tiles.forEach(t => t.unwatch && t.unwatch());
  if (c.mic) c.mic.stop();
  [c.main, c.screen].forEach(s => s && s.getTracks().forEach(t => t.stop()));
  if (c.camTrack) c.camTrack.stop();
  if (c.pc) { c.pc.oniceconnectionstatechange = null; c.pc.close(); }
  clearAudios(); setStatus('');
  $('tiles').replaceChildren(); renderCallUi(); if (me) { renderHeader(); renderNav(); }
}

// changement de micro / de réglages pendant l'appel : on remplace la piste sans renégocier
async function rebuildMic() {
  const c = callState; if (!c || !c.main) return;
  let nm;
  try { nm = await openMic(); } catch (e) { return toast(micError(e), true); }
  if (callState !== c) return nm.stop();
  const old = c.mic, wasOff = old && old.track && !old.track.enabled;
  nm.track.enabled = !wasOff;
  if (c.micSender) await c.micSender.replaceTrack(nm.track).catch(() => {});
  else if (c.micTr) {                       // il n'y avait pas de micro : on passe de « écoute » à « parle et écoute »
    c.micTr.direction = 'sendrecv'; await c.micTr.sender.replaceTrack(nm.track).catch(() => {}); c.micSender = c.micTr.sender;
    try { c.micSender.setStreams(c.main); } catch {}
  }
  if (old) { c.main.removeTrack(old.track); old.stop(); }
  c.main.addTrack(nm.track); c.mic = nm;
  const t = c.tiles.get('me'); if (t) { t.unwatch && t.unwatch(); t.unwatch = watchLevel(c.main, t.el); }
  renderCallUi();
}

/* ---- tuiles vidéo ---- */
function addTile(key, u, stream, local) {
  const c = callState; if (!c) return;
  let t = c.tiles.get(key);
  if (!t) {
    const v = h('video', { autoplay: true, playsinline: true }); v.muted = true;   // le son passe par les balises <audio>
    const label = h('div', { class: 'label' });
    const el = h('div', { class: 'tile noVideo' }, v, avatar(u, 'xl'), label);
    t = { el, v, label, u, stream, local }; c.tiles.set(key, t); $('tiles').append(el);
    t.unwatch = key === 'scr' ? null : watchLevel(stream, el);
  }
  t.stream = stream; t.v.srcObject = stream;
  t.v.play && t.v.play().catch(() => {});
  refreshTile(key);
}
function refreshTile(key) {
  const c = callState; const t = c && c.tiles.get(key); if (!t) return;
  const hasVid = t.stream.getVideoTracks().some(x => x.readyState === 'live' && !x.muted);
  t.el.classList.toggle('noVideo', !hasVid);
  const id = key.slice(1);
  const isScreen = t.local ? (key === 'scr') : c.remoteScreenIds.has(id);
  t.label.textContent = (t.local ? 'Toi' : t.u.name) + (isScreen ? ' — écran' : '');
  t.v.style.objectFit = 'contain';
}
function removeTile(key) { const c = callState; const t = c && c.tiles.get(key); if (t) { t.unwatch && t.unwatch(); t.el.remove(); c.tiles.delete(key); } }

function renderCallUi() {
  const c = callState;
  $('incoming').hidden = !(c && c.phase === 'in');
  $('call').hidden = !(c && (c.phase === 'on' || c.phase === 'out'));
  if (c && c.phase === 'in') $('incomingText').textContent = `📞 ${userOf(c.peer).name} t'appelle…`;
  if (c && c.phase === 'out') {
    $('tiles').replaceChildren(h('div', { class: 'hello', style: 'align-self:center' }, h('b', {}, `Appel de ${userOf(c.peer).name}…`), 'En attente de réponse'));
  }
  $('camBtn').className = c && c.camTrack ? '' : 'off';
  $('screenBtn').className = c && c.screen ? '' : 'off';
  const mic = c && c.mic && c.mic.track;
  $('muteBtn').className = mic && mic.enabled ? '' : 'off';
  $('muteBtn').textContent = mic && !mic.enabled ? '🔇 Micro coupé' : '🎤 Micro';
  $('callBtn').hidden = !!c || !view || view.type !== 'dm';
}
$('callBtn').addEventListener('click', () => view && view.type === 'dm' && startCall(view.id));
$('acceptBtn').addEventListener('click', acceptCall);
$('declineBtn').addEventListener('click', declineCall);
$('hangBtn').addEventListener('click', () => endCall(true));
$('audioBtn').addEventListener('click', audioModal);
$('muteBtn').addEventListener('click', () => {
  const c = callState, t = c && c.mic && c.mic.track;
  if (!t) return toast('Pas de micro actif. Ouvre « Audio » pour en choisir un.', true);
  t.enabled = !t.enabled; renderCallUi(); updateStatus(c);
});
$('camBtn').addEventListener('click', async () => {
  const c = callState; if (!c || !c.pc) return;
  if (c.camTrack) {
    c.camTrack.stop(); if (c.camSender) c.pc.removeTrack(c.camSender);
    c.main.removeTrack(c.camTrack); c.camTrack = c.camSender = null; refreshTile('me'); renderCallUi(); return;
  }
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
    if (!callState) return s.getTracks().forEach(t => t.stop());
    const t = s.getVideoTracks()[0]; c.camTrack = t; c.main.addTrack(t); c.camSender = c.pc.addTrack(t, c.main);
    refreshTile('me'); renderCallUi();
  } catch { toast("Impossible d'accéder à la caméra.", true); }
});
$('screenBtn').addEventListener('click', async () => {
  const c = callState; if (!c || !c.pc) return;
  const stop = () => {
    if (!c.screen) return;
    c.screen.getTracks().forEach(t => t.stop());
    if (c.scrSender) { try { c.pc.removeTrack(c.scrSender); } catch {} }
    c.screen = c.scrSender = null; removeTile('scr'); renderCallUi();
  };
  if (c.screen) return stop();
  if (!navigator.mediaDevices.getDisplayMedia) return toast("Le partage d'écran n'est pas disponible sur cet appareil.", true);
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    if (!callState) return s.getTracks().forEach(t => t.stop());
    c.screen = s; const t = s.getVideoTracks()[0];
    t.onended = stop;
    await sig(c.peer, { t: 'meta', screen: s.id });
    c.scrSender = c.pc.addTrack(t, s);
    addTile('scr', me, s, true); renderCallUi();
  } catch { /* annulé */ }
});

/* ============================== démarrage ============================== */
(async function boot() {
  setMode('login');
  if (token) {
    try {
      me = (await api('/api/me')).me; putUser(me);
      if (me.verified) return enterApp();
      return showVerify();
    } catch (e) { if (e.status === 0) { show('auth'); $('authErr').textContent = e.message; return; } }
  }
  token = null; store.set('fa_token', null); show('auth');
})();
