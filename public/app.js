// FadeAway - client : MP + appels P2P (voix, caméra, partage d'écran) en WebRTC
const $ = s => document.querySelector(s);
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// Serveur par défaut : config.js > même origine (version web) > localhost (app .exe)
const DEFAULT_SERVER = window.FADEAWAY_SERVER
  || (location.protocol.startsWith('http') ? location.origin : 'http://localhost:3000');
let API = '';

const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

let me = null, es = null;
let online = [];            // pseudos en ligne
let known = new Set();      // pseudos avec qui on a déjà parlé
let current = null;         // conversation ouverte
const msgs = {};            // pseudo -> [messages]
const unread = {};

// ---------- avatars colorés selon le pseudo ----------
function paintAvatar(el, name) {
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  el.textContent = (name || '?')[0].toUpperCase();
  el.style.background = `linear-gradient(135deg,hsl(${h} 85% 62%),hsl(${(h + 50) % 360} 85% 52%))`;
}

// ---------- connexion ----------
$('#serverInput').value = store.get('fadeaway.server') || DEFAULT_SERVER;
$('#nameInput').value = store.get('fadeaway.name') || '';

$('#loginForm').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('#nameInput').value.trim();
  if (name.length < 2) return ($('#loginErr').textContent = '2 caractères minimum');
  let base = $('#serverInput').value.trim().replace(/\/+$/, '');
  if (!base) return ($('#loginErr').textContent = 'Indique l\'adresse du serveur');
  if (!/^https?:\/\//i.test(base)) base = 'http://' + base;

  $('#loginErr').textContent = '';
  $('#loginBtn').disabled = true;
  if (es) es.close();
  API = base;
  es = new EventSource(API + '/api/events?name=' + encodeURIComponent(name));

  es.addEventListener('presence', ev => {
    if (!me) {
      me = name; store.set('fadeaway.name', name); store.set('fadeaway.server', API);
      if (window.fadeaway) window.fadeaway.setServer(API);  // l'app Windows en déduit où chercher les mises à jour
      $('#login').hidden = true; $('#app').hidden = false;
      $('#meName').textContent = me; paintAvatar($('#meAvatar'), me);
    }
    online = JSON.parse(ev.data).users.filter(u => u !== me);
    online.forEach(u => known.add(u));
    renderUsers();
    if (peer && !online.includes(peer)) endCall(false);
  });
  es.addEventListener('dm', ev => onDM(JSON.parse(ev.data)));
  es.addEventListener('kicked', ev => {
    try { alert(JSON.parse(ev.data).message); } catch {}
    es.close(); location.reload();
  });
  es.addEventListener('signal', ev => { const { from, data } = JSON.parse(ev.data); onSignal(from, data); });
  es.onerror = () => {
    if (!me) {
      es.close();
      $('#loginErr').textContent = 'Pseudo déjà pris, banni, ou serveur injoignable';
      $('#loginBtn').disabled = false;
    } else $('#chatTitle').textContent = 'Connexion perdue… reconnexion';
  };
});

const post = (url, body) => fetch(API + url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ from: me, ...body }) }).then(r => r.json());
const sendSignal = (to, data) => post('/api/signal', { to, data }).catch(() => {});

// ---------- liste d'utilisateurs ----------
function renderUsers() {
  const list = $('#userList'); list.innerHTML = '';
  [...known].sort().forEach(u => {
    const isOn = online.includes(u);
    const d = document.createElement('div');
    d.className = 'user' + (u === current ? ' active' : '') + (isOn ? '' : ' offline');
    d.innerHTML = `<span class="avatar ${isOn ? 'on' : ''}"></span><span class="n"></span>`;
    paintAvatar(d.querySelector('.avatar'), u);
    d.querySelector('.n').textContent = u;
    if (unread[u]) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = unread[u]; d.append(b); }
    d.onclick = () => openChat(u);
    list.append(d);
  });
  if (!known.size) list.innerHTML = '<div class="empty">Personne d\'autre en ligne pour l\'instant.</div>';
  if (current) $('#callBtn').hidden = !online.includes(current) || !!peer;
}

