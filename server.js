// FadeAway - serveur (zéro dépendance, Node 16+)
//
//  - version web de l'app            : /
//  - panneau admin (mot de passe)    : /admin
//  - mises à jour de l'app Windows   : /updates/...   (déposées depuis le panneau admin)
//  - lien de téléchargement          : /download      (redirige vers le dernier installeur)
//  - présence + MP + signalisation WebRTC (SSE + POST). L'audio/vidéo ne passe JAMAIS ici.
//
// Mot de passe admin : variable d'environnement ADMIN_PASSWORD
//   PowerShell :  $env:ADMIN_PASSWORD="un-mot-de-passe-solide"; node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const ADMIN_DIR = path.join(__dirname, 'admin');
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPDATES = path.join(DATA, 'updates');
fs.mkdirSync(UPDATES, { recursive: true });

const MAX_UPLOAD = 600 * 1024 * 1024; // 600 Mo
const SESSION_MS = 12 * 3600 * 1000;
const startedAt = Date.now();

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
  console.log(`\n  ADMIN_PASSWORD non défini : mot de passe admin temporaire = ${ADMIN_PASSWORD}`);
  console.log('  (définis ADMIN_PASSWORD pour garder le même mot de passe à chaque lancement)\n');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png', '.json': 'application/json', '.yml': 'text/yaml; charset=utf-8',
};

// ---------- état ----------
const clients = new Map();   // pseudo -> { res, ping, since }
const history = new Map();   // "a|b" -> [{from,to,text,ts}]
const bans = new Map();      // pseudo (minuscules) -> fin du bannissement (Infinity = jusqu'au redémarrage)
const sessions = new Map();  // jeton admin -> expiration
const fails = new Map();     // ip -> { n, until }

const pairKey = (a, b) => [a, b].sort().join('|');
const validName = n => typeof n === 'string' && /^[\p{L}\p{N}_\- ]{2,20}$/u.test(n.trim());
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const passwordOk = p => crypto.timingSafeEqual(sha(p), sha(ADMIN_PASSWORD));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ipOf = req => String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

function isBanned(name) {
  const k = name.toLowerCase(), until = bans.get(k);
  if (until === undefined) return false;
  if (until < Date.now()) { bans.delete(k); return false; }
  return true;
}
function isAdmin(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const exp = m && sessions.get(m[1]);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(m[1]); return false; }
  return true;
}

function sendEvent(name, event, data) {
  const c = clients.get(name);
  if (c) c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcastPresence() {
  const users = [...clients.keys()];
  for (const n of clients.keys()) sendEvent(n, 'presence', { users });
}
// minutes : 0 = simple déconnexion, > 0 = exclusion temporaire, null = ban jusqu'au redémarrage
function kick(name, minutes) {
  if (minutes === null) bans.set(name.toLowerCase(), Infinity);
  else if (minutes > 0) bans.set(name.toLowerCase(), Date.now() + minutes * 60000);
  const c = clients.get(name);
  if (!c) return;
  sendEvent(name, 'kicked', {
    message: minutes === 0 ? 'Tu as été déconnecté par un administrateur.' : 'Tu as été exclu par un administrateur.',
  });
  clearInterval(c.ping);
  clients.delete(name);
  c.res.end();
  broadcastPresence();
}

// ---------- utilitaires HTTP ----------
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e6) { req.destroy(); reject(new Error('too big')); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
  });
}
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};
const safeDecode = s => { try { return decodeURIComponent(s); } catch { return ''; } };

// envoie un fichier, avec gestion des requêtes "Range" (téléchargements différentiels de l'updater)
function serveFile(req, res, file, type, extra = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', ...extra };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let start = 0, end = st.size - 1, partial = false;
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] !== '') { start = Number(m[1]); end = m[2] !== '' ? Math.min(Number(m[2]), st.size - 1) : st.size - 1; }
      else { start = Math.max(0, st.size - Number(m[2])); }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      partial = true;
    }
    headers['Content-Length'] = end - start + 1;
    if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    res.writeHead(partial ? 206 : 200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
  });
}
function serveStatic(req, res, root, rel) {
  const file = path.normalize(path.join(root, rel));
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  serveFile(req, res, file, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
}

// ---------- mises à jour ----------
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._ ()\-]{0,118}\.(exe|yml|blockmap)$/i;
const safeName = n => typeof n === 'string' && FILE_RE.test(n) && !n.includes('..');

