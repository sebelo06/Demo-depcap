// Règles des justificatifs Swan, consignes par motif de refus (reasonCode), contrôle de cohérence et suivi des refus.
// Sources : documentation Swan (supporting documents, proof of address, proof of company registration, identifications).
import { db, all, run } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS doc_refusals (
  id INTEGER PRIMARY KEY, source TEXT NOT NULL, label TEXT, reason_code TEXT, reason TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);

const IMAGE_CHECKS = ['Scan ou photo de qualité, en couleur, 4 coins visibles', 'Document complet (toutes les pages), sans capture d’écran'];

export const RULES = {
  identity: { title: 'Pièce d’identité', checks: ['Pièce d’identité en cours de validité', 'Recto et verso', 'Nom lisible, identique à celui du dossier', ...IMAGE_CHECKS] },
  address: { title: 'Justificatif de domicile', declared: 'address', checks: [
    'Facture d’énergie, internet ou mobile, attestation d’assurance habitation, quittance ou bail d’un bailleur professionnel : de moins de 3 mois (avis d’impôt : de moins d’un an)',
    'Émis par un fournisseur de l’Espace économique européen',
    'Nom complet et adresse visibles (un relevé bancaire n’est pas accepté)',
    'Hébergé chez un tiers : attestation d’hébergement et pièce d’identité de l’hébergeant jointes', ...IMAGE_CHECKS] },
  articles: { title: 'Statuts de la société', declared: 'company', checks: ['Statuts complets, dans leur version la plus récente (ou de moins de 6 mois)', 'Signés et datés', 'Raison sociale identique à celle du dossier', ...IMAGE_CHECKS] },
  premises: { title: 'Bail ou contrat de domiciliation', declared: 'companyAddress', checks: ['Document de moins de 3 mois', 'Adresse identique au siège déclaré dans le dossier', 'Signé et daté', ...IMAGE_CHECKS] },
  poa: { title: 'Mandat de dépôt', declared: 'company', checks: ['Mandat signé et daté par chaque associé', 'Raison sociale identique à celle du dossier', ...IMAGE_CHECKS] },
  kbis: { title: 'Extrait Kbis', declared: 'company', checks: ['Extrait de moins de 3 mois', 'Raison sociale et adresse identiques à celles du dossier', ...IMAGE_CHECKS] },
  justificatif: { title: 'Justificatif d’opération', checks: ['Document en lien avec l’opération concernée', 'Date et montant lisibles', ...IMAGE_CHECKS] },
};

export const REASONS = {
  ExpiredDocument: ['Document trop ancien', 'Fournissez un document plus récent : moins de 3 mois pour un justificatif de domicile ou un Kbis, moins de 6 mois (ou version la plus récente) pour les statuts.'],
  UnacceptableDocument: ['Type de document non conforme', 'Envoyez exactement le type de document demandé. Pour un justificatif de domicile, un relevé bancaire n’est pas accepté : préférez une facture d’énergie, d’internet ou de mobile.'],
  InvalidOrMissingData: ['Nom absent ou illisible', 'Le nom complet doit être visible et lisible. Renvoyez un scan plus net où il apparaît en entier.'],
  InvalidAddress: ['Adresse différente du dossier', 'L’adresse du document doit être celle déclarée dans le dossier. Fournissez un document à cette adresse ou, si l’adresse a changé, signalez-le à notre équipe en répondant à notre email.'],
  CompanyNameMismatch: ['Raison sociale différente du dossier', 'La raison sociale du document doit être identique à celle déclarée. Vérifiez l’orthographe et la forme juridique.'],
  DeclaredAmountMismatch: ['Montant différent de celui déclaré', 'Le montant du document doit correspondre à celui déclaré dans le dossier.'],
  InvalidDocument: ['Document invalide ou format non accepté', 'Envoyez un fichier pdf, png ou jpg valide, non protégé par mot de passe et ouvrable.'],
  BadDocumentQuality: ['Qualité insuffisante', 'Refaites un scan ou une photo nette, en couleur, avec les 4 coins visibles et toutes les pages. Pas de capture d’écran.'],
  ProviderColorIdDocumentRequired: ['Copie en couleur exigée', 'Envoyez un scan ou une photo en couleur (les copies en noir et blanc sont refusées).'],
  MissingSignature: ['Signature ou date manquante', 'Le document doit être signé et daté. Faites-le signer puis renvoyez-le.'],
  MissingAccommodationProviderId: ['Pièce d’identité de l’hébergeant manquante', 'Joignez la pièce d’identité de la personne qui vous héberge.'],
  MissingAccommodationProviderIdLetter: ['Pièce d’identité et attestation de l’hébergeant manquantes', 'Joignez l’attestation d’hébergement et la pièce d’identité de l’hébergeant.'],
  MissingAccommodationProviderLetter: ['Attestation d’hébergement manquante', 'Joignez une attestation d’hébergement signée par la personne qui vous héberge.'],
};

