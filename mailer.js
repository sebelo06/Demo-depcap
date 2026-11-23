// Envoi d'emails. Chaque message est d'abord copié dans la « boîte de test » (table outbox).
// Envoi réel seulement si MODE=live ET SMTP_URL défini (ex. smtps://user:pass@smtp.exemple.fr) ; en mode test, rien ne sort jamais.
import { all, get, run } from './db.js';

export async function sendMail({ to, subject, text, from, kind = 'autre' }) {
  const real = process.env.MODE === 'live' && !!process.env.SMTP_URL;
  let out = { mode: real ? 'sent' : 'simulated' };
  if (real) {
    try {
      const { default: nodemailer } = await import('nodemailer');
      await nodemailer.createTransport(process.env.SMTP_URL).sendMail({ from: process.env.SMTP_FROM || from, to, subject, text });
    } catch (e) { out = { mode: 'failed', error: e.message }; }
  }
  run('INSERT INTO outbox(kind,to_email,from_email,subject,body,mode,error) VALUES(?,?,?,?,?,?,?)', kind, to, from || '', subject, text, out.mode, out.error || null);
  return out;
}

export const outbox = (limit = 100) => all('SELECT * FROM outbox ORDER BY id DESC LIMIT ?', limit);
export const outboxCount = () => get('SELECT COUNT(*) n FROM outbox').n;
