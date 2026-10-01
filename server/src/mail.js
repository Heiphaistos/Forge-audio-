import nodemailer from 'nodemailer';

/**
 * Outgoing mail (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM). Without SMTP_HOST/SMTP_FROM
 * nothing is sent and the mail features say they are unavailable. Codes are put in the message only:
 * never in a log line (nodemailer's own logger stays off).
 */
export function createMailer(env = process.env) {
  if (!env.SMTP_HOST || !env.SMTP_FROM) return { enabled: false, send: async () => { throw new Error('Envoi de mails non configuré'); } };
  const port = Number(env.SMTP_PORT) || 587;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port === 587, // never send the password or a code in clear
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS || '' } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  // « Forge Audio » <adresse de SMTP_FROM> (SMTP_FROM may be `Nom <a@b>` or `a@b`).
  const address = (String(env.SMTP_FROM).match(/<([^>]+)>/)?.[1] || env.SMTP_FROM).trim();
  return {
    enabled: true,
    /** Resolves with the SMTP server's answer (« 250 … »), safe to log. */
    send: async ({ to, subject, text, html }) => (await transport.sendMail({ from: { name: 'Forge Audio', address }, to, subject, text, html })).response,
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title, body) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="margin:0;padding:24px;background:#f4f1ee;font-family:Arial,Helvetica,sans-serif;color:#1d1814">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">
<p style="margin:0 0 16px;font-size:18px;font-weight:bold;color:#c2410c">Forge Audio</p>
${body}
<p style="margin:24px 0 0;font-size:12px;color:#6b625b">Message automatique de Forge Audio, ne pas répondre.</p>
</div></body></html>`;
const codeBlock = (code) => `<p style="margin:16px 0;font-size:30px;letter-spacing:6px;font-weight:bold;font-family:Consolas,monospace">${esc(code)}</p>`;
const p = (s) => `<p style="margin:0 0 12px;line-height:1.5">${s}</p>`;

/** The four messages, French, text + simple HTML, no image or link to load. */
export const MAILS = {
  verify: (code) => ({
    subject: `${code} : votre code de vérification Forge Audio`,
    text: `Bonjour,\n\nVoici le code pour vérifier votre adresse e-mail dans Forge Audio :\n\n${code}\n\nIl est valable 15 minutes. Saisissez-le dans Paramètres > Adresse e-mail.\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message : l'adresse ne sera pas liée.\n`,
    html: page('Vérification de votre adresse', p('Voici le code pour vérifier votre adresse e-mail dans Forge Audio :') + codeBlock(code)
      + p('Il est valable 15 minutes. Saisissez-le dans Paramètres &gt; Adresse e-mail.')
      + p('Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : l’adresse ne sera pas liée.')),
  }),
  reset: (code) => ({
    subject: 'Réinitialisation de votre mot de passe Forge Audio',
    text: `Bonjour,\n\nQuelqu'un a demandé à réinitialiser le mot de passe de votre compte Forge Audio. Voici le code :\n\n${code}\n\nIl est valable 15 minutes et ne sert qu'une fois. Ne le communiquez à personne.\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe ne change pas.\n`,
    html: page('Réinitialisation du mot de passe', p('Quelqu’un a demandé à réinitialiser le mot de passe de votre compte Forge Audio. Voici le code :') + codeBlock(code)
      + p('Il est valable 15 minutes et ne sert qu’une fois. <b>Ne le communiquez à personne.</b>')
      + p('Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : votre mot de passe ne change pas.')),
  }),
  resetDone: (username) => ({
    subject: 'Votre mot de passe Forge Audio a été réinitialisé',
    text: `Bonjour,\n\nLe mot de passe du compte Forge Audio « ${username} » vient d'être réinitialisé avec un code envoyé à cette adresse. Tous les appareils ont été déconnectés.\n\nSi ce n'est pas vous, prévenez immédiatement l'administrateur du serveur.\n`,
    html: page('Mot de passe réinitialisé', p(`Le mot de passe du compte Forge Audio « <b>${esc(username)}</b> » vient d’être réinitialisé avec un code envoyé à cette adresse. Tous les appareils ont été déconnectés.`)
      + p('<b>Si ce n’est pas vous</b>, prévenez immédiatement l’administrateur du serveur.')),
  }),
  emailRemoved: (username) => ({
    subject: 'Votre adresse e-mail a été retirée de Forge Audio',
    text: `Bonjour,\n\nCette adresse n'est plus liée au compte Forge Audio « ${username} » (retirée ou remplacée depuis les paramètres du compte). Elle ne servira plus à récupérer le compte.\n\nSi ce n'est pas vous, prévenez immédiatement l'administrateur du serveur.\n`,
    html: page('Adresse retirée', p(`Cette adresse n’est plus liée au compte Forge Audio « <b>${esc(username)}</b> » (retirée ou remplacée depuis les paramètres du compte). Elle ne servira plus à récupérer le compte.`)
      + p('<b>Si ce n’est pas vous</b>, prévenez immédiatement l’administrateur du serveur.')),
  }),
};