// ---------- MP ----------
async function openChat(u) {
  current = u; unread[u] = 0;
  $('#chatTitle').textContent = '@ ' + u;
  $('#msgInput').disabled = false; $('#msgInput').focus();
  $('#callBtn').hidden = !online.includes(u) || !!peer;
  const r = await post('/api/history', { to: u });
  msgs[u] = r.messages || [];
  renderMessages(); renderUsers();
}
function renderMessages() {
  const box = $('#messages'); box.innerHTML = '';
  (msgs[current] || []).forEach(m => {
    const d = document.createElement('div'); d.className = 'msg';
    const av = document.createElement('span'); av.className = 'avatar'; paintAvatar(av, m.from);
    const c = document.createElement('div');
    const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = m.from;
    const t = document.createElement('small'); t.textContent = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    meta.append(t);
    const body = document.createElement('div'); body.className = 'body'; body.textContent = m.text;
    c.append(meta, body); d.append(av, c); box.append(d);
  });
  box.scrollTop = box.scrollHeight;
}
function onDM(m) {
  const other = m.from === me ? m.to : m.from;
  known.add(other);
  (msgs[other] = msgs[other] || []).push(m);
  if (other === current) renderMessages(); else if (m.from !== me) unread[other] = (unread[other] || 0) + 1;
  renderUsers();
}
$('#msgForm').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('#msgInput').value.trim();
  if (!text || !current) return;
  $('#msgInput').value = '';
  post('/api/dm', { to: current, text });
});

// ---------- appels WebRTC (P2P) ----------
let pc = null, peer = null, polite = false;
let makingOffer = false, ignoreOffer = false;
let localStream = null;      // micro (+ caméra)
let camSender = null;
let screenStream = null, screenSenders = [];
let pending = null;          // appel entrant { from, description, candidates }

function createPC() {
  pc = new RTCPeerConnection(ICE);
  pc.onicecandidate = e => e.candidate && sendSignal(peer, { candidate: e.candidate });
  pc.onnegotiationneeded = async () => {
    try { makingOffer = true; await pc.setLocalDescription(); sendSignal(peer, { description: pc.localDescription }); }
    catch (err) { console.error(err); } finally { makingOffer = false; }
  };
  pc.ontrack = ({ streams }) => {
    const s = streams[0]; if (!s) return;
    const first = !document.querySelector('[id^="remote-"]');
    addTile('remote-' + s.id, s, first ? peer : peer + ' (écran)', false);
    const refresh = () => {
      const t = document.getElementById('remote-' + s.id);
      if (!t) return;
      if (s.getTracks().length === 0) return t.remove();
      t.classList.toggle('noVideo', s.getVideoTracks().length === 0);
    };
    s.onremovetrack = refresh; s.onaddtrack = refresh; refresh();
  };
  pc.onconnectionstatechange = () => { if (pc && pc.connectionState === 'failed') endCall(false); };
}

function addTile(id, stream, label, muted) {
  let t = document.getElementById(id);
  if (!t) {
    t = document.createElement('div'); t.className = 'tile'; t.id = id;
    t.innerHTML = '<video autoplay playsinline></video><span class="avatar big"></span><span class="label"></span>';
    $('#tiles').append(t);
  }
  const v = t.querySelector('video'); v.srcObject = stream; v.muted = muted;
  paintAvatar(t.querySelector('.big'), (label || '?').replace(/ \(.*\)$/, ''));
  t.querySelector('.label').textContent = label;
  t.classList.toggle('noVideo', stream.getVideoTracks().length === 0);
  return t;
}

async function getMic() {
  try { return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { alert("Impossible d'accéder au micro (autorisation refusée ?)."); return null; }
}

function showCallUI() {
  $('#call').hidden = false; $('#callBtn').hidden = true;
  $('#muteBtn').className = ''; $('#muteBtn').textContent = '🎤 Micro';
  $('#camBtn').className = 'off'; $('#screenBtn').className = 'off';
  $('#screenBtn').textContent = '🖥️ Partager l\'écran';
  addTile('local', localStream, me + ' (toi)', true);
}

async function startCall(name) {
  if (pc) return;
  localStream = await getMic(); if (!localStream) return;
  peer = name; polite = me > peer;
  createPC();
  showCallUI();
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream)); // déclenche l'offre
}

async function acceptCall() {
  const p = pending; pending = null; $('#incoming').hidden = true;
  localStream = await getMic();
  if (!localStream) { sendSignal(p.from, { type: 'hangup' }); return; }
  peer = p.from; polite = me > peer;
  createPC(); showCallUI();
  await pc.setRemoteDescription(p.description);
  for (const c of p.candidates) try { await pc.addIceCandidate(c); } catch {}
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  await pc.setLocalDescription();
  sendSignal(peer, { description: pc.localDescription });
  openChat(peer);
}

