// Emails du partenaire (Swan, via Zendesk) : réception, rattachement au dossier, brouillon client personnalisé, validation humaine avant envoi.
// En production, une adresse dédiée (ex. operations-swan@…) est reliée à un service d'email entrant (Postmark, SendGrid Inbound Parse, Mailgun…)
// qui appelle POST /api/swanmail/inbound avec { from, subject, text }. Ici, on simule ces emails ou on colle un email réel.
import { db, all, get, run } from './db.js';
import { relayPartnerEmail } from './capital.js';
import * as threads from './threads.js';

db.exec(`
CREATE TABLE IF NOT EXISTS sm_inbox (
  id INTEGER PRIMARY KEY, received_at TEXT DEFAULT CURRENT_TIMESTAMP, from_email TEXT, subject TEXT, body TEXT NOT NULL,
  swan_case_id TEXT, case_id INTEGER, ticket TEXT, category TEXT, request TEXT,
  status TEXT NOT NULL DEFAULT 'to_validate' CHECK (status IN ('to_validate','unmatched','sent','ignored')),
  to_role TEXT, to_name TEXT, to_email TEXT, draft_subject TEXT, draft_body TEXT, warnings TEXT DEFAULT '[]',
  validated_by TEXT, sent_at TEXT, ignored_reason TEXT);
`);
if (!all('PRAGMA table_info(sm_inbox)').some((c) => c.name === 'thread_id')) db.exec('ALTER TABLE sm_inbox ADD COLUMN thread_id INTEGER');   // rattachement aux conversations (threads.js)

