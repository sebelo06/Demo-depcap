// Crée des dossiers de démo réalistes sur l'espace dépôt de capital (mode test uniquement), en passant par l'API comme l'interface.
// Usage : npm run capital:demo   (CAPITAL_URL=http://localhost:3100 par défaut ; le serveur capital doit tourner)
const BASE = process.env.CAPITAL_URL || 'http://localhost:3100';
const api = async (p, body) => {
  const r = await fetch(`${BASE}/api/${p}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (j.error) throw new Error(`${p} : ${j.error}`);
  return j;
};

// Fait avancer le dossier par les actions « normales », sans laisser le partenaire valider les pièces une à une
// (elles restent « en analyse » jusqu'à la revue du dossier). refusals : { 'Justificatif de domicile|Léo': 'InvalidAddress', ... }
async function advance(v, until, refusals = {}) {
  const done = new Set();
  for (let i = 0; i < 80 && !until(v); i++) {
    const r = v.documents.find((d) => d.status === 'Uploaded' && Object.keys(refusals).some((k) => match(k, d) && !done.has(k)));
    if (r) {
      const k = Object.keys(refusals).find((x) => match(x, r) && !done.has(x));
      done.add(k);
      const [reasonCode, message] = [].concat(refusals[k]);
      v = await api(`capital/${v.case.id}/act`, { action: `refuse:${r.id}`, reasonCode, message });
      continue;
    }
    const next = v.actions.find((a) => a.happy && !a.id.startsWith('validate:'));
    if (!next) throw new Error(`Bloqué au statut ${v.case.status}`);
    v = await api(`capital/${v.case.id}/act`, { action: next.id });
  }
  return v;
}
const match = (key, d) => { const [label, owner] = key.split('|'); return d.label === label && (!owner || d.owner.startsWith(owner)); };
const at = (s) => (v) => v.case.status === s;

const CASES = [
  {
    note: 'documents en analyse chez le partenaire',
    input: { companyName: 'Atelier Lumen SAS', legalForm: 'SAS', address: '18 rue Oberkampf, 75011 Paris', shareholders: [
      { name: 'Sarah Benali', email: 'sarah@atelier-lumen.fr', amount: 6000, address: '5 rue de Charonne, 75011 Paris' },
      { name: 'Thomas Girard', email: 'thomas@atelier-lumen.fr', amount: 4000, address: '22 cours Lafayette, 69003 Lyon' }] },
    refusals: { 'Justificatif de domicile|Thomas': ['InvalidAddress', 'La facture est au 14 rue Garibaldi, 69006 Lyon, alors que l’adresse déclarée est 22 cours Lafayette, 69003 Lyon.'] },
    until: at('PendingInternalReview'), backdate: 1,
  },
  {
    note: 'documents en analyse chez le partenaire, délai dépassé',
    input: { companyName: 'Brasserie Okto SAS', legalForm: 'SAS', address: '7 quai de la Fosse, 44000 Nantes', shareholders: [
      { name: 'Julien Morel', email: 'julien@okto.fr', amount: 15000, address: '12 rue Crébillon, 44000 Nantes' },
      { name: 'Clara Nguyen', email: 'clara@okto.fr', amount: 10000, address: '3 allée Brancas, 44000 Nantes' },
      { name: 'Malik Diallo', email: 'malik@okto.fr', amount: 5000, address: '40 boulevard Guist’hau, 44000 Nantes' }] },
    refusals: { 'Justificatif de domicile|Clara': ['BadDocumentQuality', 'Photo floue, le nom du titulaire est illisible.'], 'Pièce d’identité|Malik': ['ExpiredDocument', 'Carte d’identité expirée depuis mars 2025.'], 'Justificatif de domicile|Malik': ['UnacceptableDocument', 'Relevé bancaire fourni : non accepté comme justificatif de domicile.'] },
    until: at('PendingInternalReview'), backdate: 6,
  },
  {
    note: 'en attente de l’attestation de dépôt du notaire',
    input: { companyName: 'Verde Mobilité SASU', legalForm: 'SASU', address: '2 place Bellecour, 69002 Lyon', shareholders: [
      { name: 'Nina Rossi', email: 'nina@verde-mobilite.fr', amount: 8000, address: '15 rue Mercière, 69002 Lyon' }] },
    refusals: { 'Justificatif de domicile|Nina': ['ExpiredDocument', 'Facture d’électricité datée de juin 2026, soit plus de 3 mois.'] },
    until: at('WaitingForNotaryShareDepositCertificate'), backdate: 1,
  },
];

for (const c of CASES) {
  let v = await api('capital', c.input);
  v = await advance(v, c.until, c.refusals);
  if (c.until === CASES[2].until && v.case.status === 'PendingInternalReview') v = await api(`capital/${v.case.id}/act`, { action: 'review-ok' });
  if (c.backdate) v = await api('test/backdate', { caseId: v.case.id, days: c.backdate });
  const alerts = v.alerts.filter((a) => !a.resolved_at).map((a) => a.level);
  console.log(`${v.case.ref} · ${v.case.company_name} · ${v.case.label} (${c.note})${alerts.length ? ` · alertes : ${alerts.join(', ')}` : ''}`);
}
