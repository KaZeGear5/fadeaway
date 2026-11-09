'use strict';
// Moteur de commandes, partagé par la console du panneau admin (acteur « console », tous les droits)
// et par la console intégrée à l'app (acteur « op », droits limités).
//
//   kick <user> [raison]               expulse (il peut revenir)
//   mute / tempmute / unmute           empêche d'écrire (MP + salon)
//   ban / tempban / unban              bannit
//   premium give|take|list ...         FadeAway Premium
//   op / deop / verify                 console du panneau uniquement
const DURATION = /^(\d+)(s|m|h|d|w)$/i;
const UNIT = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
const MAX_MS = 3650 * 86400000;

class CmdError extends Error {}
const fail = m => { throw new CmdError(m); };

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 129600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} j`;
}
const fmtDate = ts => new Date(ts).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
const fmtRec = r => (!r ? 'non' : r.perm ? 'permanent' : `jusqu'au ${fmtDate(r.until)}`);

function createCommands(model, hooks) {
  const { db } = model;

  // durée → { perm:true } | { until:ts }
  function parseDuration(tok, what = 'durée') {
    if (!tok) fail(`Il manque la ${what} (ex : 30m, 2h, 7d, 1w).`);
    if (/^(perm|perma|permanent|forever|jamais)$/i.test(tok)) return { perm: true };
    const m = DURATION.exec(tok);
    if (!m) fail(`« ${tok} » n'est pas une durée valide (ex : 30m, 2h, 7d, 1w, perm).`);
    const ms = Number(m[1]) * UNIT[m[2].toLowerCase()];
    if (!(ms > 0) || ms > MAX_MS) fail('Durée trop grande ou nulle.');
    return { until: Date.now() + ms };
  }

  function target(tok, ctx, { punish = false } = {}) {
    if (!tok) fail('Il manque le joueur (pseudo, #numéro ou pseudo#numéro).');
    let u = model.findUser(tok);
    if (!u && ctx.isConsole) u = model.byEmail(tok);          // la console peut aussi viser une adresse e-mail
    if (!u) fail(`Utilisateur introuvable : ${tok}`);
    if (punish && !ctx.isConsole) {
      if (u.id === ctx.user.id) fail('Tu ne peux pas te sanctionner toi-même.');
      if (u.op) fail('Tu ne peux pas sanctionner un autre op.');
    }
    return u;
  }
  const label = u => `${u.name} (@${u.username}#${u.id})`;
  const reasonOf = toks => toks.join(' ').slice(0, 200);
  const rec = (d, ctx, reason) => ({ ...d, reason, by: ctx.isConsole ? 'console' : `@${ctx.user.username}`, at: Date.now() });

  const COMMANDS = {
    help: {
      usage: 'help', desc: "affiche cette aide",
      run: (a, ctx) => Object.entries(COMMANDS)
        .filter(([, c]) => ctx.isConsole || !c.consoleOnly)
        .map(([n, c]) => `${c.usage.padEnd(34)} ${c.desc}`),
    },
    list: {
      usage: 'list', desc: 'joueurs connectés',
      run: () => {
        const on = hooks.onlineIds().map(id => db.users[id]).filter(Boolean);
        return [`${on.length} connecté(s)${on.length ? ' : ' + on.map(label).join(', ') : ''}`];
      },
    },
    whois: {
      usage: 'whois <user>', desc: "infos sur un compte",
      run: (a, ctx) => {
        const u = target(a[0], ctx);
        const out = [
          `${label(u)}${u.op ? '  [OP]' : ''}${model.isPremium(u) ? '  [PREMIUM]' : ''}`,
          `  inscrit le ${fmtDate(u.createdAt)} · ${hooks.isOnline(u.id) ? 'en ligne' : 'hors ligne'} · e-mail ${u.verified ? 'vérifié' : 'NON vérifié'}`,
          `  amis : ${u.friends.length} · ban : ${fmtRec(model.banOf(u))} · mute : ${fmtRec(model.muteOf(u))}`,
          `  premium : ${model.premiumOf(u) ? fmtRec(u.premium) : 'non'}`,
        ];
        if (ctx.isConsole) out.splice(1, 0, `  e-mail : ${u.email}`);
        return out;
      },
    },
    kick: {
      usage: 'kick <user> [raison]', desc: "expulse (peut se reconnecter)",
      run: (a, ctx) => {
        const u = target(a[0], ctx, { punish: true });
        if (!hooks.isOnline(u.id)) fail(`${u.name} n'est pas connecté.`);
        const reason = reasonOf(a.slice(1));
        hooks.disconnect(u.id, `Tu as été expulsé par un administrateur${reason ? ` : ${reason}` : '.'}`, 'kicked');
        return [`${label(u)} expulsé.`];
      },
    },
    mute: {
      usage: 'mute <user> [raison]', desc: 'mute permanent',
      run: (a, ctx) => {
        const u = target(a[0], ctx, { punish: true });
        u.mute = rec({ perm: true }, ctx, reasonOf(a.slice(1)));
        model.store.touchDb(); hooks.changed(u, `Tu as été rendu muet${u.mute.reason ? ` : ${u.mute.reason}` : '.'}`);
        return [`${label(u)} est mute (permanent).`];
      },
    },
    tempmute: {
      usage: 'tempmute <user> <durée> [raison]', desc: 'mute temporaire (ex : 30m, 2h, 7d)',
      run: (a, ctx) => {
        const u = target(a[0], ctx, { punish: true });
        const d = parseDuration(a[1]);
        u.mute = rec(d, ctx, reasonOf(a.slice(2)));
        model.store.touchDb(); hooks.changed(u, `Tu as été rendu muet ${fmtRec(u.mute)}${u.mute.reason ? ` : ${u.mute.reason}` : '.'}`);
        return [`${label(u)} est mute ${fmtRec(u.mute)}.`];
      },
    },
    unmute: {
      usage: 'unmute <user>', desc: 'retire le mute',
      run: (a, ctx) => {
        const u = target(a[0], ctx);
        if (!model.muteOf(u)) fail(`${u.name} n'est pas mute.`);
        u.mute = null; model.store.touchDb(); hooks.changed(u, 'Tu peux de nouveau écrire.');
        return [`${label(u)} peut de nouveau écrire.`];
      },
    },
    ban: {
      usage: 'ban <user> [raison]', desc: 'bannissement permanent',
      run: (a, ctx) => {
        const u = target(a[0], ctx, { punish: true });
        u.ban = rec({ perm: true }, ctx, reasonOf(a.slice(1)));
        model.store.touchDb();
        hooks.disconnect(u.id, `Tu as été banni définitivement${u.ban.reason ? ` : ${u.ban.reason}` : '.'}`, 'banned');
        return [`${label(u)} banni (permanent).`];
      },
    },
    tempban: {
      usage: 'tempban <user> <durée> [raison]', desc: 'bannissement temporaire',
      run: (a, ctx) => {
        const u = target(a[0], ctx, { punish: true });
        const d = parseDuration(a[1]);
        u.ban = rec(d, ctx, reasonOf(a.slice(2)));
        model.store.touchDb();
        hooks.disconnect(u.id, `Tu as été banni ${fmtRec(u.ban)}${u.ban.reason ? ` : ${u.ban.reason}` : '.'}`, 'banned');
        return [`${label(u)} banni ${fmtRec(u.ban)}.`];
      },
    },
    unban: {
      usage: 'unban <user>', desc: 'retire le bannissement',
      run: (a, ctx) => {
        const u = target(a[0], ctx);
        if (!model.banOf(u)) fail(`${u.name} n'est pas banni.`);
        u.ban = null; model.store.touchDb();
        return [`${label(u)} débanni.`];
      },
    },
    premium: {
      usage: 'premium give <user> [durée] | take <user> | list', desc: 'FadeAway Premium (« prenium » marche aussi)',
      run: (a, ctx) => {
        const sub = (a[0] || '').toLowerCase();
        if (sub === 'list') {
          const l = Object.values(db.users).filter(u => model.premiumOf(u));
          return [`${l.length} compte(s) Premium${l.length ? ' : ' + l.map(u => `${label(u)} [${fmtRec(u.premium)}]`).join(', ') : ''}`];
        }
        if (sub === 'give') {
          const u = target(a[1], ctx);
          const d = a[2] ? parseDuration(a[2]) : { perm: true };
          u.premium = d; model.store.touchDb();
          hooks.changed(u, '✦ Tu as reçu FadeAway Premium !');
          return [`${label(u)} a maintenant FadeAway Premium (${fmtRec(u.premium)}).`];
        }
        if (sub === 'take') {
          const u = target(a[1], ctx);
          if (!model.premiumOf(u)) fail(`${u.name} n'a pas FadeAway Premium.`);
          u.premium = null; model.store.touchDb();
          hooks.changed(u, 'Ton FadeAway Premium a été retiré.');
          return [`Premium retiré à ${label(u)}.`];
        }
        fail('Usage : premium give <user> [durée] | premium take <user> | premium list');
      },
    },
    op: {
      usage: 'op <user>', desc: "donne les droits d'opérateur", consoleOnly: true,
      run: (a, ctx) => {
        const u = target(a[0], ctx);
        if (u.op) fail(`${u.name} est déjà op.`);
        u.op = true; model.store.touchDb(); hooks.changed(u, '🛡️ Tu es maintenant opérateur : une console est disponible dans l\'app.');
        return [`${label(u)} est maintenant op.`];
      },
    },
    deop: {
      usage: 'deop <user>', desc: "retire les droits d'opérateur", consoleOnly: true,
      run: (a, ctx) => {
        const u = target(a[0], ctx);
        if (!u.op) fail(`${u.name} n'est pas op.`);
        u.op = false; model.store.touchDb(); hooks.changed(u, "Tu n'es plus opérateur.");
        return [`${label(u)} n'est plus op.`];
      },
    },
    ops: {
      usage: 'ops', desc: 'liste des opérateurs',
      run: () => { const l = Object.values(db.users).filter(u => u.op); return [`${l.length} op${l.length ? ' : ' + l.map(label).join(', ') : ''}`]; },
    },
    verify: {
      usage: 'verify <user>', desc: "valide l'e-mail d'un compte à la main", consoleOnly: true,
      run: (a, ctx) => {
        const u = target(a[0], ctx);
        if (u.verified) fail(`${u.name} est déjà vérifié.`);
        u.verified = true; u.code = null; model.store.touchDb(); hooks.changed(u, 'Ton e-mail a été validé par un administrateur.');
        return [`E-mail de ${label(u)} validé.`];
      },
    },
    say: {
      usage: 'say <message>', desc: 'annonce à tous les connectés',
      run: (a, ctx) => {
        const text = a.join(' ').trim();
        if (!text) fail('Usage : say <message>');
        hooks.announce(`📢 ${ctx.isConsole ? 'Administration' : ctx.user.name} : ${text.slice(0, 500)}`);
        return ['Annonce envoyée.'];
      },
    },
  };

  // actor : { console: true } ou { user }
  function run(line, actor) {
    const ctx = actor.console ? { isConsole: true } : { isConsole: false, user: actor.user };
    const toks = String(line || '').trim().replace(/^\//, '').split(/\s+/).filter(Boolean);
    if (!toks.length) return { ok: false, out: ['Tape « help » pour la liste des commandes.'] };
    let name = toks.shift().toLowerCase();
    if (name === 'prenium') name = 'premium';
    const cmd = COMMANDS[name];
    if (!cmd || (cmd.consoleOnly && !ctx.isConsole)) {
      return { ok: false, out: [cmd ? `La commande « ${name} » est réservée à la console du panneau admin.` : `Commande inconnue : ${name}. Tape « help ».`] };
    }
    try {
      const out = cmd.run(toks, ctx) || [];
      if (name !== 'help' && name !== 'list' && name !== 'whois' && name !== 'ops') {
        console.log(`[cmd] ${ctx.isConsole ? 'console' : `@${ctx.user.username}#${ctx.user.id}`} : ${String(line).trim().slice(0, 200)}`);
      }
      return { ok: true, out };
    } catch (e) {
      if (e instanceof CmdError) return { ok: false, out: [e.message] };
      throw e;
    }
  }

  return { run, names: Object.keys(COMMANDS) };
}

module.exports = { createCommands, fmtRec, fmtDur };
