// Conversations d'une demande du partenaire : Swan ↔ nous ↔ client, rattachées au dossier.
// Dans Gmail, il y a deux fils séparés (marque blanche) : le ticket Swan (support@…zendesk.com) et notre échange avec le client
// (envoyé depuis l'adresse du dossier depot+REF@…). L'outil les réunit en une seule conversation à trois colonnes.
import { db, all, get, run } from './db.js';
import * as gmail from './gmail.js';

db.exec(`
CREATE TABLE IF NOT EXISTS cd_threads (
  id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL, subject TEXT, ticket TEXT, category TEXT,
  partner_email TEXT, partner_thread TEXT, client_thread TEXT,
  status TEXT NOT NULL DEFAULT 'open', waiting_on TEXT, waiting_since TEXT, created_at TEXT, closed_at TEXT);
CREATE TABLE IF NOT EXISTS cd_thread_msgs (
  id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL, case_id INTEGER NOT NULL,
  lane TEXT NOT NULL,            -- auteur : swan | nous | client
  kind TEXT NOT NULL,            -- in (reçu) | out (envoyé) | note (interne)
  audience TEXT NOT NULL,        -- qui le voit : partner | client | internal
  from_name TEXT, from_email TEXT, to_name TEXT, to_email TEXT, subject TEXT, body TEXT,
  gmail_id TEXT, gmail_thread TEXT, message_id TEXT, in_reply_to TEXT, sm_id INTEGER, created_at TEXT);
`);