export const explain = (code, reason) => {
  const [title, fix] = REASONS[code] || ['Document refusé', reason || 'Vérifiez le document et renvoyez-en un conforme.'];
  return { code: code || null, title, fix, reason: reason || null };
};

const EXT = /\.(pdf|png|jpe?g)$/i, MAX = 5 * 1024 * 1024;
// Contrôles avant envoi : format, taille, cases cochées
export function precheck({ filename, size, confirmed }) {
  if (!filename || !EXT.test(filename)) throw new Error('Format non accepté : envoyez un fichier pdf, png ou jpg');
  if (size > MAX) throw new Error('Fichier trop volumineux (5 Mo maximum)');
  if (!confirmed) throw new Error('Confirmez d’abord les points de contrôle du document');
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
// Part des mots du dossier retrouvés dans le document (≥ 80 % = cohérent)
const sameText = (declared, found) => {
  const d = norm(declared).split(' ').filter((w) => w.length > 1), f = new Set(norm(found).split(' '));
  return !d.length || d.filter((w) => f.has(w)).length / d.length >= 0.8;
};
// Écarts entre ce qui est déclaré dans le dossier et ce que le client lit sur le document
export function consistency(kind, declared, seen) {
  const out = [];
  if (kind === 'address' && seen.address && !sameText(declared.address, seen.address)) out.push(`L’adresse saisie (« ${seen.address} ») diffère de celle du dossier (« ${declared.address} ») : risque de refus « Adresse différente ».`);
  if (kind === 'companyAddress' && seen.address && !sameText(declared.companyAddress, seen.address)) out.push(`L’adresse du document (« ${seen.address} ») diffère du siège déclaré (« ${declared.companyAddress} »).`);
  if (['company'].includes(kind) && seen.name && !sameText(declared.company, seen.name)) out.push(`La raison sociale saisie (« ${seen.name} ») diffère de celle du dossier (« ${declared.company} ») : risque de refus « Raison sociale différente ».`);
  return out;
}

export const recordRefusal = ({ source, label, code, reason }) =>
  run('INSERT INTO doc_refusals(source,label,reason_code,reason) VALUES(?,?,?,?)', source, label || '', code || 'Other', reason || null);

export const refusalStats = (days = 90) => {
  const rows = all(`SELECT reason_code AS code, COUNT(*) AS n, MAX(created_at) AS last FROM doc_refusals WHERE created_at >= datetime('now', ?) GROUP BY reason_code ORDER BY n DESC`, `-${days} days`);
  const total = rows.reduce((a, r) => a + r.n, 0);
  return { days, total, items: rows.map((r) => ({ ...r, ...explain(r.code), share: total ? Math.round((r.n / total) * 100) : 0 })),
    recent: all('SELECT * FROM doc_refusals ORDER BY id DESC LIMIT 10') };
};
