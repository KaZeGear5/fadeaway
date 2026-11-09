'use strict';
// FadeAway - stockage sur disque : deux fichiers JSON (comptes, messages) écrits de façon sûre
// (fichier temporaire + renommage), avec écriture différée pour ménager la carte SD.
// Pour un groupe d'amis c'est largement suffisant ; au-delà, passer à SQLite.
const fs = require('fs');
const path = require('path');

function createStore(dir, { delay = 2500 } = {}) {
  fs.mkdirSync(dir, { recursive: true });

  function open(name, defaults) {
    const file = path.join(dir, name);
    const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
    let data = defaults;
    try { data = { ...defaults, ...read(file) }; }
    catch (e) {
      if (e.code !== 'ENOENT') {
        // fichier abîmé : on tente la sauvegarde, sinon on s'arrête (pour ne JAMAIS écraser des comptes)
        try { data = { ...defaults, ...read(file + '.bak') }; console.warn(`${name} illisible : restauré depuis la sauvegarde.`); }
        catch { throw new Error(`${file} est illisible et il n'y a pas de sauvegarde. Corrige-le ou renomme-le.`); }
      }
    }
    return { file, data, dirty: false, timer: null, lastBackup: 0 };
  }

  const dbSlot = open('db.json', { nextNumber: 1, users: {}, sessions: {} });
  const msgSlot = open('messages.json', { nextId: 1, dm: {}, chan: {} });

  function flushSlot(s) {
    clearTimeout(s.timer); s.timer = null;
    if (!s.dirty) return;
    s.dirty = false;
    const tmp = s.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s.data));
    if (fs.existsSync(s.file) && Date.now() - s.lastBackup > 10 * 60000) {
      try { fs.copyFileSync(s.file, s.file + '.bak'); s.lastBackup = Date.now(); } catch {}
    }
    fs.renameSync(tmp, s.file);
  }
  function touch(s) {
    s.dirty = true;
    if (!s.timer) {
      s.timer = setTimeout(() => { try { flushSlot(s); } catch (e) { console.error('Sauvegarde impossible :', e.message); } }, delay);
      s.timer.unref?.();
    }
  }
  const flush = () => { flushSlot(dbSlot); flushSlot(msgSlot); };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { flush(); } catch {} process.exit(0); });
  process.on('exit', () => { try { flush(); } catch {} });

  return {
    db: dbSlot.data, msgs: msgSlot.data,
    touchDb: () => touch(dbSlot), touchMsgs: () => touch(msgSlot), flush,
  };
}

module.exports = { createStore };