const BRAND = 'Nova Pro';
const nowIso = () => new Date().toISOString();
const caseOf = (id) => get('SELECT * FROM cd_cases WHERE id=?', id);
const threadRow = (id) => { const t = get('SELECT * FROM cd_threads WHERE id=?', id); if (!t) throw new Error('Conversation introuvable'); return t; };
const wait = (id, who) => run('UPDATE cd_threads SET waiting_on=?, waiting_since=? WHERE id=?', who, nowIso(), id);
function addMsg(t, m) {
  const id = Number(run(`INSERT INTO cd_thread_msgs(thread_id,case_id,lane,kind,audience,from_name,from_email,to_name,to_email,subject,body,gmail_id,gmail_thread,message_id,in_reply_to,sm_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, t.id, t.case_id, m.lane, m.kind, m.audience, m.from_name || null, m.from_email || null, m.to_name || null, m.to_email || null,
    m.subject || null, m.body, m.gmail_id || null, m.gmail_thread || null, m.message_id || null, m.in_reply_to || null, m.sm_id || null, m.created_at || nowIso()).lastInsertRowid);
  return id;
}
const cleanSubject = (s) => String(s || '').replace(/^\s*((re|tr|fwd?)\s*:\s*)+/i, '').replace(/^\[Swan\]\s*/i, '').trim();

// ---------- Réception d'un email du partenaire (appelé par swanmail.ingest une fois le dossier identifié) ----------
export function fromPartner(sm, { from, subject, text, gmail: g = {} }) {
  if (!sm.case_id) return null;
  let t = (sm.ticket && get("SELECT * FROM cd_threads WHERE case_id=? AND ticket=? ORDER BY id DESC", sm.case_id, sm.ticket))
    || (g.threadId && get('SELECT * FROM cd_threads WHERE partner_thread=?', g.threadId));
  if (!t) {
    const id = Number(run('INSERT INTO cd_threads(case_id,subject,ticket,category,partner_email,partner_thread,created_at) VALUES(?,?,?,?,?,?,?)',
      sm.case_id, cleanSubject(subject), sm.ticket, sm.category, from, g.threadId || `th_${Math.random().toString(36).slice(2, 12)}`, nowIso()).lastInsertRowid);
    t = threadRow(id);
  } else if (t.status === 'closed') run("UPDATE cd_threads SET status='open', closed_at=NULL WHERE id=?", t.id);
  addMsg(t, { lane: 'swan', kind: 'in', audience: 'partner', from_name: 'Support partenaires Swan', from_email: from, to_email: gmail.ADDRESS, subject, body: text,
    gmail_id: g.id || `gm_${Math.random().toString(36).slice(2, 12)}`, gmail_thread: t.partner_thread, message_id: g.messageId || `<${Math.random().toString(36).slice(2)}@zendesk.com>`, in_reply_to: g.inReplyTo, sm_id: sm.id });
  run('UPDATE sm_inbox SET thread_id=? WHERE id=?', t.id, sm.id);
  wait(t.id, 'nous');
  return t.id;
}

// ---------- Nous → client (brouillon validé dans Mailing, ou réponse depuis la conversation) ----------
export async function toClient(threadOrCase, { to, subject, body, smId }) {
  const t = typeof threadOrCase === 'object' ? threadOrCase : threadRow(threadOrCase);
  const c = caseOf(t.case_id), last = get("SELECT * FROM cd_thread_msgs WHERE thread_id=? AND audience='client' ORDER BY id DESC", t.id);
  const r = await gmail.send({ to: to.email, subject, text: body, threadId: t.client_thread || undefined, inReplyTo: last?.message_id, replyTo: gmail.caseAddress(c.ref) });
  if (!t.client_thread) run('UPDATE cd_threads SET client_thread=? WHERE id=?', r.threadId, t.id);
  addMsg(t, { lane: 'nous', kind: 'out', audience: 'client', from_name: `L’équipe ${BRAND}`, from_email: gmail.caseAddress(c.ref), to_name: to.name, to_email: to.email, subject, body,
    gmail_id: r.id, gmail_thread: r.threadId, message_id: r.messageId, in_reply_to: last?.message_id, sm_id: smId });
  wait(t.id, 'client');
  return r;
}
// Rattache l'envoi d'un brouillon partenaire validé à sa conversation (appelé par capital.relayPartnerEmail)
export async function relayToClient(caseId, mailId, { to, subject, body }) {
  const sm = mailId ? get('SELECT thread_id FROM sm_inbox WHERE id=?', mailId) : null;
  const t = sm?.thread_id ? threadRow(sm.thread_id) : get("SELECT * FROM cd_threads WHERE case_id=? AND status='open' ORDER BY id DESC", caseId);
  if (t) return toClient(t, { to, subject, body, smId: mailId });
  return gmail.send({ to: to.email, subject, text: body, replyTo: gmail.caseAddress(caseOf(caseId).ref) });
}

// ---------- Client → nous (réponse à l'adresse du dossier) ----------
export function fromClient({ caseId, threadId, from_email, from_name, subject, text, gmail: g = {} }) {
  const t = threadId ? threadRow(threadId)
    : (g.threadId && get('SELECT * FROM cd_threads WHERE client_thread=?', g.threadId))
      || get("SELECT t.* FROM cd_threads t WHERE t.case_id=? AND EXISTS (SELECT 1 FROM cd_thread_msgs m WHERE m.thread_id=t.id AND m.audience='client') ORDER BY t.status='open' DESC, t.id DESC", caseId);
  if (!t) throw new Error('Aucune conversation client pour ce dossier');
  const last = get("SELECT * FROM cd_thread_msgs WHERE thread_id=? AND audience='client' ORDER BY id DESC", t.id);
  const sh = get('SELECT * FROM cd_shareholders WHERE case_id=? AND lower(email)=lower(?)', t.case_id, String(from_email).replace(/^.*<|>.*$/g, ''));
  if (t.status === 'closed') run("UPDATE cd_threads SET status='open', closed_at=NULL WHERE id=?", t.id);
  addMsg(t, { lane: 'client', kind: 'in', audience: 'client', from_name: sh?.name || from_name || from_email, from_email, to_email: gmail.caseAddress(caseOf(t.case_id).ref),
    subject: subject || `Re: ${last?.subject || t.subject}`, body: text, gmail_id: g.id || `gm_${Math.random().toString(36).slice(2, 12)}`, gmail_thread: t.client_thread, message_id: g.messageId || `<${Math.random().toString(36).slice(2)}@mail.gmail.com>`, in_reply_to: last?.message_id });
  wait(t.id, 'nous');
  return t.id;
}

// ---------- Nous → Swan : réponse dans le fil du ticket (Zendesk la rattache grâce à In-Reply-To) ----------
export async function toPartner(threadId, { body }) {
  const t = threadRow(threadId);
  if (!body?.trim()) throw new Error('Message vide');
  const last = get("SELECT * FROM cd_thread_msgs WHERE thread_id=? AND lane='swan' ORDER BY id DESC", t.id);
  const subject = `Re: ${last?.subject || t.subject}`;
  const r = await gmail.send({ to: t.partner_email || 'support@swan.zendesk.com', subject, text: body, threadId: t.partner_thread, inReplyTo: last?.message_id, fromName: `Opérations ${BRAND}` });
  addMsg(t, { lane: 'nous', kind: 'out', audience: 'partner', from_name: `Opérations ${BRAND}`, from_email: gmail.ADDRESS, to_name: 'Support partenaires Swan', to_email: t.partner_email,
    subject, body, gmail_id: r.id, gmail_thread: t.partner_thread, message_id: r.messageId, in_reply_to: last?.message_id });
  wait(t.id, 'swan');
  return r;
}
export function note(threadId, body) {
  const t = threadRow(threadId);
  if (!body?.trim()) throw new Error('Note vide');
  addMsg(t, { lane: 'nous', kind: 'note', audience: 'internal', from_name: 'Équipe opérations', body: body.trim() });
}
export function setClosed(threadId, closed) {
  threadRow(threadId);
  run('UPDATE cd_threads SET status=?, closed_at=?, waiting_on=CASE WHEN ? THEN NULL ELSE waiting_on END WHERE id=?', closed ? 'closed' : 'open', closed ? nowIso() : null, closed ? 1 : 0, threadId);
}

// ---------- Lecture ----------
const WHO = { swan: 'Swan', nous: 'nous', client: 'le client' };
// Titre court d'un échange : ce que Swan demande, et pour quel associé. Le sujet du ticket Swan ne contient que l'identifiant
// technique du dossier (« Dossier de dépôt de capital 62ebdaca-… – informations complémentaires requises »), illisible dans une liste.
const TITLE = { activite: 'Activité et origine des fonds à préciser', virement: 'Virement à refaire', identite: 'Pièce d’identité à refaire',
  domicile: 'Justificatif de domicile à refaire', siege: 'Domiciliation du siège à refaire', statuts: 'Statuts ou mandat à corriger', kbis: 'Kbis à fournir' };
function shortTitle(t) {
  const req = get('SELECT request FROM sm_inbox WHERE thread_id=? ORDER BY id LIMIT 1', t.id)?.request || '';
  let base = TITLE[t.category];
  if (!base) {   // demande libre : sa première phrase, coupée proprement
    const first = req.split(/(?<=[.!?])\s+|\n/)[0]?.trim() || '';
    base = !first ? 'Demande de Swan' : first.length > 70 ? `${first.slice(0, 68).replace(/\s+\S*$/, '')}…` : first.replace(/[.:]$/, '');
  }
  const who = all('SELECT name FROM cd_shareholders WHERE case_id=?', t.case_id).map((s) => s.name).filter((n) => req.includes(n));
  return who.length === 1 ? `${base} · ${who[0]}` : base;
}
// Sujet d'origine, sans l'identifiant Swan du dossier (remplacé par notre référence)
// Extrait du dernier message : sans formule d'appel ni ligne « Concernant le dossier <identifiant> : »
const excerpt = (b, c) => String(b || '').replaceAll(c.swan_id, c.ref).replace(/^\s*(bonjour|hello|madame,? monsieur)[^\n]*\n+/i, '')
  .replace(/^\s*(concernant|regarding)[^\n]*dossier[^\n]*:\s*/i, '').replace(/\s+/g, ' ').trim();
const plainSubject = (s, c) => String(s || '').replace(c.swan_id, c.ref).replace(/\s*\(#\d+\)\s*$/, '');

export function list({ caseId } = {}) {
  return all(`SELECT t.*, c.ref, c.company_name, c.swan_id, (SELECT COUNT(*) FROM cd_thread_msgs m WHERE m.thread_id=t.id) AS n,
    (SELECT body FROM cd_thread_msgs m WHERE m.thread_id=t.id ORDER BY id DESC LIMIT 1) AS last_body,
    (SELECT created_at FROM cd_thread_msgs m WHERE m.thread_id=t.id ORDER BY id DESC LIMIT 1) AS last_at
    FROM cd_threads t JOIN cd_cases c ON c.id=t.case_id ${caseId ? 'WHERE t.case_id=?' : ''} ORDER BY t.status='open' DESC, last_at DESC`, ...(caseId ? [caseId] : []))
    .map((t) => ({ ...t, title: shortTitle(t), subject: plainSubject(t.subject, t), last_body: excerpt(t.last_body, t), waiting_label: t.status === 'closed' ? 'Clôturée' : `En attente de ${WHO[t.waiting_on] || '—'}` }));
}
export function full(threadId) {
  const t = threadRow(threadId), c = caseOf(t.case_id);
  const shareholders = all('SELECT name, email, is_admin FROM cd_shareholders WHERE case_id=? ORDER BY is_admin DESC, id', t.case_id);
  const sm = get('SELECT * FROM sm_inbox WHERE thread_id=? ORDER BY id DESC', t.id);
  return { thread: { ...t, title: shortTitle(t), subject: plainSubject(t.subject, c), waiting_label: t.status === 'closed' ? 'Clôturée' : `En attente de ${WHO[t.waiting_on] || '—'}` }, case: { id: c.id, ref: c.ref, company_name: c.company_name, swan_id: c.swan_id, status: c.status, info_source: c.info_source, info_relayed: c.info_relayed },
    shareholders, messages: all('SELECT * FROM cd_thread_msgs WHERE thread_id=? ORDER BY id', t.id), pendingDraft: sm && sm.status === 'to_validate' ? sm.id : null,
    gmail: gmail.status(), caseAddress: gmail.caseAddress(c.ref) };
}
// Ce que voit le client : uniquement nos échanges avec lui (jamais le fil Swan ni les notes)
export const forClient = (caseId, email) => all(`SELECT m.id, m.thread_id, m.lane, m.from_name, m.to_name, m.to_email, m.from_email, m.subject, m.body, m.created_at FROM cd_thread_msgs m
  WHERE m.case_id=? AND m.audience='client' AND (lower(m.to_email)=lower(?) OR lower(m.from_email)=lower(?)) ORDER BY m.id`, caseId, email, email);

// ---------- Simulation (mode simulé) : réponses types du client et du partenaire ----------
const CLIENT_SAMPLES = {
  activite: (c) => `Bonjour,\n\n${c.company_name} conçoit et vend des luminaires en ligne. Les fonds viennent de mon épargne personnelle (livret A et assurance vie) : je joins le relevé de rachat de l’assurance vie.\n\nBonne journée`,
  virement: () => `Bonjour,\n\nDésolé, j’avais utilisé le compte joint. Je viens de refaire le virement depuis mon compte personnel, en virement instantané.\n\nMerci`,
  identite: () => `Bonjour,\n\nJ’ai refait la vérification avec mon passeport, valable jusqu’en 2031.\n\nCordialement`,
  siege: () => `Bonjour,\n\nVoici le contrat de domiciliation daté de ce mois-ci, signé par nous deux. Je l’ai aussi déposé dans l’espace.\n\nMerci`,
};
export function sampleClientReply(threadId) {
  const t = threadRow(threadId), c = caseOf(t.case_id);
  const to = get("SELECT * FROM cd_thread_msgs WHERE thread_id=? AND audience='client' AND kind='out' ORDER BY id DESC", t.id);
  if (!to) throw new Error('Envoyez d’abord un message au client');
  return { from_email: to.to_email, text: (CLIENT_SAMPLES[t.category] || (() => 'Bonjour,\n\nC’est fait, j’ai déposé le document dans mon espace.\n\nMerci'))(c) };
}
export const samplePartnerReply = (threadId) => { const t = threadRow(threadId);
  return `Bonjour,\n\nMerci pour ces éléments, nous les avons bien reçus. La revue du dossier reprend ; nous revenons vers vous si besoin.\n\nBien cordialement,\nL’équipe Support Partenaires Swan${t.ticket ? `\nTicket Zendesk #${t.ticket}` : ''}`; };
export function partnerReply(threadId, text, g = {}) {
  const t = threadRow(threadId), last = get("SELECT * FROM cd_thread_msgs WHERE thread_id=? AND lane='nous' AND audience='partner' ORDER BY id DESC", t.id);
  addMsg(t, { lane: 'swan', kind: 'in', audience: 'partner', from_name: 'Support partenaires Swan', from_email: t.partner_email, to_email: gmail.ADDRESS, subject: g.subject || `Re: ${t.subject}`, body: text,
    gmail_id: g.id || `gm_${Math.random().toString(36).slice(2, 12)}`, gmail_thread: t.partner_thread, message_id: g.messageId || `<${Math.random().toString(36).slice(2)}@zendesk.com>`, in_reply_to: g.inReplyTo || last?.message_id });
  wait(t.id, 'nous');
}
