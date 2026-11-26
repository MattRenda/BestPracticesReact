// Sends email over SMTP. Configure with SMTP_URL, e.g. smtps://you%40gmail.com@smtp.gmail.com:465,
// and put the password in SMTP_PASS (or inside the URL). Without SMTP_URL, emails are printed to
// the server log instead, which is fine for local use.
import nodemailer from 'nodemailer';

export function smtpOptions(url, pass) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port) || (u.protocol === 'smtps:' ? 465 : 587),
    secure: u.protocol === 'smtps:',
    auth: u.username ? { user: decodeURIComponent(u.username), pass: pass || decodeURIComponent(u.password) } : undefined,
  };
}

export function createMailer(env = process.env, log = console) {
  const from = env.MAIL_FROM || 'HireMe <no-reply@localhost>';
  const transport = env.SMTP_URL ? nodemailer.createTransport(smtpOptions(env.SMTP_URL, env.SMTP_PASS)) : null;
  const sent = []; // kept for tests and the dev log

  return {
    configured: !!transport,
    sent,
    async send({ to, subject, text }) {
      sent.push({ to, subject, text });
      if (sent.length > 50) sent.shift();
      if (!transport) {
        log.info?.(`[mail → ${to}] ${subject}\n${text}\n`);
        return;
      }
      await transport.sendMail({ from, to, subject, text });
    },
  };
}
