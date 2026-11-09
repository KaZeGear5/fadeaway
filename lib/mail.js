// FadeAway - envoi d'e-mails par SMTP, sans aucune dépendance.
//
// Variables d'environnement :
//   SMTP_HOST   serveur d'envoi (ex. smtp.gmail.com, smtp-relay.brevo.com)
//   SMTP_PORT   465 (TLS direct) ou 587 (STARTTLS)      [défaut 465]
//   SMTP_USER   identifiant
//   SMTP_PASS   mot de passe (pour Gmail : un "mot de passe d'application")
//   SMTP_FROM   expéditeur affiché                        [défaut : "FadeAway <SMTP_USER>"]
//   SMTP_SECURE tls | starttls | none (forcer le mode)   [auto selon le port]
//
// Sans SMTP_HOST, les e-mails ne partent pas : le code est écrit dans le journal du serveur.
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const EMAIL_RE = /^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[^\s@<>"',;:\\]{2,}$/;
const isEmail = s => typeof s === 'string' && s.length <= 120 && EMAIL_RE.test(s);

function config() {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER || '';
  let secure = (process.env.SMTP_SECURE || '').toLowerCase();
  if (!['tls', 'starttls', 'none'].includes(secure)) secure = port === 465 ? 'tls' : 'starttls';
  const addr = (process.env.SMTP_FROM || '').match(/<([^>]+)>/)?.[1] || process.env.SMTP_FROM || user;
  return {
    host, port, user, pass: process.env.SMTP_PASS || '', secure,
    from: process.env.SMTP_FROM || (user ? `FadeAway <${user}>` : ''),
    fromAddr: addr,
    reject: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== '0',
  };
}
const configured = () => !!config();

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const wrap76 = s => s.replace(/.{1,76}/g, '$&\r\n').trimEnd();
const encHeader = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const clean = s => String(s).replace(/[\r\n]+/g, ' ');

function buildMessage({ from, to, subject, text }) {
  const nameMatch = /^(.*?)\s*<([^>]+)>$/.exec(from);
  const fromHdr = nameMatch ? `${encHeader(clean(nameMatch[1]).replace(/"/g, ''))} <${clean(nameMatch[2])}>` : clean(from);
  const domain = (nameMatch ? nameMatch[2] : from).split('@')[1] || 'fadeaway.local';
  const lines = [
    `From: ${fromHdr}`,
    `To: ${clean(to)}`,
    `Subject: ${encHeader(clean(subject))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${clean(domain)}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(text)),
  ];
  return lines.join('\r\n');
}

function smtpSend(cfg, { to, subject, text }) {
  return new Promise((resolve, reject) => {
    let sock = null, buf = '', lines = [], done = false, waiter = null;
    const queue = [];
    const timer = setTimeout(() => fail(new Error('SMTP : délai dépassé')), 25000);
    const fail = e => {
      if (done) return; done = true; clearTimeout(timer);
      try { sock && sock.destroy(); } catch {}
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const onData = chunk => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        lines.push(line);
        if (/^\d{3}( |$)/.test(line)) {
          const resp = { code: Number(line.slice(0, 3)), lines };
          lines = [];
          if (waiter) { const w = waiter; waiter = null; w(resp); } else queue.push(resp);
        }
      }
    };
    const attach = s => {
      sock = s; buf = ''; lines = [];
      s.on('data', onData);
      s.on('error', fail);
      s.on('close', () => fail(new Error('SMTP : connexion fermée')));
    };
    const expect = codes => new Promise((res, rej) => {
      const check = r => (codes.includes(r.code) ? res(r) : rej(new Error(`SMTP ${r.code} : ${r.lines.join(' ').slice(0, 200)}`)));
      if (queue.length) check(queue.shift()); else waiter = check;
    });
    const cmd = (line, codes) => { sock.write(line + '\r\n'); return expect(codes); };

    (async () => {
      const tlsOpts = { host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: cfg.reject };
      attach(cfg.secure === 'tls' ? tls.connect(tlsOpts) : net.connect({ host: cfg.host, port: cfg.port }));
      await expect([220]);
      let ehlo = await cmd('EHLO fadeaway.local', [250]);

      if (cfg.secure === 'starttls') {
        if (!ehlo.lines.some(l => /STARTTLS/i.test(l))) throw new Error("SMTP : le serveur n'offre pas STARTTLS");
        await cmd('STARTTLS', [220]);
        const raw = sock;
        raw.removeAllListeners('data'); raw.removeAllListeners('close');
        const secured = tls.connect({ socket: raw, servername: cfg.host, rejectUnauthorized: cfg.reject });
        await new Promise((res, rej) => { secured.once('secureConnect', res); secured.once('error', rej); });
        attach(secured);
        ehlo = await cmd('EHLO fadeaway.local', [250]);
      }
      if (cfg.user) {
        if (cfg.secure === 'none' && process.env.SMTP_SECURE !== 'none') throw new Error('SMTP : refus d\'envoyer un mot de passe sans chiffrement');
        const auth = ehlo.lines.join(' ');
        if (/AUTH[^\n]*PLAIN/i.test(auth) || !/AUTH[^\n]*LOGIN/i.test(auth)) {
          await cmd('AUTH PLAIN ' + b64(`\0${cfg.user}\0${cfg.pass}`), [235]);
        } else {
          await cmd('AUTH LOGIN', [334]); await cmd(b64(cfg.user), [334]); await cmd(b64(cfg.pass), [235]);
        }
      }
      await cmd(`MAIL FROM:<${cfg.fromAddr}>`, [250]);
      await cmd(`RCPT TO:<${to}>`, [250, 251]);
      await cmd('DATA', [354]);
      const msg = buildMessage({ from: cfg.from || cfg.fromAddr, to, subject, text }).replace(/^\./gm, '..');
      await cmd(msg + '\r\n.', [250]);
      try { sock.write('QUIT\r\n'); } catch {}
      done = true; clearTimeout(timer);
      try { sock.end(); } catch {}
      resolve();
    })().catch(fail);
  });
}

// Renvoie { mode: 'smtp' | 'log' }. Lève une erreur si l'envoi échoue.
async function sendMail({ to, subject, text }) {
  if (!isEmail(to)) throw new Error('adresse e-mail invalide');
  const cfg = config();
  if (!cfg) {
    console.log(`\n[E-MAIL NON CONFIGURÉ] Pour ${to} : ${subject}\n${text}\n`);
    return { mode: 'log' };
  }
  await smtpSend(cfg, { to, subject, text });
  return { mode: 'smtp' };
}

module.exports = { sendMail, isEmail, configured };
