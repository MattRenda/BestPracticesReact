// Sends email through SMTP_URL (any provider: Resend, Postmark, SES, Gmail app password…).
// Without SMTP_URL, emails are printed to the server log instead, which is fine for local use.
import nodemailer from 'nodemailer';

export function createMailer(env = process.env, log = console) {
  const from = env.MAIL_FROM || 'HireMe <no-reply@localhost>';
  const transport = env.SMTP_URL ? nodemailer.createTransport(env.SMTP_URL) : null;
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
