// Dépôt de capital en MARQUE BLANCHE : le client ne voit que notre produit, le partenaire bancaire (Swan) reste invisible.
// MAQUETTE : les appels à l'API Swan et ses webhooks sont simulés localement, avec des identifiants fictifs au format Swan.
// Chaque action (client, nous, Swan, notaire) peut être « passée » pour faire avancer le dossier.
// Chaque changement émet un webhook simulé, traité comme en production : dédoublonnage, relecture, détection de la transition, message client.
import PDFDocument from 'pdfkit';
import { randomUUID } from 'node:crypto';
import { db, all, get, run } from './db.js';
import { sendMail } from './mailer.js';
import { isLive, mockCredit } from './swan.js';
import { RULES, REASONS, SENSITIVE_REASONS, explain, precheck, consistency, recordRefusal, refusalStats } from './docrules.js';
import * as partnerMail from './swanmail.js';
import * as threads from './threads.js';

db.exec(`
CREATE TABLE IF NOT EXISTS cd_cases (
  id INTEGER PRIMARY KEY, ref TEXT UNIQUE, swan_id TEXT UNIQUE NOT NULL, company_name TEXT NOT NULL, legal_form TEXT, address TEXT,
  total_cents INTEGER NOT NULL, status TEXT NOT NULL, cancel_reason TEXT, cancel_note TEXT,
  info_request TEXT, info_source TEXT, info_relayed INTEGER DEFAULT 0, partner_email TEXT,
  certificate_at TEXT, completed_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS cd_shareholders (
  id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL, swan_id TEXT UNIQUE NOT NULL, onboarding_id TEXT, account_id TEXT, iban TEXT,
  name TEXT NOT NULL, email TEXT NOT NULL, address TEXT, amount_cents INTEGER NOT NULL, is_admin INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PendingOnboarding', attempts INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS cd_documents (
  id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL, shareholder_id INTEGER, swan_id TEXT UNIQUE NOT NULL, type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending', filename TEXT, reason_code TEXT, reason TEXT, refusals INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS cd_transactions (
  id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL, shareholder_id INTEGER NOT NULL, swan_id TEXT UNIQUE NOT NULL,
  amount_cents INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
-- Historique des refus : le commentaire de l'analyste (statusInfo.reason) disparaît de l'API dès qu'une nouvelle version est déposée
CREATE TABLE IF NOT EXISTS cd_doc_refusals (
  id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL, document_id INTEGER NOT NULL, reason_code TEXT, reason TEXT, refused_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS cd_events (event_id TEXT PRIMARY KEY, case_id INTEGER, type TEXT, resource_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS cd_state (resource_id TEXT PRIMARY KEY, status TEXT);
CREATE TABLE IF NOT EXISTS cd_log (id INTEGER PRIMARY KEY, case_id INTEGER, kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS cd_timeline (id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL, text TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS cd_messages (
  id INTEGER PRIMARY KEY, case_id INTEGER, event_id TEXT, rule TEXT NOT NULL, to_role TEXT, to_name TEXT, to_email TEXT,
  subject TEXT, body TEXT, mode TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);
// Alertes de délai dépassé côté partenaire bancaire : une ligne par (dossier, attente, niveau), jamais visible du client
db.exec(`CREATE TABLE IF NOT EXISTS cd_alerts (
  id INTEGER PRIMARY KEY, case_id INTEGER NOT NULL, akey TEXT NOT NULL, level TEXT NOT NULL, title TEXT, due TEXT, late_days INTEGER,
  opened_at TEXT, relaunched_at TEXT, acked_at TEXT, resolved_at TEXT, UNIQUE(case_id, akey, level));`);
// Horodatage des statuts (délais, « depuis », retards) : colonnes ajoutées aux bases existantes
for (const [t, col] of [['cd_cases', 'status_since TEXT'], ['cd_cases', "status_log TEXT DEFAULT '{}'"], ['cd_shareholders', 'status_since TEXT'], ['cd_shareholders', 'signed_at TEXT'], ['cd_cases', "articles_source TEXT DEFAULT 'generated'"], ['cd_documents', 'generated INTEGER'], ['cd_documents', 'client_note TEXT'], ['cd_documents', 'status_since TEXT']])
  if (!all(`PRAGMA table_info(${t})`).some((x) => x.name === col.split(' ')[0])) db.exec(`ALTER TABLE ${t} ADD COLUMN ${col}`);
// attempts = nombre de virements refusés ou retournés par Swan (jamais une cause d'annulation ; avant : chaque virement reçu comptait aussi). Recalcul unique depuis l'historique.
if (!get("SELECT 1 FROM settings WHERE key='cd_attempts_refusals_only'")) {
  for (const s of all('SELECT id, case_id, name FROM cd_shareholders')) {
    const n = get("SELECT COUNT(*) n FROM cd_transactions WHERE shareholder_id=? AND status='Rejected'", s.id).n
      + get('SELECT COUNT(*) n FROM cd_timeline WHERE case_id=? AND text=?', s.case_id, `Virement de ${s.name} retourné lors de la vérification`).n;
    run('UPDATE cd_shareholders SET attempts=? WHERE id=?', n, s.id);
  }
  run("INSERT INTO settings(key,value) VALUES('cd_attempts_refusals_only','1')");
}

// ---------- Marque et référentiels ----------
const BRAND = 'Nova Pro';
const FROM = 'depot-capital@novapro.example';
const SUPPORT = { role: 'support', name: 'Équipe opérations', email: 'operations@novapro.example' };
const PROJECT_ID = 'proj_maquette_nova';

export const DOC_TYPES = {
  // generated : produit par Nova Pro à partir de la saisie unique ; sign : à signer électroniquement par chaque associé avant envoi
  ArticlesOfIncorporation: { label: 'Statuts', rule: 'articles', scope: 'company', generated: true, sign: true },
  CompanyLeaseAgreement: { label: 'Contrat de domiciliation', rule: 'premises', scope: 'company', generated: true },
  PowerOfAttorney: { label: 'Mandat de dépôt', rule: 'poa', scope: 'company', generated: true, sign: true },
  ProofOfIdentity: { label: 'Pièce d’identité', rule: 'identity', scope: 'shareholder', kyc: true },
  ProofOfIndividualAddress: { label: 'Justificatif de domicile', rule: 'address', scope: 'shareholder' },
  RegisterExtract: { label: 'Extrait Kbis', rule: 'kbis', scope: 'company' },
  CapitalShareDepositCertificate: { label: 'Attestation de dépôt des fonds', scope: 'company', notary: true },
};
const INITIAL_DOCS = ['ArticlesOfIncorporation', 'CompanyLeaseAgreement', 'PowerOfAttorney'];
// Document produit par nous ? Par défaut selon le type ; les statuts peuvent être fournis par le client (colonne generated = 0)
const isGen = (d) => (d.generated == null ? !!DOC_TYPES[d.type].generated : !!d.generated);
const isSign = (d) => isGen(d) && !!DOC_TYPES[d.type].sign;
// Établissement dépositaire des fonds, à mentionner dans les statuts rédigés par le client (marque blanche : c'est le partenaire)
// À CONFIRMER auprès du partenaire avant production
export const DEPOSIT_BANK = { name: 'Swan SAS', address: '95 avenue du Président Wilson, 93100 Montreuil' };
// Libération minimale du capital en numéraire à la constitution
const MIN_RELEASE = { SAS: 0.5, SASU: 0.5, SARL: 0.2, EURL: 0.2 };

// Statuts Swan → libellés client (aucune mention du partenaire)
export const CASE_LABEL = {
  WaitingForInitialRequirements: 'Constitution du dossier', PendingInternalReview: 'Dossier en vérification',
  WaitingForAdditionalInformation: 'Complément demandé', WaitingForNotaryShareDepositCertificate: 'Attestation en préparation',
  WaitingForRegisterExtract: 'Attestation disponible', WaitingForNotaryTransfer: 'Libération du capital en cours',
  Completed: 'Capital libéré', Canceled: 'Dossier annulé',
};
export const SH_LABEL = {
  PendingOnboarding: 'Identité à vérifier', WaitingForVerification: 'Vérification en cours', WaitingForTransfer: 'Apport à virer',
  CapitalTransferred: 'Apport reçu', CapitalFundsWiredToNotary: 'Apport transmis au notaire', CapitalDepositCanceled: 'Annulé',
};
export const DOC_LABEL = { Pending: 'À déposer', Uploaded: 'Reçu, en vérification', Validated: 'Validé', Refused: 'Refusé' };
// Motifs d'annulation Swan (CapitalDepositCaseCanceledStatusInfo). « sensitive » = ne jamais divulguer le motif (LCB-FT)
export const CANCEL_REASONS = {
  CapitalDepositWithdrawn: { label: 'Retrait à la demande du client' },
  UnsupportedLegalForm: { label: 'Forme juridique non prise en charge', explain: 'la forme juridique choisie n’est pas prise en charge pour un dépôt de capital en ligne' },
  DeniedCountryResidency: { label: 'Pays de résidence non accepté', explain: 'le pays de résidence d’un associé ne permet pas d’ouvrir un compte de dépôt' },
  RefusedIbanCountry: { label: 'Pays de la banque émettrice refusé', explain: 'un apport provient d’une banque située dans un pays non accepté' },
  CapitalDepositRefusedByNotary: { label: 'Refus du notaire', explain: 'le notaire n’a pas pu valider le dépôt' },
  DuplicateOnboarding: { label: 'Dossier en double', explain: 'un autre dossier existe déjà pour cette société' },
  KYCIssue: { label: 'Vérification d’identité', sensitive: true },
  ForbiddenActivity: { label: 'Activité non autorisée', sensitive: true },
  ComplianceReason: { label: 'Conformité', sensitive: true },
  RegulatoryRequirement: { label: 'Exigence réglementaire', sensitive: true },
};

// Commentaires types d'un analyste KYC (texte libre, peut citer le partenaire) : CapitalDepositDocumentRefusedStatusInfo.reason
const ANALYST_SAMPLE = {
  ExpiredDocument: 'Le document fourni date de plus de 3 mois (ou n’est plus valide). Merci de transmettre une version récente.',
  BadDocumentQuality: 'Document flou, le nom du titulaire est illisible. Merci de fournir un scan couleur net avec les 4 coins visibles.',
  InvalidAddress: 'L’adresse du justificatif de domicile ne correspond pas à celle déclarée à Swan lors de l’onboarding.',
  CompanyNameMismatch: 'La raison sociale du document diffère de celle déclarée à Swan (forme juridique « SAS » manquante).',
  MissingSignature: 'Les statuts ne sont pas signés par tous les associés. Merci de transmettre la version signée par chacun.',
  UnacceptableDocument: 'Les relevés bancaires ne sont pas acceptés comme justificatif de domicile. Merci de fournir une facture d’énergie, d’internet ou de téléphone.',
};
const analystComment = (code, input) => (input === '-' ? null : input?.trim() || ANALYST_SAMPLE[code] || 'Document refusé par l’équipe KYC de Swan, merci de déposer un document conforme.');
const mentionsPartner = (t) => /swan/i.test(t || '');

// ---------- Utilitaires ----------
const guard = () => { if (isLive) throw new Error('Dépôt de capital : maquette disponible uniquement en mode test'); };
const eur = (c) => (c / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
// Horloge : décalable en maquette (« simuler +1 jour ») pour voir les délais et retards évoluer
let clockOffsetDays = 0;
export const clock = {
  get: () => ({ offsetDays: clockOffsetDays, now: now().toISOString() }),
  shift: (days) => { guard(); clockOffsetDays = days === 0 ? 0 : clockOffsetDays + Number(days || 0); return clock.get(); },
};
const now = () => new Date(Date.now() + clockOffsetDays * 864e5);
const nowIso = () => now().toISOString();
const parseTs = (v) => (v ? new Date(/T/.test(v) ? v : v.replace(' ', 'T') + 'Z') : null);
// Jours ouvrés (week-ends exclus ; jours fériés non gérés dans la maquette)
const addBD = (d, n) => { const x = new Date(d); let k = n; while (k > 0) { x.setDate(x.getDate() + 1); if (x.getDay() % 6) k--; } return x; };
const maxD = (...ds) => new Date(Math.max(...ds.filter(Boolean).map(Number)));
// Délais de référence en jours ouvrés : engagements affichés au client et seuils de retard côté interne
// Partenaire bancaire (invisible du client) : contacts pour les relances et l'escalade — maquette, adresses fictives
const PARTNER = { name: 'Swan', support: { role: 'partenaire', name: 'Support partenaires Swan', email: 'support-partenaires@swan.example' },
  manager: { role: 'partenaire', name: 'Responsable de compte Swan', email: 'responsable-compte@swan.example' } };
// Relance dès que le délai est dépassé ; escalade au responsable de compte après ESCALATE_AFTER jours ouvrés de retard
export const ESCALATE_AFTER = 2;
export const SLA = { kycCheck: 1, docCheck: 1, transfer: 1, review: 2, certificate: 2, registration: 7, release: 3 };
const log = (caseId, kind, title, detail = null) => run('INSERT INTO cd_log(case_id,kind,title,detail) VALUES(?,?,?,?)', caseId, kind, title, detail && typeof detail === 'object' ? JSON.stringify(detail, null, 2) : detail);
const timeline = (caseId, text) => run('INSERT INTO cd_timeline(case_id,text) VALUES(?,?)', caseId, text);
const caseRow = (id) => { const c = get('SELECT * FROM cd_cases WHERE id=?', id); if (!c) throw new Error('Dossier introuvable'); return c; };
const shs = (caseId) => all('SELECT * FROM cd_shareholders WHERE case_id=? ORDER BY is_admin DESC, id', caseId);
const docs = (caseId) => all('SELECT * FROM cd_documents WHERE case_id=? ORDER BY id', caseId);
const admin = (caseId) => get('SELECT * FROM cd_shareholders WHERE case_id=? AND is_admin=1', caseId);
const firstName = (n) => String(n || '').split(' ')[0];

// IBAN fictif mais valide (clé RIB + clé IBAN), au format des comptes de dépôt
function fakeIban() {
  const bank = '16958', branch = '00001', acct = String(Math.floor(1e10 + Math.random() * 9e10)).padStart(11, '0');
  const key = String(97 - ((89 * Number(bank) + 15 * Number(branch) + 3 * Number(acct)) % 97)).padStart(2, '0');
  const bban = bank + branch + acct + key;
  const mod = [...(bban + '152700')].reduce((r, d) => (r * 10 + Number(d)) % 97, 0);   // FR = 15 27, clé provisoire 00
  return ('FR' + String(98 - mod).padStart(2, '0') + bban).replace(/(.{4})/g, '$1 ').trim();
}

// ---------- Webhooks simulés : même traitement qu'en production ----------
async function emit(caseId, eventType, resourceId) {
  const ev = { eventType, eventId: randomUUID(), eventDate: nowIso(), projectId: PROJECT_ID, resourceId };
  log(caseId, 'webhook', eventType, ev);
  return processWebhook(caseId, ev);
}

// Relit la ressource visée par le webhook (le payload ne contient que son identifiant)
function readResource(type, id) {
  if (type.startsWith('CapitalDepositCaseEvent')) { const c = get('SELECT * FROM cd_cases WHERE swan_id=?', id); return c && { kind: 'case', row: c, status: c.status }; }
  if (type.startsWith('Shareholder')) { const s = get('SELECT * FROM cd_shareholders WHERE swan_id=?', id); return s && { kind: 'shareholder', row: s, status: s.status }; }
  if (type.startsWith('CapitalDepositDocument') || type.startsWith('SupportingDocument')) { const d = get('SELECT * FROM cd_documents WHERE swan_id=?', id); return d && { kind: 'document', row: d, status: d.status }; }
  if (type.startsWith('Transaction')) { const t = get('SELECT * FROM cd_transactions WHERE swan_id=?', id); return t && { kind: 'transaction', row: t, status: t.status }; }
  return null;
}

async function processWebhook(caseId, ev) {
  if (!run('INSERT OR IGNORE INTO cd_events(event_id,case_id,type,resource_id) VALUES(?,?,?,?)', ev.eventId, caseId, ev.eventType, ev.resourceId).changes) {
    log(caseId, 'skip', 'Événement déjà traité (eventId connu)'); return [];
  }
  const res = readResource(ev.eventType, ev.resourceId);
  if (!res) { log(caseId, 'skip', 'Ressource inconnue : ignorée'); return []; }
  if (res.kind === 'document' && res.status === 'Refused')       // relecture : le commentaire de l'analyste n'existe que dans l'API, pas dans le webhook
    log(caseId, 'api', 'query capitalDepositCase → document refusé (relecture)', { id: res.row.swan_id, type: res.row.type,
      statusInfo: { __typename: 'CapitalDepositDocumentRefusedStatusInfo', status: 'Refused', reasonCode: res.row.reason_code, reason: res.row.reason } });
  const prev = get('SELECT status FROM cd_state WHERE resource_id=?', ev.resourceId)?.status ?? null;
  run('INSERT INTO cd_state(resource_id,status) VALUES(?,?) ON CONFLICT(resource_id) DO UPDATE SET status=excluded.status', ev.resourceId, res.status);
  const plan = rules(ev.eventType, res, prev);
  const transition = `${prev || '∅'} → ${res.status}`;
  if (!plan.messages.length) { log(caseId, 'skip', `Aucun message client (${transition})`, plan.why || null); return []; }
  const out = [];
  for (const m of plan.messages) out.push(await deliver(caseId, ev.eventId, m));
  log(caseId, 'rule', `Règle « ${plan.messages[0].rule} » (${transition}) : ${out.length} message(s)`);
  return out;
}

async function deliver(caseId, eventId, m) {
  const r = await sendMail({ to: m.to.email, subject: m.subject, text: m.body, from: FROM, kind: 'dépôt de capital' });
  run('INSERT INTO cd_messages(case_id,event_id,rule,to_role,to_name,to_email,subject,body,mode) VALUES(?,?,?,?,?,?,?,?,?)',
    caseId, eventId, m.rule, m.to.role, m.to.name, m.to.email, m.subject, m.body, r.mode);
  return m;
}

// ---------- Règles : transition détectée → messages ----------
const who = (s) => ({ role: s.is_admin ? 'fondateur' : 'associé', name: s.name, email: s.email });
const sign = `\n\nL’équipe ${BRAND}`;
const link = (p) => `${process.env.CAPITAL_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.CAPITAL_PORT || 3100}`}/client${p ? '#' + p : ''}`;

function rules(type, res, prev) {
  const msgs = [], add = (rule, to, subject, body) => msgs.push({ rule, to, subject, body: body + sign });
  const c = res.kind === 'case' ? res.row : get('SELECT * FROM cd_cases WHERE id=?', res.row.case_id);
  const adm = admin(c.id), all_ = shs(c.id), co = c.company_name;

  if (res.kind === 'shareholder') {
    const s = res.row, st = s.status;
    if (type === 'Shareholder.Created')
      add('invitation', who(s), `${co} : déposez votre apport au capital`,
        `Bonjour ${firstName(s.name)},\n\n${s.is_admin ? 'Vous avez ouvert' : `${adm?.name || 'Le fondateur'} a ouvert`} le dossier de dépôt de capital de ${co}. Votre apport : ${eur(s.amount_cents)}.\n\nVos étapes :\n1. Vérifier votre identité (5 minutes, munissez-vous de votre pièce d’identité).\n2. Relire et signer électroniquement les statuts et le mandat de dépôt, préparés à partir du dossier.\n3. Virer votre apport.\n\n${link('kyc')}`);
    else if (st === 'WaitingForVerification' && prev === 'PendingOnboarding')
      add('identite-recue', who(s), 'Identité reçue : vérification en cours', `Bonjour ${firstName(s.name)},\n\nNous avons bien reçu vos informations d’identité. Nous les vérifions et revenons vers vous très vite avec les coordonnées de votre compte de dépôt.`);
    else if (st === 'WaitingForTransfer' && prev === 'WaitingForVerification') {
      add('iban-pret', who(s), `Votre compte de dépôt est prêt : virez ${eur(s.amount_cents)}`,
        `Bonjour ${firstName(s.name)},\n\nVotre identité est vérifiée. Vous pouvez virer votre apport au capital de ${co} :\n\n  IBAN : ${s.iban}\n  Montant exact : ${eur(s.amount_cents)}\n  Bénéficiaire : ${s.name}\n\nImportant :\n- virement SEPA (instantané conseillé) depuis un compte bancaire à votre nom ;\n- les virements internationaux et depuis le compte d’un tiers sont refusés ;\n- vous disposez de deux tentatives au maximum.`);
      if (!s.is_admin && adm) add('iban-pret', who(adm), `${s.name} peut verser son apport`, `Bonjour ${firstName(adm.name)},\n\nL’identité de ${s.name} est vérifiée et son compte de dépôt est prêt. Il ne lui reste plus qu’à virer ${eur(s.amount_cents)}.`);
    } else if (st === 'CapitalTransferred') {
      const done = all_.filter((x) => ['CapitalTransferred', 'CapitalFundsWiredToNotary'].includes(x.status)).length;
      add('apport-recu', who(s), 'Apport reçu', `Bonjour ${firstName(s.name)},\n\nNous avons bien reçu votre apport de ${eur(s.amount_cents)} pour ${co}. Merci !`);
      if (adm && adm.id !== s.id) add('apport-recu', who(adm), `Apport de ${s.name} reçu (${done}/${all_.length})`, `Bonjour ${firstName(adm.name)},\n\n${s.name} a versé son apport de ${eur(s.amount_cents)}. ${done} associé(s) sur ${all_.length} ont versé.`);
    }
    return { messages: msgs, why: 'Pas de message pour cette transition (déjà couverte ou purement interne).' };
  }

  if (res.kind === 'transaction') {
    const t = res.row, s = get('SELECT * FROM cd_shareholders WHERE id=?', t.shareholder_id);
    if (type === 'Transaction.Booked') return { messages: [], why: 'Couvert par Shareholder.Updated (CapitalTransferred) : on évite le doublon.' };
    if (type === 'Transaction.Rejected') {   // un refus n'annule jamais le dossier : l'associé refait un virement
      const nth = s.attempts > 1 ? ` (${s.attempts}e refus)` : '';
      add('virement-refuse', who(s), 'Votre virement a été refusé : merci de le refaire', `Bonjour ${firstName(s.name)},\n\nVotre virement de ${eur(t.amount_cents)} a été refusé : ${t.reason}.\n\nMerci de refaire un virement SEPA depuis un compte bancaire à votre nom, du montant exact, vers :\n  ${s.iban}\n\nLe virement refusé vous est restitué.`);
      if (adm && adm.id !== s.id) add('virement-refuse', who(adm), `Le virement de ${s.name} a été refusé`, `Bonjour ${firstName(adm.name)},\n\nLe virement de ${s.name} (${eur(t.amount_cents)}) a été refusé : ${t.reason}. Nous lui avons demandé de refaire un virement depuis un compte à son nom.`);
      add('virement-refuse', SUPPORT, `[${c.ref}] Virement refusé${nth} : ${s.name}`, `Dossier ${c.ref} (réf. partenaire ${c.swan_id})\nAssocié : ${s.name} <${s.email}>\nMotif : ${t.reason}\nL'associé doit refaire un virement. ${s.attempts > 1 ? 'Refus répété : appeler l’associé pour l’accompagner.' : ''}`.trim());
    }
    return { messages: msgs };
  }

  if (res.kind === 'document') {
    const d = res.row, T = DOC_TYPES[d.type], owner = d.shareholder_id ? get('SELECT * FROM cd_shareholders WHERE id=?', d.shareholder_id) : adm;
    if (d.status === 'Refused' && isGen(d)) {        // document que nous avons produit : c'est à nous de le corriger, pas au client
      add('document-genere-refuse', SUPPORT, `[${c.ref}] Document généré refusé : ${T.label}`, `Dossier ${c.ref} (réf. partenaire ${c.swan_id})\nDocument généré : ${T.label}\nCode : ${d.reason_code}\nCommentaire de l’analyste : ${d.reason || '(aucun)'}\nCorriger le modèle ou la saisie, puis régénérer depuis la console formaliste.`);
      add('document-genere-refuse', who(adm), `${T.label} : nous préparons une nouvelle version`, `Bonjour ${firstName(adm.name)},\n\nLe document « ${T.label} » que nous avons préparé doit être ajusté. Nous nous en occupons${isSign(d) ? ' ; chaque associé recevra la nouvelle version à signer' : ''}. Vous n’avez rien à faire pour l’instant.`);
      return { messages: msgs };
    }
    if (d.status === 'Refused') {
      const ex = explain(d.reason_code);   // le client reçoit notre consigne ; le commentaire libre de l'analyste reste interne
      if (SENSITIVE_REASONS.has(d.reason_code)) {      // conformité : aucun motif ni redépôt côté client, le support reprend la main
        add('document-refuse', who(owner), `${T.label} : notre équipe va vous contacter`, `Bonjour ${firstName(owner.name)},\n\nLe document « ${T.label} » n’a pas pu être accepté. ${ex.fix}`);
        add('document-refuse', SUPPORT, `[${c.ref}] Refus pour conformité : ${T.label}`, `Dossier ${c.ref} (réf. partenaire ${c.swan_id})\nDocument : ${T.label} (${d.type})\nCode : ${d.reason_code}\nCommentaire de l’analyste : ${d.reason || '(aucun)'}\nNe pas communiquer le motif au client. Voir avec le partenaire la suite à donner, puis rappeler ${owner.name} (${owner.email}).`);
        return { messages: msgs };
      }
      add('document-refuse', who(owner), `${T.label} refusé : ${ex.title}`, `Bonjour ${firstName(owner.name)},\n\nLe document « ${T.label} » ne peut pas être accepté.\n\nMotif : ${ex.title}\nComment corriger : ${ex.fix}${d.client_note ? `\n\nPoints à corriger :\n${d.client_note}` : ''}\n\nDéposez une nouvelle version :\n${link('docs')}`);
      if (d.refusals >= 2) add('document-refuse', SUPPORT, `[${c.ref}] 2e refus : ${T.label}`, `Dossier ${c.ref} (réf. partenaire ${c.swan_id})\nDocument : ${T.label} (${d.type}), ${d.refusals} refus.\nCode : ${d.reason_code}\nCommentaire de l’analyste : ${d.reason || '(aucun)'}\nAppeler ${owner.name} (${owner.email}) avant un 3e refus : le partenaire ouvre alors un ticket.`);
      return { messages: msgs };
    }
    return { messages: [], why: d.type === 'CapitalShareDepositCertificate' ? 'Couvert par le passage du dossier à WaitingForRegisterExtract.' : `Document ${d.status} : suivi mis à jour dans l’app, pas d’email.` };
  }

  // Dossier
  const st = c.status, everyone = all_.map(who), A = adm ? [who(adm)] : [];
  if (type === 'CapitalDepositCaseEvent.Created')
    A.forEach((to) => add('dossier-cree', to, `Dossier de dépôt de capital ${c.ref} ouvert`, `Bonjour ${firstName(to.name)},\n\nLe dossier de dépôt de capital de ${co} (${eur(c.total_cents)}) est ouvert sous la référence ${c.ref}.\n\nNous avons préparé les statuts, le mandat de dépôt et le contrat de domiciliation à partir de vos informations.\n\nProchaines étapes :\n1. Chaque associé relit et signe électroniquement les statuts et le mandat de dépôt.\n2. Chaque associé vérifie son identité et dépose un justificatif de domicile.\n3. Chaque associé vire son apport.\n\nSuivez l’avancement ici : ${link()}`));
  else if (type === 'CapitalDepositCaseEvent.Canceled') {
    const R = CANCEL_REASONS[c.cancel_reason] || {};
    if (c.cancel_reason === 'CapitalDepositWithdrawn') everyone.forEach((to) => add('annulation', to, `Dossier ${c.ref} annulé`, `Bonjour ${firstName(to.name)},\n\nLe dossier de dépôt de capital de ${co} a bien été annulé à votre demande. ${get("SELECT 1 x FROM cd_transactions WHERE case_id=? AND status='Booked'", c.id) ? 'Les apports déjà versés vous sont restitués.' : 'Aucun fonds n’a été versé.'}`));
    else if (R.sensitive) {
      A.forEach((to) => add('annulation', to, `Votre dossier ${c.ref} ne peut pas aboutir`, `Bonjour ${firstName(to.name)},\n\nNous ne sommes pas en mesure de poursuivre le dossier de dépôt de capital de ${co}. Un conseiller va vous contacter pour vous expliquer les prochaines étapes, notamment pour les fonds déjà versés.`));
      add('annulation', SUPPORT, `[${c.ref}] Annulation sensible (${c.cancel_reason})`, `Dossier ${c.ref} (réf. partenaire ${c.swan_id}) annulé pour ${c.cancel_reason}.\nNE PAS communiquer le motif au client (pas de divulgation LCB-FT). Rappeler le fondateur avec le script conformité.`);
    } else {
      const why = R.explain || c.cancel_note || 'le dossier n’a pas pu être validé';
      everyone.forEach((to) => add('annulation', to, `Dossier ${c.ref} annulé`, `Bonjour ${firstName(to.name)},\n\nLe dossier de dépôt de capital de ${co} est annulé : ${why}.\nLes apports déjà versés vous sont restitués. Notre équipe reste disponible pour toute question.`));
      add('annulation', SUPPORT, `[${c.ref}] Dossier annulé (${c.cancel_reason || 'deux virements refusés'})`, `Dossier ${c.ref} (réf. partenaire ${c.swan_id}). Vérifier la restitution des fonds et rappeler le fondateur.`);
    }
  } else if (st === 'PendingInternalReview' && prev === 'WaitingForAdditionalInformation')
    A.forEach((to) => add('complement-recu', to, 'Complément reçu', `Bonjour ${firstName(to.name)},\n\nMerci, nous avons bien reçu votre complément. La vérification du dossier reprend.`));
  else if (st === 'PendingInternalReview')
    everyone.forEach((to) => add('dossier-complet', to, `${co} : dossier complet, vérification en cours`, `Bonjour ${firstName(to.name)},\n\nTous les documents et tous les apports sont réunis. Le dossier est en cours de vérification ; nous vous prévenons dès qu’il passe chez le notaire.`));
  else if (st === 'WaitingForAdditionalInformation') {
    if (c.info_source === 'document') return { messages: [], why: 'Complément lié à un document refusé : le client a déjà reçu le message de refus.' };
    add('complement-a-traiter', SUPPORT, `[${c.ref}] Complément demandé par le partenaire : à reformuler`, `Le partenaire a envoyé une demande en texte libre (email Zendesk) pour le dossier ${c.ref}.\nÀ reformuler et envoyer au fondateur depuis la vue interne.`);
  } else if (st === 'WaitingForInitialRequirements' && ['PendingInternalReview', 'WaitingForAdditionalInformation', 'WaitingForNotaryShareDepositCertificate'].includes(prev)) {
    A.forEach((to) => add('virement-retourne', to, 'Action requise sur un apport', `Bonjour ${firstName(to.name)},\n\nUn apport a été retourné lors de la vérification du dossier. L’associé concerné doit refaire un virement conforme ; nous lui avons écrit.`));
    add('virement-retourne', SUPPORT, `[${c.ref}] Virement retourné`, `Dossier ${c.ref} (réf. partenaire ${c.swan_id}) revenu à WaitingForInitialRequirements. Suivre le nouveau virement.`);
  } else if (st === 'WaitingForNotaryShareDepositCertificate')
    A.forEach((to) => add('chez-le-notaire', to, 'Dossier validé : attestation sous 2 jours ouvrés', `Bonjour ${firstName(to.name)},\n\nBonne nouvelle : le dossier de ${co} est validé et transmis au notaire. L’attestation de dépôt des fonds arrive sous 2 jours ouvrés au plus.`));
  else if (st === 'WaitingForRegisterExtract' && prev === 'WaitingForNotaryTransfer')
    return { messages: [], why: 'Kbis refusé : le client a déjà reçu le message de refus du document.' };
  else if (st === 'WaitingForRegisterExtract')
    everyone.forEach((to) => add('attestation-prete', to, `Attestation de dépôt de ${co} disponible`, `Bonjour ${firstName(to.name)},\n\nL’attestation de dépôt des fonds (${eur(c.total_cents)}) est disponible :\n${link('attestation')}\n\n${to.role === 'fondateur' ? 'Prochaine étape : immatriculer la société au guichet unique (joignez l’attestation), puis déposer l’extrait Kbis dans votre espace pour libérer le capital.' : 'Le fondateur s’occupe maintenant de l’immatriculation.'}`));
  else if (st === 'WaitingForNotaryTransfer')
    A.forEach((to) => add('kbis-transmis', to, 'Kbis reçu : capital libéré sous 3 jours ouvrés', `Bonjour ${firstName(to.name)},\n\nMerci, l’extrait Kbis est transmis au notaire. Le capital sera viré sur le compte de ${co} sous 3 jours ouvrés au plus.`));
  else if (st === 'Completed')
    everyone.forEach((to) => add('capital-libere', to, `Capital de ${co} libéré`, `Bonjour ${firstName(to.name)},\n\nLe capital de ${eur(c.total_cents)} est arrivé sur le compte professionnel de ${co}. La société peut démarrer son activité !`));
  return { messages: msgs, why: 'Transition sans message client.' };
}

// Modèles de messages (menu Mailing)
export const TEMPLATES = [
  ['dossier-cree', 'CapitalDepositCaseEvent.Created', 'Fondateur', 'Dossier ouvert, prochaines étapes'],
  ['invitation', 'Shareholder.Created', 'Associé', 'Invitation et lien de vérification d’identité'],
  ['identite-recue', 'Shareholder.Updated → WaitingForVerification', 'Associé', 'Identité reçue, vérification en cours'],
  ['iban-pret', 'Shareholder.Updated → WaitingForTransfer', 'Associé, fondateur', 'IBAN du compte de dépôt et consignes de virement'],
  ['apport-recu', 'Shareholder.Updated → CapitalTransferred', 'Associé, fondateur', 'Apport reçu, avancement des versements'],
  ['virement-refuse', 'Transaction.Rejected', 'Associé, fondateur, support', 'Virement refusé : l’associé refait un virement'],
  ['alerte-partenaire', 'Minuterie : délai partenaire dépassé', 'Support (interne)', 'Alerte relance ou escalade, message au partenaire prêt à envoyer'],
  ['relance-partenaire', 'Action interne (console formaliste)', 'Partenaire (support ou responsable de compte)', 'Relance du partenaire sur un délai dépassé'],
  ['document-genere-refuse', 'CapitalDepositDocument.Updated → Refused (document généré)', 'Support, fondateur', 'Document généré refusé : correction par nos soins'],
  ['signature-demandee', 'Action interne (document régénéré)', 'Tous', 'Nouvelle version à signer'],
  ['document-refuse', 'CapitalDepositDocument.Updated / SupportingDocument.Updated → Refused', 'Propriétaire du document (+ support au 2e refus)', 'Motif traduit et consigne de correction'],
  ['dossier-complet', 'CapitalDepositCaseEvent.Updated → PendingInternalReview', 'Tous', 'Dossier complet, en vérification'],
  ['complement-a-traiter', 'CapitalDepositCaseEvent.Updated → WaitingForAdditionalInformation', 'Support', 'Demande libre du partenaire à reformuler'],
  ['complement-relaye', 'Action interne', 'Fondateur', 'Demande de complément reformulée'],
  ['complement-recu', 'CapitalDepositCaseEvent.Updated → PendingInternalReview', 'Fondateur', 'Complément reçu, vérification reprise'],
  ['virement-retourne', 'CapitalDepositCaseEvent.Updated → WaitingForInitialRequirements', 'Fondateur, support', 'Un apport a été retourné'],
  ['chez-le-notaire', 'CapitalDepositCaseEvent.Updated → WaitingForNotaryShareDepositCertificate', 'Fondateur', 'Dossier validé, attestation sous 2 jours ouvrés'],
  ['attestation-prete', 'CapitalDepositCaseEvent.Updated → WaitingForRegisterExtract', 'Tous', 'Attestation disponible, étapes d’immatriculation'],
  ['kbis-transmis', 'CapitalDepositCaseEvent.Updated → WaitingForNotaryTransfer', 'Fondateur', 'Kbis transmis, capital sous 3 jours ouvrés'],
  ['capital-libere', 'CapitalDepositCaseEvent.Updated → Completed', 'Tous', 'Capital arrivé sur le compte pro'],
  ['annulation', 'CapitalDepositCaseEvent.Canceled', 'Selon le motif', 'Confirmation, explication ou message neutre (motif sensible)'],
  ['relance', 'Action interne (minuterie)', 'Associé', 'Relance d’un associé qui n’avance pas'],
  ['email-partenaire', 'Email du partenaire (Zendesk), validé par un opérateur', 'Fondateur ou associé cité', 'Demande du partenaire reformulée en marque blanche'],
].map(([rule, trigger, to, desc]) => ({ rule, trigger, to, desc }));

export function mailing() {
  const sent = all(`SELECT m.*, c.ref FROM cd_messages m LEFT JOIN cd_cases c ON c.id=m.case_id ORDER BY m.id DESC LIMIT 200`);
  const counts = Object.fromEntries(all('SELECT rule, COUNT(*) n FROM cd_messages GROUP BY rule').map((r) => [r.rule, r.n]));
  return { templates: TEMPLATES.map((t) => ({ ...t, sent: counts[t.rule] || 0 })), sent };
}

// Envoi d'un email partenaire reformulé, après validation par un opérateur (outil Emails partenaire)
export async function relayPartnerEmail(caseId, { to, subject, body, mailId, ticket }) {
  const c = caseRow(caseId);
  // Envoi par la boîte Gmail, depuis l'adresse du dossier, dans le fil de la conversation (les réponses du client y reviennent)
  const r = await threads.relayToClient(caseId, mailId, { to, subject, body });
  run('INSERT INTO cd_messages(case_id,event_id,rule,to_role,to_name,to_email,subject,body,mode) VALUES(?,?,?,?,?,?,?,?,?)', caseId, null, 'email-partenaire', to.role, to.name, to.email, subject, body, r.mode || 'simulated');
  log(caseId, 'rule', `Email partenaire n°${mailId}${ticket ? ` (ticket #${ticket})` : ''} reformulé, validé et envoyé à ${to.name}`);
  timeline(caseId, `Demande d’information envoyée à ${to.name}`);
  if (c.status === 'WaitingForAdditionalInformation' && c.info_source === 'email')
    run('UPDATE cd_cases SET info_relayed=1, info_request=? WHERE id=?', body.split('\n\n').slice(2, -2).join('\n\n') || body, caseId);
}

// ---------- Création du dossier (appel createCapitalDeposit simulé) ----------
export async function create({ companyName, legalForm, address, shareholders, articlesSource }) {
  guard();
  if (!companyName?.trim()) throw new Error('Nom de la société obligatoire');
  const sh = (shareholders || []).filter((s) => s.name?.trim());
  if (!sh.length) throw new Error('Au moins un associé est requis');
  for (const s of sh) {
    if (!(Number(s.amount) > 0)) throw new Error(`Apport invalide pour ${s.name}`);
    if (!/^\S+@\S+\.\S+$/.test(s.email || '')) throw new Error(`Email invalide pour ${s.name}`);
  }
  const total = sh.reduce((a, s) => a + Math.round(Number(s.amount) * 100), 0);
  const year = new Date().getFullYear(), n = get('INSERT INTO counters(key,value) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET value=value+1 RETURNING value', `DC-${year}`).value;
  const ref = `DC-${year}-${String(n).padStart(4, '0')}`, swanId = randomUUID();
  const src = articlesSource === 'client' ? 'client' : 'generated';
  const id = Number(run("INSERT INTO cd_cases(ref,swan_id,company_name,legal_form,address,total_cents,status,status_since,status_log,articles_source) VALUES(?,?,?,?,?,?,'WaitingForInitialRequirements',?,?,?)",
    ref, swanId, companyName.trim(), legalForm || 'SAS', (address || '').trim(), total, nowIso(), JSON.stringify({ WaitingForInitialRequirements: nowIso() }), src).lastInsertRowid);
  const created = sh.map((s, i) => {
    const sid = randomUUID();
    const pid = Number(run('INSERT INTO cd_shareholders(case_id,swan_id,onboarding_id,name,email,address,amount_cents,is_admin,status_since) VALUES(?,?,?,?,?,?,?,?,?)',
      id, sid, randomUUID(), s.name.trim(), s.email.trim(), (s.address || '').trim(), Math.round(Number(s.amount) * 100), i === 0 ? 1 : 0, nowIso()).lastInsertRowid);
    for (const t of ['ProofOfIdentity', 'ProofOfIndividualAddress']) run('INSERT INTO cd_documents(case_id,shareholder_id,swan_id,type) VALUES(?,?,?,?)', id, pid, randomUUID(), t);
    return { id: sid, status: 'PendingOnboarding', name: s.name.trim() };
  });
  for (const t of INITIAL_DOCS) run('INSERT INTO cd_documents(case_id,swan_id,type,status_since,generated) VALUES(?,?,?,?,?)', id, randomUUID(), t, nowIso(),
    t === 'ArticlesOfIncorporation' && src === 'client' ? 0 : DOC_TYPES[t].generated ? 1 : 0);
  log(id, 'api', 'mutation createCapitalDeposit', {
    input: { acquisitionChannel: 'API', mainCompany: { name: companyName.trim(), legalForm: legalForm || 'SAS', address }, shareholders: sh.map((s) => ({ individual: { name: s.name, email: s.email }, capitalDepositAmount: { value: String(s.amount), currency: 'EUR' } })) },
    response: { __typename: 'CreateCapitalDepositSuccessPayload', capitalDepositCase: { id: swanId, statusInfo: { status: 'WaitingForInitialRequirements' }, totalCapitalDepositAmount: { value: (total / 100).toFixed(2), currency: 'EUR' }, shareholders: created } },
  });
  timeline(id, `Dossier ${ref} créé : ${sh.length} associé(s), capital de ${eur(total)}`);
  await emit(id, 'CapitalDepositCaseEvent.Created', swanId);
  for (const s of shs(id)) await emit(id, 'Shareholder.Created', s.swan_id);
  // Saisie unique : les documents société sont produits à partir du dossier. La domiciliation (notre offre) est signée à la souscription ;
  // statuts et mandat attendent la signature électronique de chaque associé avant d'être envoyés au partenaire.
  timeline(id, src === 'client' ? 'Documents de la société générés : mandat de dépôt, contrat de domiciliation (statuts fournis par le client)' : 'Documents de la société générés à partir du dossier : statuts, mandat de dépôt, contrat de domiciliation');
  log(id, 'rule', 'Génération des documents société (modèles Nova Pro) : statuts et mandat à signer, domiciliation déjà signée');
  const lease = get("SELECT * FROM cd_documents WHERE case_id=? AND type='CompanyLeaseAgreement'", id);
  log(id, 'api', 'mutation generateCapitalDepositDocumentUploadUrl + PUT du fichier', { input: { capitalDepositCaseId: swanId, documentId: lease.swan_id, filename: 'contrat-domiciliation.pdf' } });
  await setDoc(id, lease, 'Uploaded', { filename: 'contrat-domiciliation.pdf' });
  return view(id);
}

// ---------- Mutations internes (chacune émet le webhook correspondant) ----------
async function setShareholder(caseId, s, status, extra = {}) {
  const sets = Object.entries({ status, ...(s.status !== status ? { status_since: nowIso() } : {}), ...extra });
  run(`UPDATE cd_shareholders SET ${sets.map(([k]) => `${k}=?`).join(',')} WHERE id=?`, ...sets.map(([, v]) => v), s.id);
  await emit(caseId, 'Shareholder.Updated', s.swan_id);
}
async function setDoc(caseId, d, status, extra = {}) {
  const sets = Object.entries({ status, ...(d.status !== status ? { status_since: nowIso() } : {}), ...extra });
  run(`UPDATE cd_documents SET ${sets.map(([k]) => `${k}=?`).join(',')} WHERE id=?`, ...sets.map(([, v]) => v), d.id);
  await emit(caseId, DOC_TYPES[d.type].kyc ? 'SupportingDocument.Updated' : 'CapitalDepositDocument.Updated', d.swan_id);
}
async function setCase(caseId, status, extra = {}) {
  const prev = caseRow(caseId), stamp = prev.status !== status ? { status_since: nowIso(), status_log: JSON.stringify({ ...JSON.parse(prev.status_log || '{}'), [status]: nowIso() }) } : {};
  const sets = Object.entries({ status, ...stamp, ...extra });
  run(`UPDATE cd_cases SET ${sets.map(([k]) => `${k}=?`).join(',')} WHERE id=?`, ...sets.map(([, v]) => v), caseId);
  await emit(caseId, status === 'Canceled' ? 'CapitalDepositCaseEvent.Canceled' : 'CapitalDepositCaseEvent.Updated', caseRow(caseId).swan_id);
}

// Dès que documents et apports sont réunis, le partenaire passe le dossier en revue
async function autoProgress(caseId) {
  const c = caseRow(caseId);
  if (c.status !== 'WaitingForInitialRequirements') return;
  const pendingDoc = docs(caseId).some((d) => !['RegisterExtract', 'CapitalShareDepositCertificate'].includes(d.type) && ['Pending', 'Refused'].includes(d.status));
  const allPaid = shs(caseId).every((s) => s.status === 'CapitalTransferred');
  if (!pendingDoc && allPaid) { timeline(caseId, 'Dossier complet : vérification en cours'); await setCase(caseId, 'PendingInternalReview'); }
}

async function storeUpload(caseId, d, filename) {
  const c = caseRow(caseId), wasRefused = d.status === 'Refused';
  log(caseId, 'api', 'mutation generateCapitalDepositDocumentUploadUrl + PUT du fichier', { input: { capitalDepositCaseId: c.swan_id, documentId: d.swan_id, filename } });
  await setDoc(caseId, d, 'Uploaded', { filename, reason_code: null, reason: null, client_note: null });
  timeline(caseId, `${wasRefused ? 'Nouvelle version déposée' : 'Document déposé'} : ${DOC_TYPES[d.type].label}${d.shareholder_id ? ` (${get('SELECT name FROM cd_shareholders WHERE id=?', d.shareholder_id).name})` : ''}`);
  if (d.type === 'RegisterExtract' && c.status === 'WaitingForRegisterExtract') { timeline(caseId, 'Kbis transmis au notaire'); await setCase(caseId, 'WaitingForNotaryTransfer'); }
  if (c.status === 'WaitingForAdditionalInformation' && c.info_source === 'document' && !docs(caseId).some((x) => x.status === 'Refused'))
    await setCase(caseId, 'PendingInternalReview', { info_request: null, info_source: null, info_relayed: 0 });
  await autoProgress(caseId);
}

// Dépôt réel par le client (contrôles avant envoi + cohérence avec le dossier)
export async function uploadDoc(caseId, docId, { filename, size, confirmed, seen = {}, force } = {}) {
  guard();
  const d = get('SELECT * FROM cd_documents WHERE id=? AND case_id=?', docId, caseId), c = caseRow(caseId);
  if (!d) throw new Error('Document introuvable');
  if (!canUpload(c, d)) throw new Error('Ce document n’est pas attendu pour le moment');
  precheck({ filename, size, confirmed });
  const s = d.shareholder_id ? get('SELECT * FROM cd_shareholders WHERE id=?', d.shareholder_id) : null;
  const warnings = consistency(RULES[DOC_TYPES[d.type].rule]?.declared, { address: s?.address, company: c.company_name, companyAddress: c.address }, seen);
  if (warnings.length && !force) throw Object.assign(new Error('Écart avec le dossier détecté'), { warnings });
  await storeUpload(caseId, d, filename);
  return view(caseId);
}
// Refus pour conformité : le client ne redépose pas, l'équipe reprend la main avec le partenaire
const sensitiveRefusal = (d) => d.status === 'Refused' && SENSITIVE_REASONS.has(d.reason_code);
const canUpload = (c, d) => !DOC_TYPES[d.type].kyc && !DOC_TYPES[d.type].notary && !isGen(d) && ['Pending', 'Refused'].includes(d.status) && !sensitiveRefusal(d)
  && (d.type === 'RegisterExtract' ? c.status === 'WaitingForRegisterExtract' : !['Completed', 'Canceled'].includes(c.status));

// ---------- Actions « passables » ----------
const ACTORS = { client: 'Client', nous: 'Nous', swan: 'Partenaire bancaire (Swan)', notaire: 'Notaire' };
export function actions(caseId) {
  const c = caseRow(caseId), S = shs(caseId), D = docs(caseId), out = [];
  const A = (id, actor, label, extra = {}) => out.push({ id, actor, actorLabel: ACTORS[actor], label, ...extra });
  const sName = (d) => (d.shareholder_id ? S.find((s) => s.id === d.shareholder_id)?.name : c.company_name);
  if (['Completed', 'Canceled'].includes(c.status)) return out;
  const idOf = (s) => D.find((d) => d.shareholder_id === s.id && d.type === 'ProofOfIdentity');
  for (const s of S) {
    const idDoc = idOf(s);
    if (s.status === 'PendingOnboarding' || (s.status === 'WaitingForVerification' && idDoc?.status === 'Refused'))
      A(`kyc:${s.id}`, 'client', `${s.name} fait sa vérification d’identité`, { happy: true });
  }
  const toSign = D.some((d) => isSign(d) && d.status === 'Pending');
  if (toSign) for (const s of S) if (!s.signed_at) A(`sign:${s.id}`, 'client', `${s.name} relit et signe les documents générés`, { happy: true });
  for (const d of D) if (isGen(d) && d.status === 'Refused') A(`regenerate:${d.id}`, 'nous', `Corriger et régénérer « ${DOC_TYPES[d.type].label} »`, { happy: true });
  for (const d of D) if (canUpload(c, d)) A(`upload:${d.id}`, 'client', `Déposer « ${DOC_TYPES[d.type].label} » (${sName(d)})`, { happy: true });
  for (const d of D) if (sensitiveRefusal(d) && !isGen(d)) A(`upload:${d.id}`, 'nous', `Après échange avec le partenaire, déposer une nouvelle version de « ${DOC_TYPES[d.type].label} » (${sName(d)})`, { happy: true });
  for (const s of S) if (s.status === 'WaitingForVerification' && idOf(s)?.status === 'Uploaded') A(`verify:${s.id}`, 'swan', `Vérifier l’identité de ${s.name} et ouvrir son compte de dépôt`, { happy: true });
  for (const d of D) if (d.status === 'Uploaded' && !DOC_TYPES[d.type].notary && d.type !== 'RegisterExtract') {
    if (!DOC_TYPES[d.type].kyc) A(`validate:${d.id}`, 'swan', `Valider « ${DOC_TYPES[d.type].label} » (${sName(d)})`, { happy: true });
    A(`refuse:${d.id}`, 'swan', `Refuser « ${DOC_TYPES[d.type].label} » (${sName(d)})`, { needsReason: 'doc' });
  }
  if (c.status === 'WaitingForInitialRequirements' || c.status === 'WaitingForAdditionalInformation')
    for (const s of S) if (s.status === 'WaitingForTransfer') {
      A(`transfer:${s.id}`, 'client', `${s.name} vire son apport (${eur(s.amount_cents)})`, { happy: true });
      A(`transfer-bad:${s.id}`, 'client', `${s.name} vire depuis le compte d’un tiers (refusé par Swan)`);
    }
  const P = plan(c, S, D);
  for (const s of S) if (P.todos[s.id]?.length) A(`remind:${s.id}`, 'nous', `Relancer ${s.name}`);
  if (c.status === 'PendingInternalReview') {
    A('review-ok', 'swan', 'Valider le dossier et le transmettre au notaire', { happy: true });
    A('review-info', 'swan', 'Demander un complément par email (texte libre)');
    for (const s of S) if (s.status === 'CapitalTransferred') A(`return-transfer:${s.id}`, 'swan', `Retourner le virement de ${s.name}`);
  }
  if (c.status === 'WaitingForAdditionalInformation' && c.info_source === 'email') {
    if (!c.info_relayed) A('relay-info', 'nous', 'Valider le brouillon de l’email partenaire et l’envoyer (Mailing › Emails partenaire)', { happy: true });
    else A('answer', 'client', 'Le fondateur répond à la demande de complément', { happy: true });
  }
  if (c.status === 'WaitingForNotaryShareDepositCertificate') A('certificate', 'notaire', 'Délivrer l’attestation de dépôt des fonds', { happy: true });
  if (c.status === 'WaitingForNotaryTransfer') {
    A('release', 'notaire', 'Valider le Kbis et libérer le capital', { happy: true });
    A('kbis-refuse', 'notaire', 'Refuser le Kbis', { needsReason: 'doc' });
  }
  if (!S.some((s) => ['CapitalTransferred', 'CapitalFundsWiredToNotary'].includes(s.status))) A('cancel', 'client', 'Le fondateur annule le dossier');
  A('swan-cancel', 'swan', 'Annuler le dossier', { needsReason: 'cancel' });
  return out;
}

export async function act(caseId, { action, reasonCode, message, by, note, control } = {}) {
  guard();
  if (action === 'next') {
    const n = actions(caseId).find((a) => a.happy);
    if (!n) throw new Error('Aucune action à passer : le dossier est terminé');
    return act(caseId, { action: n.id, by });
  }
  const allowed = actions(caseId).find((a) => a.id === action);
  if (!allowed) throw new Error('Action impossible à cette étape');
  const [name, arg] = action.split(':'), c = caseRow(caseId);
  const s = arg && ['kyc', 'sign', 'verify', 'transfer', 'transfer-bad', 'remind', 'return-transfer'].includes(name) ? get('SELECT * FROM cd_shareholders WHERE id=? AND case_id=?', +arg, caseId) : null;
  const d = arg && ['upload', 'validate', 'refuse', 'regenerate'].includes(name) ? get('SELECT * FROM cd_documents WHERE id=? AND case_id=?', +arg, caseId) : null;
  const docOf = (sh, type) => get('SELECT * FROM cd_documents WHERE shareholder_id=? AND type=?', sh.id, type);

  switch (name) {
    case 'kyc': {
      const idDoc = docOf(s, 'ProofOfIdentity');
      timeline(caseId, `${s.name} a vérifié son identité`);
      await setDoc(caseId, idDoc, 'Uploaded', { filename: 'identite-kyc.jpg', reason_code: null, reason: null });
      if (s.status === 'PendingOnboarding') await setShareholder(caseId, s, 'WaitingForVerification');
      break;
    }
    case 'upload': await storeUpload(caseId, d, `${d.type}.pdf`); break;
    case 'sign': {
      run('UPDATE cd_shareholders SET signed_at=? WHERE id=?', nowIso(), s.id);
      const signed = docs(caseId).filter((x) => isSign(x) && x.status === 'Pending').map((x) => DOC_TYPES[x.type].label.toLowerCase()).join(' et ');
      log(caseId, 'rule', `Signature électronique de ${s.name} : ${signed}`);
      timeline(caseId, `${s.name} a signé : ${signed}`);
      if (shs(caseId).every((x) => x.signed_at))           // dernière signature : envoi des versions signées au partenaire
        for (const x of docs(caseId)) if (isSign(x) && x.status === 'Pending') await storeUpload(caseId, x, `${x.type}-signe.pdf`);
      break;
    }
    case 'regenerate': {
      log(caseId, 'rule', `Document corrigé et régénéré par l’équipe : ${DOC_TYPES[d.type].label}`);
      timeline(caseId, `Nouvelle version préparée : ${DOC_TYPES[d.type].label}`);
      if (isSign(d)) {                      // nouvelle version = nouvelles signatures
        run('UPDATE cd_shareholders SET signed_at=NULL WHERE case_id=?', caseId);
        await setDoc(caseId, d, 'Pending', { reason_code: null, reason: null, filename: null });
        for (const x of shs(caseId)) await deliver(caseId, null, { rule: 'signature-demandee', to: who(x), subject: `${c.company_name} : nouvelle version à signer`,
          body: `Bonjour ${firstName(x.name)},\n\nNous avons préparé une nouvelle version du document « ${DOC_TYPES[d.type].label} ». Merci de la relire et de la signer :\n${link('signature')}${sign}` });
      } else await storeUpload(caseId, d, `${d.type}-v${d.refusals + 1}.pdf`);
      break;
    }
    case 'verify': {
      await setDoc(caseId, docOf(s, 'ProofOfIdentity'), 'Validated');
      const accountId = randomUUID(), iban = fakeIban();
      timeline(caseId, `Identité de ${s.name} vérifiée : compte de dépôt ouvert`);
      await setShareholder(caseId, s, 'WaitingForTransfer', { account_id: accountId, iban });
      break;
    }
    case 'validate': if (control) log(caseId, 'rule', `Contrôle des statuts : ${control.length} points conformes`, control); if (by === 'formaliste') log(caseId, 'rule', `Document contrôlé et validé par le formaliste : ${DOC_TYPES[d.type].label}`); await setDoc(caseId, d, 'Validated'); timeline(caseId, `Document validé : ${DOC_TYPES[d.type].label}`); await autoProgress(caseId); break;
    case 'refuse': {
      const code = REASONS[reasonCode] ? reasonCode : 'BadDocumentQuality', ex = explain(code), comment = analystComment(code, message);
      recordRefusal({ source: 'capital', label: DOC_TYPES[d.type].label, code, reason: comment });
      run('INSERT INTO cd_doc_refusals(case_id,document_id,reason_code,reason,refused_by) VALUES(?,?,?,?,?)', caseId, d.id, code, comment, by === 'formaliste' ? 'Formaliste' : 'Analyste KYC Swan');
      timeline(caseId, `Document refusé : ${DOC_TYPES[d.type].label} (${ex.title})`);
      if (control) log(caseId, 'rule', `Contrôle des statuts : ${control.filter((x) => x.ok === false).length} écart(s) sur ${control.length} points`, control);
      await setDoc(caseId, d, 'Refused', { reason_code: code, reason: comment, refusals: d.refusals + 1, client_note: by === 'formaliste' && note?.trim() ? note.trim() : null });
      if (c.status === 'PendingInternalReview') await setCase(caseId, 'WaitingForAdditionalInformation', { info_request: `${DOC_TYPES[d.type].label} : ${ex.title}`, info_source: 'document', info_relayed: 1 });
      break;
    }
    case 'transfer': {
      const txId = randomUUID();
      run("INSERT INTO cd_transactions(case_id,shareholder_id,swan_id,amount_cents,status) VALUES(?,?,?,?,'Booked')", caseId, s.id, txId, s.amount_cents);
      await emit(caseId, 'Transaction.Booked', txId);
      timeline(caseId, `Apport de ${s.name} reçu : ${eur(s.amount_cents)}`);
      await setShareholder(caseId, s, 'CapitalTransferred');      // un virement reçu est valable : seuls les refus de Swan comptent comme tentative ratée
      await autoProgress(caseId);
      break;
    }
    case 'transfer-bad': {
      const txId = randomUUID(), attempts = s.attempts + 1;
      run('UPDATE cd_shareholders SET attempts=? WHERE id=?', attempts, s.id);
      run("INSERT INTO cd_transactions(case_id,shareholder_id,swan_id,amount_cents,status,reason) VALUES(?,?,?,?,'Rejected',?)", caseId, s.id, txId, s.amount_cents, 'le compte émetteur n’est pas au nom de l’associé');
      timeline(caseId, `Virement de ${s.name} refusé par le partenaire : nouveau virement à faire`);
      await emit(caseId, 'Transaction.Rejected', txId);
      break;
    }
    case 'remind': {                                   // rappel de tout ce que l'associé doit faire, avec le motif si un document est refusé
      const T = plan(c, shs(caseId), docs(caseId)).todos[s.id] || [];
      const docLabel = (t) => { const d = get('SELECT type FROM cd_documents WHERE id=?', t.docId); const l = DOC_TYPES[d.type].label; return `${{ 'Pièce d’identité': 'votre', Statuts: 'vos' }[l] || 'votre'} ${l.charAt(0).toLowerCase() + l.slice(1)}`; };
      const say = (t) => (t.kind === 'doc' ? `${t.urgent ? 'Remplacer' : 'Déposer'} ${docLabel(t)}` : t.title);
      const lines = T.map((t) => `- ${say(t)}${t.why ? `\n  ${t.urgent ? 'Motif : ' : ''}${t.why}` : ''}${t.kind === 'transfer' ? `\n  IBAN : ${t.iban}\n  Montant exact : ${eur(t.amount_cents)}\n  Depuis un compte à votre nom (virement SEPA)` : ''}`).join('\n');
      const first = T[0] ? say(T[0]) : 'votre dossier';
      log(caseId, 'rule', `Relance de ${s.name} (${T.length} action(s) en attente)`);
      await deliver(caseId, null, { rule: 'relance', to: who(s), subject: `Rappel : ${first.charAt(0).toLowerCase() + first.slice(1)} (${c.company_name})`,
        body: `Bonjour ${firstName(s.name)},\n\nLe dépôt de capital de ${c.company_name} attend une action de votre part${T.some((t) => t.urgent) ? ' : il est en pause tant qu’elle n’est pas faite' : ''}.\n\n${lines}\n\n${link(T[0]?.kind === 'kyc' ? 'kyc' : 'docs')}${sign}` });
      timeline(caseId, `Relance envoyée à ${s.name}`);
      break;
    }
    case 'review-ok':
      for (const x of docs(caseId)) if (x.status === 'Uploaded' && x.type !== 'RegisterExtract') await setDoc(caseId, x, 'Validated');
      timeline(caseId, 'Dossier validé : transmis au notaire');
      await setCase(caseId, 'WaitingForNotaryShareDepositCertificate', { info_request: null, info_source: null, info_relayed: 0 });
      for (const x of shs(caseId)) await setShareholder(caseId, x, 'CapitalFundsWiredToNotary');
      break;
    case 'review-info': {
      const txt = message || 'Justificatif de siège : le contrat de domiciliation doit dater de moins de 3 mois et être signé par les deux parties. Merci de déposer une version à jour.';
      const email = `De : Support Swan <support@swan.io>\nObjet : Dossier de dépôt de capital ${c.swan_id} – informations complémentaires requises\n\nBonjour,\n\nConcernant le dossier de dépôt de capital ${c.swan_id} (${c.company_name}) :\n${txt}\n\nBien cordialement,\nSupport partenaires Swan (ticket Zendesk n° ${Math.floor(100000 + Math.random() * 900000)})`;
      log(caseId, 'zendesk', 'Email du partenaire reçu (Zendesk) : demande en texte libre', email);
      await partnerMail.ingest({ from: 'Support Swan <support@swan.zendesk.com>', subject: `[Swan] Dossier de dépôt de capital ${c.swan_id} – informations complémentaires requises`, text: email.split('\n').slice(3).join('\n') });
      timeline(caseId, 'Complément demandé lors de la vérification');
      await setCase(caseId, 'WaitingForAdditionalInformation', { info_request: txt, info_source: 'email', info_relayed: 0, partner_email: email });
      break;
    }
    case 'relay-info': {
      const p = partnerMail.pending(caseId)[0];
      if (p) { await partnerMail.send(p.id); break; }      // valide le brouillon préparé par l'outil Emails partenaire
      const adm = admin(caseId);
      const txt = message || 'Pour finaliser la vérification, nous avons besoin d’un contrat de domiciliation de moins de 3 mois, signé par vous et par la société de domiciliation. Déposez-le dans votre espace, rubrique Documents.';
      run('UPDATE cd_cases SET info_relayed=1, info_request=? WHERE id=?', txt, caseId);
      log(caseId, 'rule', 'Demande du partenaire reformulée par l’équipe opérations');
      await deliver(caseId, null, { rule: 'complement-relaye', to: who(adm), subject: 'Un complément est nécessaire pour votre dossier', body: `Bonjour ${firstName(adm.name)},\n\n${txt}\n\n${link('docs')}${sign}` });
      timeline(caseId, 'Demande de complément envoyée au fondateur');
      break;
    }
    case 'answer':
      log(caseId, 'api', 'Complément transmis au partenaire (dépôt du document + réponse au ticket)');
      timeline(caseId, 'Complément envoyé');
      await setCase(caseId, 'PendingInternalReview', { info_request: null, info_source: null, info_relayed: 0 });
      break;
    case 'return-transfer':
      timeline(caseId, `Virement de ${s.name} retourné lors de la vérification`);
      await setShareholder(caseId, s, 'WaitingForTransfer', { attempts: s.attempts + 1 });
      await setCase(caseId, 'WaitingForInitialRequirements');
      break;
    case 'certificate': {
      const cert = { id: Number(run("INSERT INTO cd_documents(case_id,swan_id,type,status,filename) VALUES(?,?,'CapitalShareDepositCertificate','Validated','attestation-depot.pdf')", caseId, randomUUID()).lastInsertRowid) };
      await emit(caseId, 'CapitalDepositDocument.Created', get('SELECT swan_id FROM cd_documents WHERE id=?', cert.id).swan_id);
      const kb = Number(run("INSERT INTO cd_documents(case_id,swan_id,type) VALUES(?,?,'RegisterExtract')", caseId, randomUUID()).lastInsertRowid);
      await emit(caseId, 'CapitalDepositDocument.Created', get('SELECT swan_id FROM cd_documents WHERE id=?', kb).swan_id);
      timeline(caseId, 'Attestation de dépôt des fonds délivrée par le notaire');
      await setCase(caseId, 'WaitingForRegisterExtract', { certificate_at: nowIso() });
      break;
    }
    case 'kbis-refuse': {
      const kb = get("SELECT * FROM cd_documents WHERE case_id=? AND type='RegisterExtract'", caseId);
      const code = REASONS[reasonCode] ? reasonCode : 'CompanyNameMismatch', ex = explain(code), comment = analystComment(code, message);
      recordRefusal({ source: 'capital', label: 'Extrait Kbis', code, reason: comment });
      run("INSERT INTO cd_doc_refusals(case_id,document_id,reason_code,reason,refused_by) VALUES(?,?,?,?,'Notaire')", caseId, kb.id, code, comment);
      timeline(caseId, `Kbis refusé par le notaire (${ex.title})`);
      run("UPDATE cd_cases SET status='WaitingForRegisterExtract', status_since=? WHERE id=?", nowIso(), caseId);   // la transition est portée par le refus du document
      await setDoc(caseId, kb, 'Refused', { reason_code: code, reason: comment, refusals: kb.refusals + 1 });
      await emit(caseId, 'CapitalDepositCaseEvent.Updated', c.swan_id);
      break;
    }
    case 'release': {
      const kb = get("SELECT * FROM cd_documents WHERE case_id=? AND type='RegisterExtract'", caseId);
      await setDoc(caseId, kb, 'Validated');
      mockCredit({ label: `Libération du capital — ${c.company_name}`, counterparty: 'Notaire (compte séquestre)', amount: (c.total_cents / 100).toFixed(2) });
      timeline(caseId, `Capital de ${eur(c.total_cents)} viré sur le compte de la société`);
      await setCase(caseId, 'Completed', { completed_at: nowIso() });
      break;
    }
    case 'cancel': timeline(caseId, 'Dossier annulé par le fondateur'); log(caseId, 'api', 'mutation cancelCapitalDepositCase'); await cancelCase(caseId, 'CapitalDepositWithdrawn'); break;
    case 'swan-cancel': {
      const code = CANCEL_REASONS[reasonCode] ? reasonCode : 'ComplianceReason';
      timeline(caseId, CANCEL_REASONS[code].sensitive ? 'Dossier interrompu' : `Dossier annulé : ${CANCEL_REASONS[code].label}`);
      await cancelCase(caseId, code);
      break;
    }
    default: throw new Error('Action inconnue');
  }
  return view(caseId);
}

// Annulation depuis l'accueil, à toute étape : par le fondateur tant qu'aucun apport n'est versé, sinon retrait avec restitution des apports
export async function withdraw(caseId) {
  guard();
  const c = caseRow(caseId);
  if (['Completed', 'Canceled'].includes(c.status)) throw new Error('Dossier déjà terminé');
  if (actions(caseId).some((a) => a.id === 'cancel')) return act(caseId, { action: 'cancel' });
  timeline(caseId, 'Dossier annulé à la demande du client : apports à restituer');
  log(caseId, 'api', 'mutation cancelCapitalDepositCase (apports déjà versés : restitution par le partenaire)');
  await cancelCase(caseId, 'CapitalDepositWithdrawn');
  return view(caseId);
}

// ---------- Tableau de bord des refus de documents ----------
// Source : cd_doc_refusals (un refus = une version refusée d'un document), sur une période glissante.
// Taux de refus = refus / versions soumises (versions = refus + version en cours si elle a été déposée).
const SOURCE = { 'Analyste KYC Swan': 'partner', Formaliste: 'formaliste', Notaire: 'notary' };
// Piste d'action par motif : ce qui éviterait le refus en amont
const PREVENT = {
  InvalidAddress: 'Préremplir l’adresse déclarée et bloquer l’envoi si l’adresse lue sur le justificatif diffère.',
  ExpiredDocument: 'Demander la date du document au dépôt et refuser automatiquement au-delà de 3 mois.',
  UnacceptableDocument: 'Lister les justificatifs acceptés avec des exemples, et signaler un relevé bancaire avant l’envoi.',
  BadDocumentQuality: 'Contrôle de netteté à la prise de photo (4 coins, couleur) sur mobile.',
  CompanyNameMismatch: 'Générer les documents à partir de la saisie unique (déjà le cas pour les statuts générés).',
  MissingSignature: 'Signature électronique intégrée plutôt qu’un document signé à la main.',
  DeclaredAmountMismatch: 'Rappeler capital et répartition exacts au moment du dépôt des statuts.',
  InvalidOrMissingData: 'Vérifier que le nom complet est lisible avant l’envoi.',
};
// Jours ouvrés écoulés entre deux dates, en décimal (week-ends exclus)
const bdBetween = (a, b) => { let ms = 0; for (let d = new Date(a); d < b;) { const e = new Date(Math.min(+b, new Date(d).setUTCHours(24, 0, 0, 0))); if (d.getUTCDay() % 6) ms += e - d; d = e; } return ms / 864e5; };
// Revue du dossier par Swan (PendingInternalReview) : de l'entrée en revue à la décision (notaire, complément ou annulation).
// status_log ne garde que le dernier passage par chaque statut : on mesure la dernière revue de chaque dossier.
function reviewDelays(since) {
  const OUT = ['WaitingForNotaryShareDepositCertificate', 'WaitingForAdditionalInformation', 'Canceled'], t = now(), done = [], open = [];
  for (const c of all("SELECT status, status_log FROM cd_cases WHERE status_log LIKE '%PendingInternalReview%'")) {
    const L = JSON.parse(c.status_log || '{}'), start = parseTs(L.PendingInternalReview);
    if (!start || start.toISOString() < since.replace(' ', 'T')) continue;
    if (c.status === 'PendingInternalReview') { open.push(bdBetween(start, t)); continue; }
    const end = OUT.map((k) => parseTs(L[k])).filter((d) => d && d >= start).sort((a, b) => a - b)[0];
    if (end) done.push(bdBetween(start, end));
  }
  const avg = done.length ? done.reduce((a, x) => a + x, 0) / done.length : null;
  return { avg, done: done.length, over: done.filter((x) => x > SLA.review).length, open: open.length, openLate: open.filter((x) => x > SLA.review).length, sla: SLA.review };
}

export function refusalDashboard({ days = 90, source = 'all' } = {}) {
  const since = new Date(now().getTime() - Number(days) * 864e5).toISOString().replace('T', ' ').slice(0, 19);
  const rows = all(`SELECT r.*, d.type, d.status AS doc_status, d.refusals AS doc_refusals, c.ref, c.company_name, c.id AS cid, s.name AS sh_name
    FROM cd_doc_refusals r JOIN cd_documents d ON d.id=r.document_id JOIN cd_cases c ON c.id=r.case_id LEFT JOIN cd_shareholders s ON s.id=d.shareholder_id
    WHERE r.created_at >= ? ORDER BY r.id DESC`, since).map((r) => ({ ...r, source: SOURCE[r.refused_by] || 'partner' }))
    .filter((r) => source === 'all' || r.source === source);
  // Versions soumises sur la période : documents des dossiers actifs sur la période (hors pièces du notaire)
  const D = all(`SELECT d.* FROM cd_documents d JOIN cd_cases c ON c.id=d.case_id WHERE c.created_at >= ? OR d.status_since >= ?`, since, since.replace(' ', 'T'))
    .filter((d) => !DOC_TYPES[d.type].notary);
  const submitted = (d) => (d.refusals || 0) + (['Uploaded', 'Validated'].includes(d.status) ? 1 : 0);
  const count = (xs, k) => xs.reduce((m, x) => ((m[x[k]] = (m[x[k]] || 0) + 1), m), {});
  const byTypeN = count(rows, 'type'), byReasonN = count(rows, 'reason_code');
  const subByType = D.reduce((m, d) => ((m[d.type] = (m[d.type] || 0) + submitted(d)), m), {});
  const totalSubmitted = D.reduce((a, d) => a + submitted(d), 0);
  const decided = D.filter((d) => d.status === 'Validated');
  const label = (t) => DOC_TYPES[t]?.label || t;
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);
  const byType = top(byTypeN).map(([type, n]) => ({ type, label: label(type), refusals: n, submitted: subByType[type] || n, rate: n / Math.max(subByType[type] || n, 1),
    reasons: top(count(rows.filter((r) => r.type === type), 'reason_code')).map(([code, k]) => ({ code, title: explain(code).title, n: k })) }));
  const byReason = top(byReasonN).map(([code, n]) => ({ code, title: explain(code).title, n, share: n / rows.length, prevent: PREVENT[code] || null,
    types: top(count(rows.filter((r) => r.reason_code === code), 'type')).map(([type, k]) => ({ type, label: label(type), n: k })) }));
  return {
    days: Number(days), source, now: now().toISOString(),
    kpis: { refusals: rows.length, submitted: totalSubmitted, rate: totalSubmitted ? rows.length / totalSubmitted : 0,
      firstTime: decided.length ? decided.filter((d) => !d.refusals).length / decided.length : null, decided: decided.length,
      cases: new Set(rows.map((r) => r.cid)).size, casesTotal: new Set(D.map((d) => d.case_id)).size,
      repeat: new Set(rows.filter((r) => r.doc_refusals >= 2).map((r) => r.document_id)).size, review: reviewDelays(since) },
    bySource: count(rows, 'source'),
    byType, byReason,
    matrix: { types: byType.map((t) => ({ type: t.type, label: t.label })), reasons: byReason.map((r) => ({ code: r.code, title: r.title })),
      cells: rows.reduce((m, r) => { const k = `${r.type}|${r.reason_code}`; m[k] = (m[k] || 0) + 1; return m; }, {}) },
    recent: rows.slice(0, 25).map((r) => ({ id: r.id, caseId: r.cid, ref: r.ref, company: r.company_name, label: label(r.type), owner: r.sh_name || r.company_name,
      reason: explain(r.reason_code).title, code: r.reason_code, by: r.refused_by, source: r.source, comment: r.reason, created_at: r.created_at })),
  };
}

// Démo : antidate tout l'historique d'un dossier de N jours (statuts, documents, journal, messages) pour simuler un dossier ancien
export function backdate(caseId, days) {
  guard();
  const c = caseRow(caseId), n = Math.max(0, Math.round(Number(days) || 0));
  if (!n) return view(caseId);
  const iso = (v) => (v ? new Date(parseTs(v).getTime() - n * 864e5).toISOString() : v);
  const log_ = Object.fromEntries(Object.entries(JSON.parse(c.status_log || '{}')).map(([k, v]) => [k, iso(v)]));
  run('UPDATE cd_cases SET status_since=?, status_log=?, certificate_at=?, completed_at=?, created_at=datetime(created_at, ?) WHERE id=?',
    iso(c.status_since), JSON.stringify(log_), iso(c.certificate_at), iso(c.completed_at), `-${n} days`, caseId);
  for (const s of shs(caseId)) run('UPDATE cd_shareholders SET status_since=?, signed_at=? WHERE id=?', iso(s.status_since), iso(s.signed_at), s.id);
  for (const d of docs(caseId)) run('UPDATE cd_documents SET status_since=? WHERE id=?', iso(d.status_since), d.id);
  for (const t of ['cd_timeline', 'cd_log', 'cd_messages', 'cd_doc_refusals', 'cd_events', 'cd_transactions']) run(`UPDATE ${t} SET created_at=datetime(created_at, ?) WHERE case_id=?`, `-${n} days`, caseId);
  return view(caseId);
}

// Suppression définitive d'un dossier de la maquette (mode test uniquement)
export function remove(caseId) {
  guard();
  const c = caseRow(caseId);
  for (const t of ['cd_documents', 'cd_shareholders', 'cd_transactions', 'cd_doc_refusals', 'cd_events', 'cd_log', 'cd_timeline', 'cd_messages', 'cd_alerts', 'sm_inbox', 'cd_thread_msgs', 'cd_threads']) run(`DELETE FROM ${t} WHERE case_id=?`, caseId);
  run('DELETE FROM cd_cases WHERE id=?', caseId);
  return { ok: true, removed: c.ref };
}

// Démo : remise à zéro. Les emails (partenaire, conversations, messages envoyés) ou bien tous les dossiers avec tout ce qui s'y rattache.
const MAIL_TABLES = ['sm_inbox', 'cd_thread_msgs', 'cd_threads', 'cd_messages'];
const count = (t) => get(`SELECT COUNT(*) n FROM ${t}`).n;
export function clearMails() {
  guard();
  const n = count('sm_inbox') + count('cd_threads') + count('cd_messages');
  for (const t of MAIL_TABLES) run(`DELETE FROM ${t}`);
  return { ok: true, removed: n };
}
export function clearCases() {
  guard();
  const n = count('cd_cases');
  for (const t of [...MAIL_TABLES, 'cd_documents', 'cd_shareholders', 'cd_transactions', 'cd_doc_refusals', 'cd_events', 'cd_state', 'cd_log', 'cd_timeline', 'cd_alerts', 'cd_cases']) run(`DELETE FROM ${t}`);
  run("DELETE FROM counters WHERE key LIKE 'DC-%'");      // les références repartent à DC-AAAA-0001
  return { ok: true, removed: n };
}

async function cancelCase(caseId, reason, note = null) {
  for (const s of shs(caseId)) if (s.status !== 'CapitalDepositCanceled') await setShareholder(caseId, s, 'CapitalDepositCanceled');
  if (!reason) timeline(caseId, `Dossier annulé : ${note}`);
  await setCase(caseId, 'Canceled', { cancel_reason: reason, cancel_note: note });
}

// ---------- Vue ----------
// Parcours client (marque blanche), calculé à partir des statuts du partenaire
function journey(c, S, D) {
  const initial = D.filter((d) => INITIAL_DOCS.includes(d.type)), sd = (t) => D.filter((d) => d.type === t);
  const docsOk = initial.every((d) => d.status !== 'Pending' && d.status !== 'Refused') && sd('ProofOfIndividualAddress').every((d) => !['Pending', 'Refused'].includes(d.status));
  const idOk = S.every((s) => !['PendingOnboarding', 'WaitingForVerification'].includes(s.status));
  const paid = S.every((s) => ['CapitalTransferred', 'CapitalFundsWiredToNotary'].includes(s.status));
  const order = ['WaitingForInitialRequirements', 'PendingInternalReview', 'WaitingForNotaryShareDepositCertificate', 'WaitingForRegisterExtract', 'WaitingForNotaryTransfer', 'Completed'];
  const st = c.status === 'WaitingForAdditionalInformation' ? 'PendingInternalReview' : c.status, k = order.indexOf(st);
  const after = (s) => k > order.indexOf(s);
  const steps = [
    { key: 'docs', title: 'Documents de la société', desc: 'Préparés par nous : statuts et mandat à signer par chaque associé', done: docsOk || k > 0 },
    { key: 'kyc', title: 'Identité des associés', desc: 'Vérification d’identité et justificatif de domicile', done: idOk || k > 0 },
    { key: 'pay', title: 'Versement des apports', desc: 'Chaque associé vire son apport sur son compte de dépôt', done: paid || k > 0 },
    { key: 'review', title: 'Vérification du dossier', desc: c.status === 'WaitingForAdditionalInformation' ? 'Un complément est demandé' : 'Contrôle de l’ensemble du dossier', done: after('PendingInternalReview') },
    { key: 'cert', title: 'Attestation de dépôt', desc: 'Délivrée par le notaire sous 2 jours ouvrés', done: after('WaitingForNotaryShareDepositCertificate'), goal: true },
    { key: 'kbis', title: 'Immatriculation et Kbis', desc: 'Immatriculez la société puis déposez le Kbis', done: after('WaitingForRegisterExtract') },
    { key: 'release', title: 'Capital libéré', desc: 'Viré sur votre compte pro sous 3 jours ouvrés', done: c.status === 'Completed' },
  ];
  const cur = c.status === 'Canceled' ? -1 : steps.findIndex((s) => !s.done);
  return steps.map((s, i) => ({ ...s, state: s.done ? 'done' : i === cur ? 'current' : 'todo' }));
}

// ---------- Plan : prochaine action de chacun, qui doit agir, délais et dates estimées ----------
// who : 'team' = notre équipe (côté client : jamais le partenaire), 'notary' = notaire ; les actions client sont dans todos (par associé)
// Pièces fournies par le client, en analyse chez Swan (le formaliste les a déjà contrôlées en amont ; les documents générés sont cohérents par construction)
const reviewable = (d) => d.status === 'Uploaded' && !DOC_TYPES[d.type].kyc && !DOC_TYPES[d.type].notary && !isGen(d) && d.type !== 'RegisterExtract';
function plan(c, S, D) {
  const T = now(), cs = parseTs(c.status_since || c.created_at), H = JSON.parse(c.status_log || '{}');
  const since = (x) => parseTs(x.status_since || c.created_at);
  const adm = S.find((s) => s.is_admin) || S[0];
  const todos = Object.fromEntries(S.map((s) => [s.id, []])), waiting = [];
  const W = (o) => { const due = addBD(o.since, o.sla); waiting.push({ ...o, since: o.since.toISOString(), due: due.toISOString(), late: T > due, sla: o.sla }); };
  const shName = (id) => S.find((s) => s.id === id)?.name;
  const active = !['Completed', 'Canceled'].includes(c.status);
  const collecting = ['WaitingForInitialRequirements', 'WaitingForAdditionalInformation'].includes(c.status);

  if (active) {
    for (const s of S) {
      const idDoc = D.find((d) => d.shareholder_id === s.id && d.type === 'ProofOfIdentity');
      if (s.status === 'PendingOnboarding' || (s.status === 'WaitingForVerification' && idDoc?.status === 'Refused'))
        todos[s.id].push({ kind: 'kyc', act: `kyc:${s.id}`, urgent: idDoc?.status === 'Refused', duration: '5 min', since: since(s).toISOString(),
          title: idDoc?.status === 'Refused' ? 'Refaire votre vérification d’identité' : 'Vérifier votre identité',
          why: idDoc?.status === 'Refused' ? explain(idDoc.reason_code).fix : 'Pièce d’identité et selfie, depuis votre téléphone. Débloque votre compte de dépôt (IBAN).' });
      else if (s.status === 'WaitingForVerification') W({ who: 'team', partner: true, title: `Vérification de l’identité de ${s.name}`, shId: s.id, since: since(s), sla: SLA.kycCheck });
      const unsigned = D.filter((d) => isSign(d) && d.status === 'Pending');
      if (unsigned.length && !s.signed_at && collecting)
        todos[s.id].push({ kind: 'sign', act: `sign:${s.id}`, duration: '3 min', since: (parseTs(unsigned[0].status_since) || since(s)).toISOString(), docs: unsigned.map((d) => ({ id: d.id, label: DOC_TYPES[d.type].label })),
          title: `Relire et signer ${unsigned.map((d) => (d.type === 'ArticlesOfIncorporation' ? 'les statuts' : 'le mandat de dépôt')).join(' et ')}`, why: 'Préparés par nos soins à partir des informations du dossier : rien à rédiger. Chaque associé signe électroniquement.' });
      if (s.status === 'WaitingForTransfer' && collecting)
        todos[s.id].push({ kind: 'transfer', act: `transfer:${s.id}`, urgent: s.attempts > 0, duration: '2 min', since: since(s).toISOString(), iban: s.iban, amount_cents: s.amount_cents, refusals: s.attempts,
          title: `Virer votre apport de ${eur(s.amount_cents)}`, why: 'Virement SEPA depuis un compte bancaire à votre nom, du montant exact. Le virement instantané évite un jour d’attente.' });
    }
    for (const d of D) {
      const t = DOC_TYPES[d.type];
      if (t.kyc || t.notary) continue;
      const owner = d.shareholder_id || adm.id;
      if (isGen(d)) {
        if (d.status === 'Refused') W({ who: 'team', title: `Nouvelle version de « ${t.label} »`, docId: d.id, since: since(d), sla: SLA.docCheck, internal: 'À corriger et régénérer' });
        continue;
      }
      if (canUpload(c, d))
        todos[owner].push({ kind: 'doc', docId: d.id, urgent: d.status === 'Refused', duration: d.type === 'RegisterExtract' ? '2 min' : '3 min', since: since(d).toISOString(),
          title: d.status === 'Refused' ? `Remplacer : ${t.label}` : d.type === 'RegisterExtract' ? 'Déposer l’extrait Kbis' : `Déposer : ${t.label}`,
          why: d.status === 'Refused' ? `${explain(d.reason_code).title}. ${d.client_note ? d.client_note.replace(/\n/g, ' ') : explain(d.reason_code).fix}`
            : d.type === 'ArticlesOfIncorporation' ? `Version signée par tous les associés. Elle doit mentionner : ${c.company_name} (${c.legal_form || 'SAS'}), siège ${c.address}, capital de ${eur(c.total_cents)} réparti entre ${S.map((x) => `${x.name} (${eur(x.amount_cents)})`).join(', ')}, fonds déposés auprès de ${DEPOSIT_BANK.name}, ${DEPOSIT_BANK.address}.`
            : d.type === 'RegisterExtract' ? 'Le notaire le contrôle puis vire le capital sur votre compte pro.' : (RULES[t.rule]?.checks || []).slice(0, 2).join(' · ') });
      else if (sensitiveRefusal(d)) W({ who: 'team', title: `Refus pour conformité : ${t.label}${d.shareholder_id ? ` (${shName(d.shareholder_id)})` : ''}`, docId: d.id, since: since(d), sla: SLA.docCheck, internal: 'Motif à ne pas communiquer : voir avec le partenaire, puis rappeler le client' });
      else if (reviewable(d) && collecting) W({ who: 'team', partner: true, title: `Vérification : ${t.label}${d.shareholder_id ? ` (${shName(d.shareholder_id)})` : ''}`, docId: d.id, since: since(d), sla: SLA.docCheck });
    }
    if (c.status === 'WaitingForAdditionalInformation' && c.info_source === 'email') {
      if (c.info_relayed) todos[adm.id].push({ kind: 'answer', act: 'answer', urgent: true, since: cs.toISOString(), title: 'Envoyer le complément demandé', why: c.info_request });
      else W({ who: 'team', internal: 'Email du partenaire à reformuler puis valider (Mailing)', title: 'Vérification complète du dossier', since: cs, sla: SLA.review });
    }
    if (c.status === 'PendingInternalReview') W({ who: 'team', partner: true, title: 'Vérification complète du dossier', since: cs, sla: SLA.review });
    if (c.status === 'WaitingForNotaryShareDepositCertificate') W({ who: 'notary', title: 'Délivrance de l’attestation de dépôt des fonds', since: cs, sla: SLA.certificate });
    if (c.status === 'WaitingForRegisterExtract' && D.find((d) => d.type === 'RegisterExtract')?.status === 'Pending')
      todos[adm.id].unshift({ kind: 'register', href: `/api/capital/${c.id}/certificate.pdf`, duration: '30 min', since: cs.toISOString(), title: 'Immatriculer la société',
        why: 'Sur le guichet unique (formalites.entreprises.gouv.fr), en joignant l’attestation de dépôt des fonds. Le greffe vous envoie ensuite l’extrait Kbis, à déposer ici.' });
    if (c.status === 'WaitingForNotaryTransfer') W({ who: 'notary', title: 'Contrôle du Kbis et virement du capital', since: cs, sla: SLA.release });
    for (const k in todos) todos[k].sort((a, b) => !!b.urgent - !!a.urgent);   // une action à corriger passe toujours en premier
  }

  // Dates estimées : chaque action client en attente est supposée faite aujourd'hui, nos délais et ceux des tiers sont ceux de SLA
  const eta = (from, n) => { const d = addBD(from, n); return d < T ? T : d; };
  let ready = T;
  for (const s of S) {
    if (s.status === 'PendingOnboarding') ready = maxD(ready, addBD(T, SLA.kycCheck + SLA.transfer));
    else if (s.status === 'WaitingForVerification') ready = maxD(ready, addBD(eta(since(s), SLA.kycCheck), SLA.transfer));
    else if (s.status === 'WaitingForTransfer') ready = maxD(ready, addBD(T, SLA.transfer));
  }
  for (const d of D) if (!DOC_TYPES[d.type].kyc && !DOC_TYPES[d.type].notary && d.type !== 'RegisterExtract') {
    if (isGen(d)) { if (d.status === 'Refused') ready = maxD(ready, eta(since(d), SLA.docCheck)); continue; }   // à signer : fait aujourd'hui, sans délai
    if (['Pending', 'Refused'].includes(d.status)) ready = maxD(ready, addBD(T, SLA.docCheck));
    else if (d.status === 'Uploaded' && collecting) ready = maxD(ready, eta(since(d), SLA.docCheck));
  }
  const st = c.status, E = {};
  if (st === 'WaitingForInitialRequirements') E.review = addBD(ready, SLA.review);
  else if (st === 'WaitingForAdditionalInformation') E.review = addBD(maxD(ready, T), SLA.review);
  else if (st === 'PendingInternalReview') E.review = eta(cs, SLA.review);
  else if (H.WaitingForNotaryShareDepositCertificate) E.review = parseTs(H.WaitingForNotaryShareDepositCertificate);
  if (c.certificate_at) E.certificate = parseTs(c.certificate_at);
  else if (st === 'WaitingForNotaryShareDepositCertificate') E.certificate = eta(cs, SLA.certificate);
  else if (E.review) E.certificate = addBD(E.review, SLA.certificate);
  if (H.WaitingForNotaryTransfer && st !== 'WaitingForRegisterExtract') E.kbis = parseTs(H.WaitingForNotaryTransfer);
  else if (st === 'WaitingForRegisterExtract') E.kbis = eta(cs, SLA.registration);
  else if (E.certificate) E.kbis = addBD(E.certificate, SLA.registration);
  if (c.completed_at) E.release = parseTs(c.completed_at);
  else if (st === 'WaitingForNotaryTransfer') E.release = eta(cs, SLA.release);
  else if (E.kbis) E.release = addBD(E.kbis, SLA.release);
  const iso = (d) => (d ? d.toISOString() : null);
  const done = { certificate: !!c.certificate_at, release: st === 'Completed', review: !!H.WaitingForNotaryShareDepositCertificate, kbis: ['WaitingForNotaryTransfer', 'Completed'].includes(st) };
  return {
    now: T.toISOString(), sla: SLA, todos, waiting, collectingReady: iso(ready),
    estimates: st === 'Canceled' ? {} : Object.fromEntries(['review', 'certificate', 'kbis', 'release'].map((k) => [k, { date: iso(E[k]), done: done[k] }])),
    stepDates: { docs: H.PendingInternalReview || null, kyc: H.PendingInternalReview || null, pay: H.PendingInternalReview || null,
      review: H.WaitingForNotaryShareDepositCertificate || null, cert: c.certificate_at || null, kbis: H.WaitingForNotaryTransfer || null, release: c.completed_at || null },
    stepEta: { docs: iso(ready), kyc: iso(ready), pay: iso(ready), review: iso(E.review), cert: iso(E.certificate), kbis: iso(E.kbis), release: iso(E.release) },
  };
}

// File de travail du formaliste : un résumé par dossier, du plus urgent au moins urgent
export function queue() {
  return all('SELECT * FROM cd_cases ORDER BY id DESC').map((c) => {
    const S = shs(c.id), D = docs(c.id), p = plan(c, S, D);
    const toReview = D.filter((d) => reviewable(d) && ['WaitingForInitialRequirements', 'WaitingForAdditionalInformation'].includes(c.status));
    const clientTodos = S.flatMap((s) => p.todos[s.id].map((t) => ({ who: s.name, title: t.title, since: t.since })));
    const mails = partnerMail.pending(c.id).length;
    const oldest = (xs) => xs.map((x) => x.since).sort()[0] || null;
    const toFix = D.filter((d) => isGen(d) && d.status === 'Refused').length;
    const alerts = all('SELECT akey, level FROM cd_alerts WHERE case_id=? AND resolved_at IS NULL AND acked_at IS NULL', c.id);
    const toAnswer = get("SELECT COUNT(*) n FROM cd_threads WHERE case_id=? AND status!='closed' AND waiting_on='nous'", c.id).n;   // échanges avec Swan qui attendent notre réponse
    const owner = mails || toFix || toAnswer ? 'agent' : p.waiting.some((w) => w.who === 'team') ? 'partner' : p.waiting.some((w) => w.who === 'notary') ? 'notary' : clientTodos.length ? 'client' : 'none';
    return { id: c.id, ref: c.ref, company_name: c.company_name, status: c.status, label: CASE_LABEL[c.status], status_since: c.status_since || c.created_at,
      toAnswer, alerts: new Set(alerts.map((a) => a.akey)).size,   // une attente en retard = une alerte, même relancée puis escaladée
      escalated: alerts.some((a) => a.level === 'escalade'), toReview: toReview.length, toFix, toReviewSince: oldest(toReview.map((d) => ({ since: d.status_since || c.created_at }))), partnerEmails: mails,
      late: p.waiting.filter((w) => w.late).map((w) => w.title), clientTodos, waiting: p.waiting, owner,
      certificate: p.estimates.certificate || null, release: p.estimates.release || null,
      step: c.status === 'Completed' ? 7 : journey(c, S, D).findIndex((x) => x.state === 'current') + 1 };   // étape du parcours client (1 à 7, 0 si annulé)
  });
}

// ---------- Alertes de délai dépassé côté partenaire bancaire ----------
// Chaque attente « partenaire » (vérification d'identité, revue du dossier) a un délai (SLA). Une fois dépassé :
//  1. relance : alerte ouverte + email à l'équipe opérations avec le message prêt à envoyer au support du partenaire ;
//  2. escalade : après ESCALATE_AFTER jours ouvrés de retard, alerte de niveau supérieur, à adresser au responsable de compte.
// Idempotent (une alerte par niveau), résolue automatiquement quand le partenaire a agi. Le client voit seulement « nous relançons ».
const bdLate = (due, T) => { let n = 0; const x = new Date(due); while (x < T) { x.setDate(x.getDate() + 1); if (x.getDay() % 6 && x <= T) n++; } return n; };
const alertKey = (c, w) => (w.shId ? `kyc:${w.shId}` : w.docId ? `doc:${w.docId}` : `review:${c.id}`);
const partnerMessage = (c, w, level, late) => `Bonjour,\n\nConcernant le dossier de dépôt de capital ${c.swan_id} (${c.company_name}) :\n« ${w.title} » est en attente depuis le ${new Date(w.since).toLocaleDateString('fr-FR')}, pour un délai convenu de ${w.sla} jour(s) ouvré(s) (échéance le ${new Date(w.due).toLocaleDateString('fr-FR')}, ${late} jour(s) ouvré(s) de retard).\n\n${level === 'escalade' ? 'Malgré une première relance, le dossier n’a pas avancé. Pouvez-vous le prioriser et nous indiquer une date de traitement ?' : 'Pouvez-vous nous indiquer quand il sera traité ?'}\n\nMerci,\nL’équipe opérations ${BRAND}`;

export async function checkAlerts() {
  const T = now(), opened = [];
  for (const c of all("SELECT * FROM cd_cases WHERE status NOT IN ('Completed','Canceled')")) {
    const p = plan(c, shs(c.id), docs(c.id)), lateKeys = new Set();
    for (const w of p.waiting.filter((x) => x.partner && x.late)) {
      const key = alertKey(c, w), late = bdLate(w.due, T);
      lateKeys.add(key);
      for (const level of late >= ESCALATE_AFTER ? ['relance', 'escalade'] : ['relance']) {
        const ex = get('SELECT * FROM cd_alerts WHERE case_id=? AND akey=? AND level=?', c.id, key, level);
        if (ex && !ex.resolved_at) continue;                // déjà ouverte : pas de nouvelle notification
        if (ex) run('UPDATE cd_alerts SET resolved_at=NULL, relaunched_at=NULL, acked_at=NULL, opened_at=?, title=?, due=?, late_days=? WHERE id=?', nowIso(), w.title, w.due, late, ex.id);   // retard revenu : on rouvre
        else run('INSERT INTO cd_alerts(case_id,akey,level,title,due,late_days,opened_at) VALUES(?,?,?,?,?,?,?)', c.id, key, level, w.title, w.due, late, nowIso());
        const to = level === 'escalade' ? PARTNER.manager : PARTNER.support;
        log(c.id, 'rule', `Alerte délai partenaire (${level}) : ${w.title}, ${late} j ouvré(s) de retard`);
        await deliver(c.id, null, { rule: 'alerte-partenaire', to: SUPPORT, subject: `[${c.ref}] ${level === 'escalade' ? 'ESCALADE' : 'Relance'} partenaire : ${w.title}`,
          body: `Dossier ${c.ref} · ${c.company_name} (réf. partenaire ${c.swan_id})\nAttente : ${w.title}\nÉchéance : ${new Date(w.due).toLocaleDateString('fr-FR')} (SLA ${w.sla} j ouvré(s)) · retard : ${late} j ouvré(s)\n\nÀ envoyer à ${to.name} <${to.email}> depuis la console formaliste :\n\n${partnerMessage(c, w, level, late)}` });
        opened.push({ caseId: c.id, key, level });
      }
      run('UPDATE cd_alerts SET late_days=? WHERE case_id=? AND akey=? AND resolved_at IS NULL', late, c.id, key);
    }
    for (const a of all('SELECT * FROM cd_alerts WHERE case_id=? AND resolved_at IS NULL', c.id))
      if (!lateKeys.has(a.akey)) { run('UPDATE cd_alerts SET resolved_at=? WHERE id=?', nowIso(), a.id); log(c.id, 'rule', `Alerte délai partenaire résolue (${a.level}) : ${a.title}`); }
  }
  for (const a of all("SELECT a.id FROM cd_alerts a JOIN cd_cases c ON c.id=a.case_id WHERE a.resolved_at IS NULL AND c.status IN ('Completed','Canceled')")) run('UPDATE cd_alerts SET resolved_at=? WHERE id=?', nowIso(), a.id);
  return opened;
}

// Depuis la console : envoyer la relance au partenaire (support ou responsable de compte selon le niveau), ou acquitter
export async function alertAction(alertId, action) {
  const a = get('SELECT * FROM cd_alerts WHERE id=?', alertId);
  if (!a) throw new Error('Alerte introuvable');
  const c = caseRow(a.case_id);
  if (action === 'ack') { run('UPDATE cd_alerts SET acked_at=? WHERE id=?', nowIso(), a.id); log(c.id, 'rule', `Alerte acquittée (${a.level}) : ${a.title}`); return view(c.id); }
  if (action !== 'relaunch') throw new Error('Action inconnue');
  const w = plan(c, shs(c.id), docs(c.id)).waiting.find((x) => x.partner && alertKey(c, x) === a.akey);
  if (!w) throw new Error('Le partenaire a déjà traité ce point');
  const to = a.level === 'escalade' ? PARTNER.manager : PARTNER.support, late = bdLate(w.due, now());
  const r = await sendMail({ to: to.email, subject: `Dossier de dépôt de capital ${c.swan_id} : délai dépassé${a.level === 'escalade' ? ' (escalade)' : ''}`, text: partnerMessage(c, w, a.level, late), from: SUPPORT.email, kind: 'dépôt de capital' });
  run('INSERT INTO cd_messages(case_id,event_id,rule,to_role,to_name,to_email,subject,body,mode) VALUES(?,?,?,?,?,?,?,?,?)', c.id, null, 'relance-partenaire', to.role, to.name, to.email, `Délai dépassé : ${w.title}`, partnerMessage(c, w, a.level, late), r.mode);
  run('UPDATE cd_alerts SET relaunched_at=? WHERE id=?', nowIso(), a.id);
  log(c.id, 'zendesk', `${a.level === 'escalade' ? 'Escalade envoyée au responsable de compte' : 'Relance envoyée au support'} du partenaire : ${w.title}`, partnerMessage(c, w, a.level, late));
  return view(c.id);
}

export function view(id) {
  const c = id ? get('SELECT * FROM cd_cases WHERE id=?', id) : get('SELECT * FROM cd_cases ORDER BY id DESC');
  if (!c) return { case: null };
  const S = shs(c.id), D = docs(c.id);
  const ownerName = (d) => (d.shareholder_id ? S.find((s) => s.id === d.shareholder_id)?.name : c.company_name);
  const p = plan(c, S, D);
  return {
    articlesControl: c.articles_source === 'client' ? { company_name: c.company_name, legal_form: c.legal_form, address: c.address, total_cents: c.total_cents, bank: DEPOSIT_BANK,
      min_release: MIN_RELEASE[c.legal_form] ?? 0.5, president: S.find((s) => s.is_admin)?.name, shareholders: S.map((s) => ({ name: s.name, amount_cents: s.amount_cents, address: s.address })) } : null,
    plan: p, clock: clock.get(), escalateAfter: ESCALATE_AFTER, partnerContacts: PARTNER,
    alerts: all('SELECT * FROM cd_alerts WHERE case_id=? ORDER BY resolved_at IS NOT NULL, id DESC', c.id),
    reasonDetails: Object.fromEntries(Object.entries(REASONS).map(([k, [title, fix]]) => [k, { title, fix }])),
    case: { ...c, label: CASE_LABEL[c.status], cancel_label: CANCEL_REASONS[c.cancel_reason]?.label || null, cancel_sensitive: !!CANCEL_REASONS[c.cancel_reason]?.sensitive },
    shareholders: S.map((s) => ({ ...s, label: SH_LABEL[s.status] })),
    documents: D.map((d) => ({ ...d, label: DOC_TYPES[d.type].label, owner: ownerName(d), kyc: !!DOC_TYPES[d.type].kyc, notary: !!DOC_TYPES[d.type].notary,
      generated: !!isGen(d), sign: !!isSign(d), preview: isGen(d) ? `/api/capital/${c.id}/docs/${d.id}/preview.pdf` : null,
      status_label: DOC_LABEL[d.status], rule: RULES[DOC_TYPES[d.type].rule] || null, uploadable: canUpload(c, d),
      explanation: d.status === 'Refused' ? { ...explain(d.reason_code), note: d.client_note || null } : null,
      analyst_comment: d.status === 'Refused' ? d.reason : null })),
    docRefusals: all('SELECT r.*, d.type FROM cd_doc_refusals r JOIN cd_documents d ON d.id=r.document_id WHERE r.case_id=? ORDER BY r.id DESC', c.id).map((r) => {
      const d = D.find((x) => x.id === r.document_id);
      return { ...r, label: DOC_TYPES[r.type].label, owner: ownerName(d), code_title: explain(r.reason_code).title, partner_mentioned: mentionsPartner(r.reason), current: d.status === 'Refused' && r.id === Math.max(...all('SELECT id FROM cd_doc_refusals WHERE document_id=?', d.id).map((x) => x.id)) };
    }),
    funded: S.filter((s) => ['CapitalTransferred', 'CapitalFundsWiredToNotary'].includes(s.status)).reduce((a, s) => a + s.amount_cents, 0),
    steps: journey(c, S, D).map((st) => ({ ...st, done_at: p.stepDates[st.key], eta: p.stepEta[st.key] })),
    actions: actions(c.id),
    reasons: Object.fromEntries(Object.entries(REASONS).map(([k, v]) => [k, v[0]])),
    cancelReasons: Object.fromEntries(Object.entries(CANCEL_REASONS).map(([k, v]) => [k, v.label + (v.sensitive ? ' (sensible)' : '')])),
    timeline: all('SELECT * FROM cd_timeline WHERE case_id=? ORDER BY id DESC', c.id),
    log: all('SELECT * FROM cd_log WHERE case_id=? ORDER BY id DESC LIMIT 150', c.id),
    messages: all('SELECT * FROM cd_messages WHERE case_id=? ORDER BY id DESC', c.id),
    refusals: refusalStats(),
    partnerEmails: partnerMail.pending(c.id).length,
    history: all('SELECT id, ref, company_name, status FROM cd_cases ORDER BY id DESC LIMIT 10').map((x) => ({ ...x, label: CASE_LABEL[x.status] })),
  };
}

// Aperçu des documents générés à partir de la saisie unique (spécimen)
export function generatedPdf(caseId, docId) {
  const c = caseRow(caseId), S = shs(caseId), d = get('SELECT * FROM cd_documents WHERE id=? AND case_id=?', docId, caseId);
  if (!d || !isGen(d)) throw new Error('Document introuvable');
  const doc = new PDFDocument({ margin: 56 }), chunks = [];
  doc.on('data', (b) => chunks.push(b));
  const done = new Promise((ok) => doc.on('end', () => ok(Buffer.concat(chunks))));
  const total = eur(c.total_cents), forme = c.legal_form || 'SAS';
  doc.fontSize(9).fillColor('#c8321e').text('SPÉCIMEN — DOCUMENT FICTIF GÉNÉRÉ PAR UNE MAQUETTE, SANS VALEUR LÉGALE', { align: 'center' }).fillColor('#000');
  const title = { ArticlesOfIncorporation: 'Statuts', PowerOfAttorney: 'Mandat de dépôt des fonds', CompanyLeaseAgreement: 'Contrat de domiciliation' }[d.type];
  doc.moveDown(2).fontSize(20).text(title, { align: 'center' }).moveDown(0.3).fontSize(11).fillColor('#666').text(`${c.company_name} · ${forme} au capital de ${total}`, { align: 'center' }).fillColor('#000').moveDown(1.5);
  if (d.type === 'ArticlesOfIncorporation') {
    doc.text(`Article 1 — Forme : ${forme}.`).moveDown(0.5).text(`Article 2 — Dénomination : ${c.company_name}.`).moveDown(0.5).text(`Article 3 — Siège social : ${c.address || '—'}.`).moveDown(0.5)
      .text(`Article 4 — Capital social : ${total}, divisé en actions souscrites et libérées en numéraire comme suit :`);
    for (const s of S) doc.text(`   • ${s.name}, demeurant ${s.address || '—'} : ${eur(s.amount_cents)}`);
  } else if (d.type === 'PowerOfAttorney') {
    doc.text(`Les soussignés, associés de la société en formation ${c.company_name}, donnent mandat pour le dépôt des fonds composant le capital social de ${total}, réparti ainsi :`).moveDown(0.5);
    for (const s of S) doc.text(`   • ${s.name} : ${eur(s.amount_cents)}`);
  } else doc.text(`Nova Pro Domiciliation met à disposition de ${c.company_name} (${forme}, en formation), représentée par ${S.find((s) => s.is_admin)?.name}, l’adresse suivante à titre de siège social : ${c.address || '—'}.`);
  doc.moveDown(2).text('Signatures :');
  for (const s of (isSign(d) ? S : S.filter((x) => x.is_admin))) doc.text(`   ${s.name} — ${isSign(d) ? (s.signed_at ? `signé électroniquement le ${new Date(s.signed_at).toLocaleDateString('fr-FR')}` : 'en attente de signature') : 'signé à la souscription'}`);
  doc.end();
  return done;
}

// Attestation fictive (spécimen), aux couleurs de notre marque
export function certificate(caseId) {
  const c = caseRow(caseId), S = shs(caseId);
  if (!c.certificate_at) throw new Error('Attestation non encore délivrée');
  const doc = new PDFDocument({ margin: 56 }), chunks = [];
  doc.on('data', (b) => chunks.push(b));
  const done = new Promise((ok) => doc.on('end', () => ok(Buffer.concat(chunks))));
  doc.fontSize(9).fillColor('#c8321e').text('SPÉCIMEN — DOCUMENT FICTIF GÉNÉRÉ PAR UNE MAQUETTE, SANS VALEUR LÉGALE', { align: 'center' });
  doc.moveDown(2).fillColor('#000').fontSize(20).text('Attestation de dépôt des fonds', { align: 'center' });
  doc.moveDown(0.3).fontSize(10).fillColor('#666').text(`Dossier ${c.ref}`, { align: 'center' }).fillColor('#000');
  doc.moveDown().fontSize(11).text(`Société en formation : ${c.company_name} (${c.legal_form || 'SAS'})${c.address ? '\nSiège : ' + c.address : ''}`);
  doc.moveDown().text(`Montant total des fonds déposés : ${eur(c.total_cents)}`);
  doc.moveDown().text('Répartition par associé :');
  for (const s of S) doc.text(`  • ${s.name} : ${eur(s.amount_cents)}`);
  doc.moveDown().text(`Délivrée le ${new Date(c.certificate_at).toLocaleDateString('fr-FR')}.`);
  doc.end();
  return done;
}
