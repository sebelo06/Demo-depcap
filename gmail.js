// Connecteur Gmail de la boîte opérations « dépôt de capital ».
// Mode SIMULÉ (défaut) : les envois vont dans la boîte de test, les réceptions sont simulées depuis l'outil ; identifiants Gmail fictifs.
// Mode RÉEL : API Gmail (OAuth, compte Google Workspace) dès que GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN et GMAIL_ADDRESS
// sont définis (voir .env.example et scripts/gmail-auth.mjs). Portées : gmail.readonly + gmail.send (pas de suppression ni de modification).
import { randomUUID } from 'node:crypto';
import { db, get, run } from './db.js';
import { sendMail } from './mailer.js';

db.exec(`CREATE TABLE IF NOT EXISTS gm_seen (gmail_id TEXT PRIMARY KEY, routed TEXT, seen_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS gm_state (key TEXT PRIMARY KEY, value TEXT);`);

const E = process.env;
export const isLive = !!(E.GMAIL_CLIENT_ID && E.GMAIL_CLIENT_SECRET && E.GMAIL_REFRESH_TOKEN && E.GMAIL_ADDRESS);
export const ADDRESS = E.GMAIL_ADDRESS || 'depot-capital@novapro.example';
// Adresse propre à un dossier : les réponses du client y reviennent et sont rattachées au bon dossier (sous-adressage « + »)
export const caseAddress = (ref) => ADDRESS.replace('@', `+${ref}@`);
export const refFromAddress = (s) => String(s || '').match(/\+(DC-\d{4}-\d{4})@/i)?.[1]?.toUpperCase() || null;
export const status = () => ({ mode: isLive ? 'live' : 'mock', address: ADDRESS, lastSync: get("SELECT value FROM gm_state WHERE key='lastSync'")?.value || null });

// ---------- Envoi ----------
// threadId : fil Gmail à prolonger ; inReplyTo / references : Message-ID du message auquel on répond (Zendesk s'en sert pour rattacher au ticket)
export async function send({ to, subject, text, threadId, inReplyTo, references, replyTo, fromName = 'Nova Pro', kind = 'dépôt de capital' }) {
  if (!isLive) {
    const r = await sendMail({ to, subject, text, from: replyTo || ADDRESS, kind });
    return { id: `gm_${randomUUID().slice(0, 12)}`, threadId: threadId || `th_${randomUUID().slice(0, 12)}`, messageId: `<${randomUUID()}@mail.gmail.com>`, mode: r.mode };
  }
  const headers = [`From: ${fromName} <${ADDRESS}>`, `To: ${to}`, `Subject: ${encodeHeader(subject)}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit',
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []), ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${references || inReplyTo}`] : [])];
  const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${text}`, 'utf8').toString('base64url');
  const sent = await gapi('messages/send', { method: 'POST', body: { raw, ...(threadId ? { threadId } : {}) } });
  const meta = await gapi(`messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`);
  run('INSERT INTO outbox(kind,to_email,from_email,subject,body,mode) VALUES(?,?,?,?,?,?)', kind, to, ADDRESS, subject, text, 'sent');
  return { id: sent.id, threadId: sent.threadId, messageId: header(meta.payload, 'Message-ID'), mode: 'sent' };
}

// ---------- Réception (mode réel) : nouveaux messages de la boîte, jamais traités deux fois ----------
export async function fetchNew(query = E.GMAIL_QUERY || 'in:inbox newer_than:7d -from:me') {
  if (!isLive) return [];
  const list = await gapi(`messages?q=${encodeURIComponent(query)}&maxResults=50`);
  const out = [];
  for (const { id } of list.messages || []) {
    if (get('SELECT 1 x FROM gm_seen WHERE gmail_id=?', id)) continue;
    const m = await gapi(`messages/${id}?format=full`);
    out.push({ id: m.id, threadId: m.threadId, from: header(m.payload, 'From'), to: [header(m.payload, 'To'), header(m.payload, 'Delivered-To'), header(m.payload, 'Cc')].filter(Boolean).join(', '),
      subject: header(m.payload, 'Subject'), messageId: header(m.payload, 'Message-ID'), inReplyTo: header(m.payload, 'In-Reply-To'), date: new Date(Number(m.internalDate)).toISOString(), text: bodyText(m.payload) });
  }
  run("INSERT INTO gm_state(key,value) VALUES('lastSync',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", new Date().toISOString());
  return out.reverse();   // du plus ancien au plus récent
}
export const markSeen = (id, routed) => run('INSERT OR IGNORE INTO gm_seen(gmail_id,routed) VALUES(?,?)', id, routed);

// ---------- API Gmail ----------
let token = null;
async function accessToken() {
  if (token && token.exp > Date.now() + 60e3) return token.value;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: E.GMAIL_CLIENT_ID, client_secret: E.GMAIL_CLIENT_SECRET, refresh_token: E.GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token' }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`Gmail : authentification refusée (${j.error || r.status})`);
  token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return token.value;
}
async function gapi(path, { method = 'GET', body } = {}) {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { method,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`Gmail : ${j.error?.message || r.status}`);
  return j;
}
const header = (p, name) => p?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
// Corps texte : la partie text/plain, sinon le HTML sans balises ; les citations des messages précédents sont retirées
function bodyText(p) {
  const find = (x, type) => (x.mimeType === type && x.body?.data ? x : (x.parts || []).map((y) => find(y, type)).find(Boolean));
  const part = find(p, 'text/plain') || find(p, 'text/html');
  let t = part ? Buffer.from(part.body.data, 'base64url').toString('utf8') : '';
  if (part?.mimeType === 'text/html') t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  return t.split(/\n(?:Le .{5,80} a écrit ?:|On .{5,80} wrote:)\s*\n/)[0].split('\n').filter((l) => !l.startsWith('>')).join('\n').trim();
}