const BRAND = 'Nova Pro';
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const firstName = (n) => String(n || '').split(' ')[0];
const eurStr = (c) => (c / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

// Catégories reconnues : mots-clés → libellé, appel à l'action dans le message client
const CATEGORIES = [
  { key: 'activite', label: 'Activité / origine des fonds', re: /activité|origine des fonds|provenance/i, cta: 'Répondez simplement à ce message, nous transmettrons.' },
  { key: 'virement', label: 'Apport / virement', re: /virement|apport|retourn|rembours|compte (?:émetteur|tiers)/i, cta: 'Votre compte de dépôt et le montant exact sont rappelés dans votre espace.' },
  { key: 'identite', label: 'Identité d’un associé', re: /pièce d.identité|passeport|carte d.identité|selfie|identification/i, cta: 'Vous pouvez reprendre la vérification d’identité depuis votre lien personnel.' },
  { key: 'domicile', label: 'Justificatif de domicile', re: /justificatif de domicile|proof of address|facture d.(?:énergie|électricité)|hébergement/i, cta: 'Déposez le nouveau justificatif dans votre espace, rubrique Documents.' },
  { key: 'siege', label: 'Siège / domiciliation', re: /domiciliation|siège|bail/i, cta: 'Déposez le document à jour dans votre espace, rubrique Documents.' },
  { key: 'statuts', label: 'Statuts / mandat', re: /statuts|mandat|pouvoir|signature/i, cta: 'Déposez la version corrigée dans votre espace, rubrique Documents.' },
  { key: 'kbis', label: 'Kbis / immatriculation', re: /kbis|extrait|immatricul/i, cta: 'Déposez l’extrait Kbis dans votre espace dès réception.' },
];
const OTHER = { key: 'autre', label: 'Autre demande', cta: 'Répondez simplement à ce message, nous transmettrons.' };

// Marque blanche : on retire le partenaire, ses identifiants et son vocabulaire interne
function whiteLabel(text, c) {
  let t = text;
  if (c) t = t.replaceAll(c.swan_id, c.ref);
  const rules = [
    [/(?:déclarée?s?|indiquée?s?|transmise?s?) (?:à|auprès de) Swan/gi, (m) => m.replace(/ (?:à|auprès de) Swan/i, ' dans votre dossier')],
    [/l[’']équipe (?:KYC|conformité|compliance)(?: de)? Swan/gi, 'notre équipe'],
    [/(?:le |la )?support (?:partenaires? )?Swan/gi, 'notre équipe'],
    [/\b(?:chez|par|à|auprès de) Swan\b/gi, ''],
    [/\bSwan\b/g, 'nous'],
    [/\bonboarding\b/gi, 'ouverture du dossier'],
    [/\bKYC\b/g, 'vérification d’identité'],
    [/ticket(?: Zendesk)?(?: n°| #)?\s*\d+/gi, ''],
    [/ {2,}/g, ' '], [/ ([,.])/g, '$1'],
  ];
  for (const [re, by] of rules) t = t.replace(re, by);
  return t.trim();
}

// Isole la demande : on enlève les en-têtes, la formule d'appel, la ligne de contexte et la signature
// Quand l'email vise un associé précis et qu'on lui écrit directement, on passe à la deuxième personne
function personalize(text, s) {
  if (!s) return text;
  const n = s.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text
    .replace(/merci de lui demander d[’']effectuer/gi, 'merci d’effectuer').replace(/merci de lui demander de /gi, 'merci de ')
    .replace(new RegExp(`(?:pour )?l[’']apport de ${n}`, 'gi'), (m) => (/^pour/i.test(m) ? 'pour votre apport' : 'votre apport'))
    .replace(new RegExp(`la pièce d[’']identité de ${n}`, 'gi'), 'votre pièce d’identité')
    .replace(new RegExp(`\\bpar ${n}`, 'g'), 'par vous').replace(/\bson nom\b/g, 'votre nom').replace(/\bsa dernière tentative\b/g, 'votre dernière tentative').replace(/\bson identification\b/g, 'votre vérification d’identité')
    .replace(/(^|[.!?]\s+)([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase());
}

function extractRequest(body) {
  const lines = body.replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => /^\s*(bonjour|hello|madame|monsieur)/i.test(l));
  const sig = lines.findIndex((l, i) => i > start && /^\s*(bien cordialement|cordialement|bien à vous|best regards|l[’']équipe|support partenaires?)/i.test(l));
  const core = lines.slice(start + 1, sig === -1 ? undefined : sig).filter((l) => !/^\s*(concernant|regarding)\b.*dossier/i.test(l) && !/^(de|objet|from|subject)\s*:/i.test(l) && !/répondre directement|reply (?:directly )?to this e-?mail/i.test(l));
  return core.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function analyse({ from, subject, body }) {
  const full = `${subject || ''}\n${body}`;
  const swanCaseId = full.match(UUID)?.[0]?.toLowerCase() || null;
  const c = swanCaseId ? get('SELECT * FROM cd_cases WHERE lower(swan_id)=?', swanCaseId) : null;
  const ticket = full.match(/ticket(?: Zendesk)?\s*(?:n°|#)\s*(\d+)/i)?.[1] || null;
  const cat = CATEGORIES.find((k) => k.re.test(full)) || OTHER;
  const request = extractRequest(body);
  const warnings = [];
  if (!/@(?:swan\.io|[\w-]+\.zendesk\.com)\b/i.test(from || '')) warnings.push('Expéditeur non reconnu comme Swan : vérifier avant tout envoi.');
  if (!swanCaseId) warnings.push('Aucun identifiant de dépôt de capital trouvé dans l’email.');
  else if (!c) warnings.push(`Identifiant ${swanCaseId} inconnu : aucun dossier correspondant.`);
  if (!c) return { swanCaseId, ticket, cat, request, warnings, c: null };
  if (['Completed', 'Canceled'].includes(c.status)) warnings.push('Le dossier est clôturé : la demande est peut-être obsolète.');

  // Destinataire : l'associé cité dans l'email, sinon le fondateur
  const shs = all('SELECT * FROM cd_shareholders WHERE case_id=? ORDER BY is_admin DESC, id', c.id);
  const lastName = (n) => n.split(' ').slice(-1)[0];
  const named = shs.filter((s) => new RegExp(`\\b${lastName(s.name).normalize('NFD').replace(/[̀-ͯ]/g, '')}\\b`, 'i').test(full.normalize('NFD').replace(/[̀-ͯ]/g, '')));
  const to = named.length === 1 ? named[0] : shs.find((s) => s.is_admin);
  if (named.length > 1) warnings.push('Plusieurs associés sont cités : destinataire par défaut le fondateur.');

  const clean = personalize(whiteLabel(request, c), named.length === 1 ? to : null);
  if (/swan/i.test(clean)) warnings.push('Le brouillon mentionne encore le partenaire : à reformuler.');
  if (/\b(the|please|document is|should|regarding)\b/i.test(clean)) warnings.push('Une partie de la demande semble en anglais : à traduire.');
  if (/https?:\/\//i.test(clean)) warnings.push('Le brouillon contient un lien externe : à vérifier.');
  const amounts = [...clean.matchAll(/(\d[\d\s ]*(?:,\d{2})?)\s?€/g)].map((m) => Math.round(Number(m[1].replace(/[\s ]/g, '').replace(',', '.')) * 100));
  const known = new Set([c.total_cents, ...shs.map((s) => s.amount_cents)]);
  if (amounts.some((a) => !known.has(a))) warnings.push('Un montant cité ne correspond à aucun apport du dossier.');

  const draft_subject = `${c.company_name} : une information est nécessaire pour votre dépôt de capital`;
  const draft_body = `Bonjour ${firstName(to.name)},\n\nPour avancer sur le dépôt de capital de ${c.company_name} (dossier ${c.ref}), nous avons besoin de votre aide :\n\n${clean}\n\n${cat.cta}\n\nMerci,\nL’équipe ${BRAND}`;
  return { swanCaseId, ticket, cat, request, warnings, c, to, draft_subject, draft_body };
}

export async function ingest({ from, subject, text, gmail }) {
  if (!text?.trim()) throw new Error('Email vide');
  const a = analyse({ from, subject, body: text });
  const id = Number(run(`INSERT INTO sm_inbox(from_email,subject,body,swan_case_id,case_id,ticket,category,request,status,to_role,to_name,to_email,draft_subject,draft_body,warnings)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, from || '', subject || '', text, a.swanCaseId, a.c?.id || null, a.ticket, a.cat.key, a.request,
    a.c ? 'to_validate' : 'unmatched', a.to ? (a.to.is_admin ? 'fondateur' : 'associé') : null, a.to?.name || null, a.to?.email || null,
    a.draft_subject || null, a.draft_body || null, JSON.stringify(a.warnings)).lastInsertRowid);
  if (a.c) threads.fromPartner(get('SELECT * FROM sm_inbox WHERE id=?', id), { from, subject, text, gmail });   // conversation Swan / nous / client
  return item(id);
}

const LABEL = Object.fromEntries([...CATEGORIES, OTHER].map((k) => [k.key, k.label]));
function item(id) {
  const r = get('SELECT * FROM sm_inbox WHERE id=?', id);
  if (!r) throw new Error('Email introuvable');
  const c = r.case_id ? get('SELECT id, ref, company_name, status FROM cd_cases WHERE id=?', r.case_id) : null;
  const recipients = r.case_id ? all('SELECT name, email, is_admin FROM cd_shareholders WHERE case_id=? ORDER BY is_admin DESC, id', r.case_id)
    .map((s) => ({ name: s.name, email: s.email, role: s.is_admin ? 'fondateur' : 'associé' })) : [];
  return { ...r, warnings: JSON.parse(r.warnings || '[]'), category_label: LABEL[r.category] || r.category, case: c, recipients };
}

export const list = () => all(`SELECT id FROM sm_inbox ORDER BY CASE status WHEN 'to_validate' THEN 0 WHEN 'unmatched' THEN 1 ELSE 2 END, id DESC LIMIT 100`).map((r) => item(r.id));
export const pending = (caseId) => all("SELECT id FROM sm_inbox WHERE case_id=? AND status='to_validate' ORDER BY id", caseId).map((r) => item(r.id));
export const stats = () => ({ to_validate: get("SELECT COUNT(*) n FROM sm_inbox WHERE status IN ('to_validate','unmatched')").n });

// Validation humaine : l'opérateur peut corriger destinataire, objet et texte avant l'envoi
export async function send(id, { to_email, subject, body, validated_by = 'Équipe opérations' } = {}) {
  const r = item(id);
  if (r.status !== 'to_validate') throw new Error('Cet email a déjà été traité');
  const to = r.recipients.find((x) => x.email === (to_email || r.to_email));
  if (!to) throw new Error('Destinataire inconnu pour ce dossier');
  const text = (body ?? r.draft_body).trim(), subj = (subject ?? r.draft_subject).trim();
  if (/swan/i.test(text + subj)) throw new Error('Le message mentionne encore le partenaire : reformulez avant d’envoyer');
  await relayPartnerEmail(r.case_id, { to, subject: subj, body: text, mailId: id, ticket: r.ticket });
  run("UPDATE sm_inbox SET status='sent', to_role=?, to_name=?, to_email=?, draft_subject=?, draft_body=?, validated_by=?, sent_at=CURRENT_TIMESTAMP WHERE id=?", to.role, to.name, to.email, subj, text, validated_by, id);
  return item(id);
}
export function ignore(id, reason) {
  const r = item(id);
  if (['sent', 'ignored'].includes(r.status)) throw new Error('Cet email a déjà été traité');
  run("UPDATE sm_inbox SET status='ignored', ignored_reason=? WHERE id=?", reason || 'Sans suite', id);
  return item(id);
}
// Rattachement manuel d'un email sans identifiant reconnu
export function attach(id, caseId) {
  const r = get('SELECT * FROM sm_inbox WHERE id=?', id), c = get('SELECT * FROM cd_cases WHERE id=?', caseId);
  if (!r || !c) throw new Error('Email ou dossier introuvable');
  run('DELETE FROM sm_inbox WHERE id=?', id);
  const text = r.body.includes(c.swan_id) ? r.body : `${r.body}\n\n[Rattaché manuellement au dossier ${c.swan_id}]`;
  return ingest({ from: r.from_email, subject: r.subject, text });
}

// ---------- Simulation : emails types envoyés par le support Swan ----------
export function sample(kind, caseId) {
  const c = caseId ? get('SELECT * FROM cd_cases WHERE id=?', caseId) : get("SELECT * FROM cd_cases WHERE status NOT IN ('Completed','Canceled') ORDER BY id DESC") || get('SELECT * FROM cd_cases ORDER BY id DESC');
  if (!c) throw new Error('Créez d’abord un dossier de dépôt de capital');
  const shs = all('SELECT * FROM cd_shareholders WHERE case_id=? ORDER BY is_admin DESC, id', c.id), other = shs[1] || shs[0];
  const civ = (s) => `${s.name}`;
  const asks = {
    siege: `Le contrat de domiciliation transmis date de plus de 3 mois et n’est signé que par la société de domiciliation. Merci de nous transmettre une version à jour, signée par les deux parties, à l’adresse déclarée à Swan.`,
    virement: `Le virement de ${eurStr(other.amount_cents)} reçu pour l’apport de ${civ(other)} a été retourné : il a été émis depuis un compte qui n’est pas à son nom. Merci de lui demander d’effectuer un nouveau virement SEPA depuis un compte personnel. Attention, il s’agit de sa dernière tentative.`,
    identite: `La pièce d’identité de ${civ(other)} est expirée depuis le mois dernier. Merci de lui demander de refaire son identification avec un document en cours de validité.`,
    activite: `Afin de finaliser notre revue, merci de nous préciser l’activité exacte de ${c.company_name} ainsi que l’origine des fonds apportés par ${civ(shs[0])} (épargne, vente d’un bien, donation…), avec un justificatif.`,
  };
  const k = asks[kind] ? kind : 'siege', ticket = Math.floor(100000 + Math.random() * 900000);
  return {
    from: 'Support Swan <support@swan.zendesk.com>',
    subject: `[Swan] Dossier de dépôt de capital ${c.swan_id} – informations complémentaires requises (#${ticket})`,
    text: `Bonjour,\n\nConcernant le dossier de dépôt de capital ${c.swan_id} (${c.company_name}) :\n\n${asks[k]}\n\nVous pouvez répondre directement à cet email.\n\nBien cordialement,\nL’équipe Support Partenaires Swan\nTicket Zendesk #${ticket}`,
  };
}
