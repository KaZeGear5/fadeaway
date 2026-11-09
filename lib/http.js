// FadeAway - petits utilitaires HTTP partagés (sans dépendance)
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.yml': 'text/yaml; charset=utf-8',
};

const json = (res, code, obj) => {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};
const safeDecode = s => { try { return decodeURIComponent(s); } catch { return ''; } };

function readJson(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => { body += d; if (body.length > limit) { req.destroy(); reject(new Error('too big')); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// lit un corps binaire en refusant tout ce qui dépasse la limite
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) { req.resume(); return reject(Object.assign(new Error('Fichier trop gros'), { status: 413 })); }
    const chunks = []; let size = 0, over = false;
    req.on('data', c => {
      if (over) return;
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; return reject(Object.assign(new Error('Fichier trop gros'), { status: 413 })); }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

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

module.exports = { MIME, json, safeDecode, readJson, readBody, serveFile, serveStatic };