function listUpdates() {
  return fs.readdirSync(UPDATES).filter(safeName).map(name => {
    const st = fs.statSync(path.join(UPDATES, name));
    return { name, size: st.size, mtime: st.mtimeMs };
  }).sort((a, b) => b.mtime - a.mtime);
}
function latestInfo() {
  try {
    const t = fs.readFileSync(path.join(UPDATES, 'latest.yml'), 'utf8');
    const v = /^version:\s*['"]?([^\s'"]+)/m.exec(t);
    const p = /^path:\s*['"]?(.+?)['"]?\s*$/m.exec(t);
    return { version: v ? v[1] : null, installer: p ? p[1] : null };
  } catch { return { version: null, installer: null }; }
}

// Garde-fou : latest.yml n'est accepté que si l'installeur qu'il annonce est déjà publié,
// sinon toutes les apps essaieraient de télécharger un fichier qui n'existe pas.
function checkUpload(name, tmpFile) {
  if (!/^latest\.yml$/i.test(name)) return null;
  let txt;
  try {
    if (fs.statSync(tmpFile).size > 100000) return "Ce latest.yml est trop gros : ce n'est pas le bon fichier";
    txt = fs.readFileSync(tmpFile, 'utf8');
  } catch { return 'Lecture de latest.yml impossible'; }
  const v = /^version:\s*['"]?(\d+\.\d+\.\d+[^\s'"]*)/m.exec(txt);
  const p = /^path:\s*['"]?(.+?)['"]?\s*$/m.exec(txt);
  if (!v || !p) return 'latest.yml invalide (version ou path introuvable)';
  if (!safeName(p[1]) || !p[1].toLowerCase().endsWith('.exe')) return `latest.yml pointe vers « ${p[1]} », ce n'est pas un installeur valide`;
  if (!fs.existsSync(path.join(UPDATES, p[1]))) return `latest.yml annonce ${p[1]} qui n'est pas encore publié : dépose d'abord l'installeur (.exe)`;
  return null;
}

function handleUpload(req, res, name) {
  if (!safeName(name)) return json(res, 400, { error: 'Nom de fichier refusé (seuls .exe, .yml et .blockmap sont acceptés)' });
  if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD) return json(res, 413, { error: 'Fichier trop gros' });
  const tmp = path.join(UPDATES, '.up-' + crypto.randomBytes(6).toString('hex'));
  const ws = fs.createWriteStream(tmp);
  let size = 0, done = false;
  const cleanup = () => { ws.destroy(); fs.unlink(tmp, () => {}); };

  req.on('data', c => {
    size += c.length;
    if (size > MAX_UPLOAD && !done) {
      done = true; req.unpipe(ws); cleanup();
      json(res, 413, { error: 'Fichier trop gros' });
      res.on('finish', () => req.destroy());
    }
  });
  req.on('aborted', () => { done = true; cleanup(); });
  ws.on('error', () => { if (!done) { done = true; json(res, 500, { error: 'Écriture impossible' }); } cleanup(); });
  ws.on('finish', () => {
    if (done) return;
    done = true;
    const problem = checkUpload(name, tmp);
    if (problem) { cleanup(); return json(res, 400, { error: problem }); }
    fs.rename(tmp, path.join(UPDATES, name), err => {
      if (err) { cleanup(); return json(res, 500, { error: 'Renommage impossible' }); }
      console.log(`Mise à jour déposée : ${name} (${(size / 1048576).toFixed(1)} Mo)`);
      json(res, 200, { ok: true, size });
    });
  });
  req.pipe(ws);
}

// ---------- API admin ----------
async function handleAdmin(req, res, url) {
  const route = url.pathname.slice('/api/admin/'.length);

  if (route === 'login' && req.method === 'POST') {
    const ip = ipOf(req);
    let f = fails.get(ip);
    if (f && f.until && f.until <= Date.now()) { fails.delete(ip); f = null; }
    if (f && f.until > Date.now()) return json(res, 429, { error: 'Trop d\'essais, réessaie dans quelques minutes' });
    let b;
    try { b = await readJson(req); } catch { return json(res, 400, { error: 'JSON invalide' }); }
    if (!passwordOk(b.password || '')) {
      const n = (f ? f.n : 0) + 1;
      fails.set(ip, { n, until: n >= 5 ? Date.now() + 10 * 60000 : 0 });
      await sleep(500);
      return json(res, 401, { error: 'Mot de passe incorrect' });
    }
    fails.delete(ip);
    const token = crypto.randomBytes(24).toString('base64url');
    sessions.set(token, Date.now() + SESSION_MS);
    return json(res, 200, { token });
  }

  if (!isAdmin(req)) return json(res, 401, { error: 'Non autorisé' });

  if (route === 'users' && req.method === 'GET') {
    return json(res, 200, {
      online: [...clients].map(([name, c]) => ({ name, since: c.since })),
      bans: [...bans].filter(([n]) => isBanned(n)).map(([name, until]) => ({ name, until: until === Infinity ? null : until })),
      uptime: Date.now() - startedAt,
      update: latestInfo(),
    });
  }
  if (route === 'kick' && req.method === 'POST') {
    let b; try { b = await readJson(req); } catch { return json(res, 400, { error: 'JSON invalide' }); }
    if (!validName(b.name)) return json(res, 400, { error: 'Pseudo invalide' });
    const minutes = b.minutes === null ? null : Number(b.minutes);
    if (minutes !== null && !(minutes >= 0 && minutes <= 525600)) return json(res, 400, { error: 'Durée invalide' });
    kick(b.name, minutes);
    return json(res, 200, { ok: true });
  }
  if (route === 'unban' && req.method === 'POST') {
    let b; try { b = await readJson(req); } catch { return json(res, 400, { error: 'JSON invalide' }); }
    if (typeof b.name === 'string') bans.delete(b.name.toLowerCase());
    return json(res, 200, { ok: true });
  }
  if (route === 'updates') {
    if (req.method === 'GET') return json(res, 200, { files: listUpdates(), ...latestInfo() });
    if (req.method === 'PUT') return handleUpload(req, res, url.searchParams.get('name'));
    if (req.method === 'DELETE') {
      const name = url.searchParams.get('name');
      if (!safeName(name)) return json(res, 400, { error: 'Nom refusé' });
      return fs.unlink(path.join(UPDATES, name), err => json(res, err ? 404 : 200, err ? { error: 'Introuvable' } : { ok: true }));
    }
  }
  return json(res, 404, { error: 'Inconnu' });
}

// ---------- serveur ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  res.setHeader('X-Content-Type-Options', 'nosniff');
  // CORS : l'app Windows charge l'interface depuis file://
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600' });
    return res.end();
  }

  // ---- SSE : /api/events?name=Pseudo
  if (req.method === 'GET' && url.pathname === '/api/events') {
    const name = (url.searchParams.get('name') || '').trim();
    if (!validName(name)) return json(res, 400, { error: 'pseudo invalide' });
    if (isBanned(name)) return json(res, 403, { error: 'banni' });
    if (clients.has(name)) return json(res, 409, { error: 'pseudo déjà pris' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    clients.set(name, { res, ping, since: Date.now() });
    broadcastPresence();
    req.on('close', () => {
      clearInterval(ping);
      if (clients.get(name)?.res === res) { clients.delete(name); broadcastPresence(); }
    });
    return;
  }

  // ---- API admin
  if (url.pathname.startsWith('/api/admin/')) return handleAdmin(req, res, url);

  // ---- API publique (MP + signalisation)
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    let b;
    try { b = await readJson(req); } catch { return json(res, 400, { error: 'JSON invalide' }); }
    const { from, to } = b;
    if (!clients.has(from)) return json(res, 401, { error: 'non connecté' });

    if (url.pathname === '/api/dm') {
      const text = String(b.text || '').slice(0, 2000).trim();
      if (!text || !to) return json(res, 400, { error: 'message vide' });
      const msg = { from, to, text, ts: Date.now() };
      const k = pairKey(from, to);
      if (!history.has(k)) history.set(k, []);
      const arr = history.get(k);
      arr.push(msg);
      if (arr.length > 500) arr.shift();
      sendEvent(from, 'dm', msg);
      if (to !== from) sendEvent(to, 'dm', msg);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/history') {
      return json(res, 200, { messages: history.get(pairKey(from, to)) || [] });
    }
    if (url.pathname === '/api/signal') {
      if (!clients.has(to)) return json(res, 404, { error: 'hors ligne' });
      sendEvent(to, 'signal', { from, data: b.data });
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'inconnu' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }

  // ---- fichiers de mise à jour (lus par l'app Windows)
  if (url.pathname.startsWith('/updates/')) {
    const name = safeDecode(url.pathname.slice('/updates/'.length));
    if (!safeName(name)) { res.writeHead(404); return res.end('Not found'); }
    const yml = /\.yml$/i.test(name);
    return serveFile(req, res, path.join(UPDATES, name),
      yml ? 'text/yaml; charset=utf-8' : 'application/octet-stream',
      yml ? { 'Cache-Control': 'no-cache' } : {});
  }
  // ---- lien de téléchargement pour les amis
  if (url.pathname === '/download') {
    const { installer } = latestInfo();
    if (!installer || !safeName(installer) || !fs.existsSync(path.join(UPDATES, installer))) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Aucune version publiée pour le moment.');
    }
    res.writeHead(302, { Location: '/updates/' + encodeURIComponent(installer) });
    return res.end();
  }
  // ---- panneau admin
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
    const rel = safeDecode(url.pathname.slice('/admin'.length)).replace(/^\/+/, '') || 'index.html';
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    return serveStatic(req, res, ADMIN_DIR, rel);
  }
  // ---- version web de l'app
  const rel = url.pathname === '/' ? 'index.html' : safeDecode(url.pathname).replace(/^\/+/, '');
  serveStatic(req, res, PUBLIC, rel);
});

server.requestTimeout = 0; // les gros envois (installeur ~80 Mo) ne doivent pas être coupés
server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log(`FadeAway sur http://localhost:${PORT}`);
  console.log(`Admin       http://localhost:${PORT}/admin`);
});