function declineCall() {
  if (pending) sendSignal(pending.from, { type: 'hangup' });
  pending = null; $('#incoming').hidden = true;
}

function endCall(notify = true) {
  if (notify && peer) sendSignal(peer, { type: 'hangup' });
  if (pc) { pc.onnegotiationneeded = null; pc.close(); }
  [localStream, screenStream].forEach(s => s && s.getTracks().forEach(t => t.stop()));
  pc = null; peer = null; localStream = null; screenStream = null; camSender = null; screenSenders = [];
  makingOffer = ignoreOffer = false;
  $('#tiles').innerHTML = ''; $('#call').hidden = true;
  if (current) $('#callBtn').hidden = !online.includes(current);
}

async function onSignal(from, data) {
  if (data.type === 'hangup') {
    if (pending && pending.from === from) { pending = null; $('#incoming').hidden = true; }
    else if (peer === from) endCall(false);
    return;
  }
  if (data.type === 'busy') { if (peer === from) { endCall(false); alert(from + ' est déjà en appel.'); } return; }

  if (!pc) { // appel entrant
    if (data.description && data.description.type === 'offer') {
      if (pending) return sendSignal(from, { type: 'busy' });
      pending = { from, description: data.description, candidates: [] };
      $('#incomingText').textContent = '📞 ' + from + ' t\'appelle…';
      $('#incoming').hidden = false;
    } else if (data.candidate && pending && pending.from === from) pending.candidates.push(data.candidate);
    return;
  }
  if (from !== peer) { if (data.description) sendSignal(from, { type: 'busy' }); return; }

  // négociation parfaite (gère les renégociations quand on ajoute cam/écran)
  try {
    if (data.description) {
      const d = data.description;
      const collision = d.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
      ignoreOffer = !polite && collision;
      if (ignoreOffer) return;
      await pc.setRemoteDescription(d);
      if (d.type === 'offer') { await pc.setLocalDescription(); sendSignal(peer, { description: pc.localDescription }); }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch (err) { if (!ignoreOffer) console.warn(err); }
    }
  } catch (err) { console.error(err); }
}

// ---------- contrôles ----------
$('#callBtn').onclick = () => current && startCall(current);
$('#acceptBtn').onclick = acceptCall;
$('#declineBtn').onclick = declineCall;
$('#hangBtn').onclick = () => endCall(true);

$('#muteBtn').onclick = () => {
  const t = localStream && localStream.getAudioTracks()[0]; if (!t) return;
  t.enabled = !t.enabled;
  $('#muteBtn').className = t.enabled ? '' : 'danger';
  $('#muteBtn').textContent = t.enabled ? '🎤 Micro' : '🔇 Micro coupé';
};

$('#camBtn').onclick = async () => {
  if (!pc) return;
  if (camSender) {
    const t = camSender.track; pc.removeTrack(camSender); camSender = null;
    if (t) { t.stop(); localStream.removeTrack(t); }
    $('#camBtn').className = 'off';
    addTile('local', localStream, me + ' (toi)', true);
  } else {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
      const t = s.getVideoTracks()[0];
      localStream.addTrack(t);
      camSender = pc.addTrack(t, localStream);
      $('#camBtn').className = '';
      addTile('local', localStream, me + ' (toi)', true);
    } catch { alert('Caméra inaccessible.'); }
  }
};

$('#screenBtn').onclick = async () => {
  if (!pc) return;
  if (screenStream) return stopScreen();
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
  } catch { screenStream = null; return; }
  screenStream.getTracks().forEach(t => screenSenders.push(pc.addTrack(t, screenStream)));
  screenStream.getVideoTracks()[0].onended = stopScreen;
  addTile('local-screen', screenStream, 'Ton écran', true);
  $('#screenBtn').className = ''; $('#screenBtn').textContent = '🛑 Arrêter le partage';
};
function stopScreen() {
  if (!screenStream) return;
  screenSenders.forEach(s => { try { pc && pc.removeTrack(s); } catch {} });
  screenStream.getTracks().forEach(t => t.stop());
  screenStream = null; screenSenders = [];
  const t = document.getElementById('local-screen'); t && t.remove();
  $('#screenBtn').className = 'off'; $('#screenBtn').textContent = '🖥️ Partager l\'écran';
}

window.addEventListener('beforeunload', () => { if (peer) sendSignal(peer, { type: 'hangup' }); });
