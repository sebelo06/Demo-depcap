// Client Swan : mode live (GraphQL) ou mock (données en mémoire)
const {
  MODE = 'mock', SWAN_CLIENT_ID, SWAN_CLIENT_SECRET,
  SWAN_API_URL = 'https://api.swan.io/sandbox-partner/graphql',
  SWAN_OAUTH_URL = 'https://oauth.swan.io/oauth2/token',
  APP_URL = 'http://localhost:3000',
} = process.env;

export const isLive = MODE === 'live';

// ---------- LIVE ----------
let token = { value: null, exp: 0 };
async function getProjectToken() {
  if (token.value && Date.now() < token.exp) return token.value;
  const res = await fetch(SWAN_OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SWAN_CLIENT_ID,
      client_secret: SWAN_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`OAuth Swan ${res.status}`);
  const j = await res.json();
  token = { value: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return token.value;
}

async function gql(query, variables) {
  const res = await fetch(SWAN_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await getProjectToken()}` },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json();
  if (j.errors) throw new Error(j.errors.map((e) => e.message).join('; '));
  return j.data;
}

const TX_FIELDS = `id label side createdAt executionDate counterparty reference paymentMethodIdentifier paymentProduct isCancelable
  statusInfo { status } amount { value currency }
  ... on InternationalCreditTransferTransaction { instructedAmount { value currency } currencyExchange { exchangeRate } intermediaryBankFees { value currency } estimatedDeliveryAt }
  ... on SEPADirectDebitTransaction { returnReason }`;
const normTx = (n) => ({ ...n, product: n.paymentProduct,
  intl: n.instructedAmount ? { instructed: n.instructedAmount, rate: n.currencyExchange?.exchangeRate, bankFees: n.intermediaryBankFees, estimatedDeliveryAt: n.estimatedDeliveryAt } : undefined });
const PURPOSES = { ProofOfOriginOfFunds: 'Justificatif de l’origine des fonds', Other: 'Autre justificatif' };
const live = {
  async accounts() {
    const d = await gql(`query { accounts(first: 20) { edges { node {
      id name IBAN BIC statusInfo { status }
      balances { available { value currency } booked { value currency } } } } } }`);
    return d.accounts.edges.map((e) => e.node);
  },
  // Liste enrichie : contrepartie, référence, produit, exécution, détails des virements internationaux
  async transactions(accountId, filters) {
    const d = await gql(`query($id: ID!, $filters: TransactionsFiltersInput) { account(id: $id) { transactions(first: 50, filters: $filters) { edges { node {
      ${TX_FIELDS} } } } } }`, { id: accountId, filters });
    return d.account.transactions.edges.map((e) => normTx(e.node));
  },
  // Prélèvements à venir : transactions au statut Upcoming (un SEPA Direct Debit reçu crée une transaction Upcoming, sans effet sur le solde)
  async upcoming(accountId) {
    return (await live.transactions(accountId, { status: ['Upcoming'] })).filter((t) => t.side === 'Debit');
  },
  async intlQuote({ accountId, amount, currency }) {
    const d = await gql(`query($id: ID!, $amt: AmountInput!) { internationalCreditTransferQuote(accountId: $id, targetAmount: $amt) {
      exchangeRate feesAmount { value currency } sourceAmount { value currency } targetAmount { value currency } } }`,
      { id: accountId, amt: { value: String(amount), currency } });
    const q = d.internationalCreditTransferQuote;
    return { rate: q.exchangeRate, fee: q.feesAmount, source: q.sourceAmount, target: q.targetAmount };
  },
  // Retourne une URL de consentement (SCA). `details` = [{key,value}] propres au pays / à la devise (cf. internationalBeneficiaryDynamicForms)
  async initiateInternational({ accountId, name, currency, route, details, amount, reference }) {
    const d = await gql(`mutation($input: InitiateInternationalCreditTransferInput!) { initiateInternationalCreditTransfer(input: $input) {
      __typename ... on InitiateInternationalCreditTransferResponseSuccessPayload { payment { id createdAt statusInfo { status ... on PaymentConsentPending { consent { consentUrl } } } } }
      ... on Rejection { message } } }`,
      { input: { accountId, consentRedirectUrl: `${APP_URL}/?transfer=done`,
        internationalBeneficiary: { name, currency, ...(route ? { route } : {}), details },
        internationalCreditTransferDetails: { key: 'reference', value: reference },
        targetAmount: { value: String(amount), currency } } });
    const p = d.initiateInternationalCreditTransfer;
    if (p.__typename !== 'InitiateInternationalCreditTransferResponseSuccessPayload') throw new Error(p.message || p.__typename);
    return p;
  },
  async cards(accountId) {
    const d = await gql(`query($id: ID!) { account(id: $id) { cards(first: 20) { edges { node {
      id type statusInfo { status } cardMaskedNumber expirationDate
      accountMembership { user { firstName lastName } } } } } } }`, { id: accountId });
    return d.account.cards.edges.map((e) => e.node);
  },
  async addCard(membershipId) {
    const d = await gql(`mutation($input: AddCardInput!) { addCard(input: $input) {
      __typename ... on AddCardSuccessPayload { card { id statusInfo { status } } } } }`,
      { input: { accountMembershipId: membershipId, type: 'Virtual' } });
    return d.addCard;
  },
  // Retourne une URL de consentement (SCA) : l'utilisateur valide le virement chez Swan
  async initiateTransfer({ accountId, iban, name, amount, label }) {
    const d = await gql(`mutation($input: InitiateCreditTransfersInput!) { initiateCreditTransfers(input: $input) {
      __typename ... on InitiateCreditTransfersSuccessPayload { payment { id statusInfo { status ... on PaymentStatusInfo { consent { consentUrl } } } } } } }`,
      { input: { accountId, consentRedirectUrl: `${APP_URL}/?transfer=done`,
        creditTransfers: [{ amount: { value: String(amount), currency: 'EUR' }, label,
          sepaBeneficiary: { name, save: false, iban } }] } });
    return d.initiateCreditTransfers;
  },
  // Relit la ressource d'un webhook (le payload ne contient que son id) → forme normalisée
  async resource(type, id, mockStatus, ctx = {}) {
    if (type === 'Card.Updated') {
      const { card: c } = await gql(`query($id: ID!) { card(id: $id) { id statusInfo { status } cardMaskedNumber expirationDate
        accountMembership { email user { firstName } } } }`, { id });
      return { status: c.statusInfo.status, masked: c.cardMaskedNumber, expiry: c.expirationDate, email: c.accountMembership?.email, firstName: c.accountMembership?.user?.firstName };
    }
    if (type === 'Account.Updated') {
      const { account: a } = await gql(`query($id: ID!) { account(id: $id) { name IBAN statusInfo { status } } }`, { id });
      return { status: a.statusInfo.status, name: a.name, IBAN: a.IBAN };
    }
    if (type === 'Transaction.Upcoming') {
      const { transaction: t } = await gql(`query($id: ID!) { transaction(id: $id) { ${TX_FIELDS} } }`, { id });
      return { status: t.statusInfo.status, side: t.side, creditor: t.counterparty, label: t.label, reference: t.reference,
        value: t.amount.value, currency: t.amount.currency, date: t.executionDate };
    }
    if (type === 'SupportingDocumentCollection.Updated') {
      const { supportingDocumentCollection: c } = await gql(`query($id: ID!) { supportingDocumentCollection(id: $id) { id statusInfo { status }
        requiredSupportingDocumentPurposes { name purposeDetails } accountHolder { name } transaction { id } } }`, { id });
      const out = { status: c.statusInfo.status, clientName: c.accountHolder?.name,
        docs: c.requiredSupportingDocumentPurposes.map((p) => (PURPOSES[p.name] || p.name) + (p.purposeDetails ? ` (${p.purposeDetails})` : '')) };
      if (!c.transaction?.id) return { ...out, notTransaction: true };       // collection d'onboarding, hors périmètre
      const { transaction: t } = await gql(`query($id: ID!) { transaction(id: $id) { id label createdAt amount { value currency } } }`, { id: c.transaction.id });
      return { ...out, txLabel: t.label, date: t.createdAt, amount: `${Number(t.amount.value).toLocaleString('fr-FR', { minimumFractionDigits: 2 })} ${t.amount.currency === 'EUR' ? '€' : t.amount.currency}` };
    }
    if (type === 'SupportingDocument.Updated') {     // le webhook donne l'id du document : on relit sa collection (connue via notre demande)
      if (!ctx.collectionId) throw new Error('Justificatif inconnu (aucune demande locale)');
      const { supportingDocumentCollection: c } = await gql(`query($id: ID!) { supportingDocumentCollection(id: $id) { supportingDocuments { id
        statusInfo { status ... on SupportingDocumentRefusedStatusInfo { reason reasonCode } } } } }`, { id: ctx.collectionId });
      const d = c.supportingDocuments.find((x) => x.id === id) || c.supportingDocuments.at(-1);
      return { status: d.statusInfo.status, reason: d.statusInfo.reason || null, reasonCode: d.statusInfo.reasonCode || null };
    }
    const { onboarding: o } = await gql(`query($id: ID!) { onboarding(id: $id) { account { IBAN BIC } info { ... on OnboardingCompanyAccountHolderInfo { email } } } }`, { id });
    return { status: 'Finalized', IBAN: o.account?.IBAN, BIC: o.account?.BIC, email: o.info?.email };
  },
  // Dépôt d'un justificatif : URL présignée Swan (S3, valable 7 jours) puis POST multipart (fichier en dernier champ)
  async submitDocument(collectionId, { filename, data }) {
    const { supportingDocumentCollection: c } = await gql(`query($id: ID!) { supportingDocumentCollection(id: $id) { requiredSupportingDocumentPurposes { name } } }`, { id: collectionId });
    const g = await gql(`mutation($input: GenerateSupportingDocumentUploadUrlInput!) { generateSupportingDocumentUploadUrl(input: $input) {
      __typename ... on GenerateSupportingDocumentUploadUrlSuccessPayload { supportingDocumentId upload { url fields { key value } } }
      ... on Rejection { message } } }`,
      { input: { supportingDocumentCollectionId: collectionId, filename, supportingDocumentPurpose: c.requiredSupportingDocumentPurposes[0]?.name } });
    const p = g.generateSupportingDocumentUploadUrl;
    if (p.__typename !== 'GenerateSupportingDocumentUploadUrlSuccessPayload') throw new Error(p.message || p.__typename);
    const form = new FormData();
    for (const f of p.upload.fields) form.append(f.key, f.value);
    form.append('file', new Blob([Buffer.from(data, 'base64')]), filename);          // le fichier doit être le dernier champ
    const res = await fetch(p.upload.url, { method: 'POST', body: form });
    if (!res.ok && res.status !== 204) throw new Error(`Envoi du fichier refusé (${res.status})`);
    return { documentId: p.supportingDocumentId };
  },
  async onboard({ legalName, email }) {
    const d = await gql(`mutation($input: OnboardCompanyAccountHolderInput!) { onboardCompanyAccountHolder(input: $input) {
      __typename ... on OnboardCompanyAccountHolderSuccessPayload { onboarding { id onboardingUrl } } } }`,
      { input: { email, legalRepresentativePersonalAddress: undefined, name: legalName,
        oAuthRedirectParameters: { redirectUrl: `${APP_URL}/?onboarding=done` }, language: 'fr', accountCountry: 'FRA' } });
    return d.onboardCompanyAccountHolder;
  },
};

// ---------- MOCK ----------
const uid = () => Math.random().toString(36).slice(2, 10);
const db = {
  accounts: [{ id: 'acc_1', name: 'Compte principal', IBAN: 'FR76 1695 8000 0100 0000 0000 123', BIC: 'SWNBFR22',
    statusInfo: { status: 'Opened' },
    balances: { available: { value: '12480.50', currency: 'EUR' }, booked: { value: '12980.50', currency: 'EUR' } } }],
  transactions: [
    { id: 't1', label: 'VIR ACME SAS - Facture F-2026-0001', side: 'Credit', createdAt: '2026-10-02T09:12:00Z', executionDate: '2026-10-02T09:12:00Z', statusInfo: { status: 'Booked' }, amount: { value: '5040.00', currency: 'EUR' },
      counterparty: 'ACME SAS', reference: 'ACME-F-2026-0001', paymentMethodIdentifier: 'FR76 3000 4000 0300 0012 3456 789', product: 'SEPACreditTransfer', isCancelable: false },
    { id: 't2', label: 'Loyer bureaux octobre', side: 'Debit', createdAt: '2026-10-01T08:00:00Z', executionDate: '2026-10-01T08:00:00Z', statusInfo: { status: 'Booked' }, amount: { value: '1800.00', currency: 'EUR' },
      counterparty: 'SCI Bellecour', reference: 'LOYER-2026-10', paymentMethodIdentifier: 'FR76 1470 7000 1100 0000 0000 456', product: 'SEPACreditTransfer', isCancelable: false },
    { id: 't3', label: 'Abonnement SaaS', side: 'Debit', createdAt: '2026-09-29T14:30:00Z', executionDate: '2026-09-30T00:00:00Z', statusInfo: { status: 'Pending' }, amount: { value: '49.00', currency: 'EUR' },
      counterparty: 'Notion Labs', reference: 'CARD-4242-0929', paymentMethodIdentifier: '•••• 4242', product: 'Card', isCancelable: false },
  ],
  // Prélèvements SEPA reçus, au statut Upcoming (aucun effet sur le solde avant la date de règlement)
  upcoming: [
    ['URSSAF Rhône-Alpes', 'Cotisations T3 2026', '842.00', 3, 'URSSAF-RA-2026-T3'],
    ['Orange Business', 'Facture 092026', '129.90', 6, 'ORG-092026'],
    ['AXA Entreprises', 'Prime RC Pro', '214.50', 11, 'AXA-RCP-10'],
    ['OVHcloud', 'Serveurs octobre', '38.40', 17, 'OVH-2026-10'],
  ].map(([counterparty, label, value, inDays, reference], i) => ({ id: `up_${i + 1}`, label, counterparty, reference, side: 'Debit', product: 'SEPADirectDebit',
    createdAt: new Date().toISOString(), executionDate: new Date(Date.now() + inDays * 864e5).toISOString(), statusInfo: { status: 'Upcoming' },
    amount: { value, currency: 'EUR' }, paymentMethodIdentifier: 'FR76 1695 8000 0100 0000 0000 123', isCancelable: true })),
  cards: [{ id: 'c1', type: 'Virtual', statusInfo: { status: 'Enabled' }, cardMaskedNumber: '•••• 4242', expirationDate: '09/29',
    accountMembership: { user: { firstName: 'Camille', lastName: 'Durand' } } }],
};
const MOCK_RATES = { USD: 1.09, GBP: 0.86, CHF: 0.95, CAD: 1.5, AUD: 1.65, JPY: 162 };
const mock = {
  accounts: async () => db.accounts,
  transactions: async () => [...db.upcoming, ...db.transactions].sort((x, y) => new Date(y.executionDate) - new Date(x.executionDate)),
  upcoming: async () => db.upcoming.filter((t) => t.statusInfo.status === 'Upcoming').sort((x, y) => new Date(x.executionDate) - new Date(y.executionDate)),
  // Taux fictifs (unités de devise cible pour 1 €). Frais : 5 € + 0,6 % (groupe 1 de la grille Swan)
  async intlQuote({ amount, currency }) {
    const rate = MOCK_RATES[currency]; if (!rate) throw new Error(`Devise non prise en charge : ${currency}`);
    const src = Number(amount) / rate, fee = 5 + src * 0.006;
    return { rate, fee: { value: fee.toFixed(2), currency: 'EUR' }, source: { value: src.toFixed(2), currency: 'EUR' }, target: { value: Number(amount).toFixed(2), currency } };
  },
  async initiateInternational({ name, currency, route, details, amount, reference }) {
    const q = await mock.intlQuote({ amount, currency }), a = db.accounts[0], total = Number(q.source.value) + Number(q.fee.value), now = new Date().toISOString();
    if (total > Number(a.balances.available.value)) throw new Error('Solde insuffisant');
    a.balances.available.value = (Number(a.balances.available.value) - total).toFixed(2);
    const id = uid();
    db.transactions.unshift({ id, label: reference, side: 'Debit', createdAt: now, executionDate: now, statusInfo: { status: 'Pending' }, amount: q.source,
      counterparty: name, reference, paymentMethodIdentifier: a.IBAN, product: 'InternationalCreditTransfer', isCancelable: false,
      intl: { instructed: q.target, rate: q.rate, bankFees: [], estimatedDeliveryAt: new Date(Date.now() + 2 * 864e5).toISOString(), route } });
    db.transactions.unshift({ id: uid(), label: 'Frais virement international', side: 'Debit', createdAt: now, executionDate: now, statusInfo: { status: 'Booked' }, amount: q.fee,
      counterparty: 'Swan', reference: `FEE-${id}`, paymentMethodIdentifier: '', product: 'Fees', isCancelable: false });
    return { payment: { id, statusInfo: { status: 'ConsentPending' } }, mock: true };
  },
  cards: async () => db.cards,
  addCard: async () => {
    const c = { id: uid(), type: 'Virtual', statusInfo: { status: 'Enabled' },
      cardMaskedNumber: '•••• ' + Math.floor(1000 + Math.random() * 9000), expirationDate: '10/29',
      accountMembership: { user: { firstName: 'Nouveau', lastName: 'Membre' } } };
    db.cards.unshift(c); return { card: c };
  },
  async initiateTransfer({ amount, label, name }) {
    const a = db.accounts[0];
    a.balances.available.value = (Number(a.balances.available.value) - Number(amount)).toFixed(2);
    db.transactions.unshift({ id: uid(), label: `${label} → ${name}`, side: 'Debit', createdAt: new Date().toISOString(),
      statusInfo: { status: 'Pending' }, amount: { value: Number(amount).toFixed(2), currency: 'EUR' } });
    return { payment: { id: uid(), statusInfo: { status: 'ConsentPending' } }, mock: true };
  },
  // Mock : le statut peut être forcé via le payload de test (ev.mock), sinon on lit l'état en mémoire
  async resource(type, id, mockStatus, ctx) {
    if (type === 'Card.Updated') { const c = db.cards.find((x) => x.id === id) || db.cards[0];
      return { status: c.statusInfo.status, masked: c.cardMaskedNumber, expiry: c.expirationDate, email: 'camille@studio-durand.fr', firstName: c.accountMembership.user.firstName }; }
    if (type === 'Account.Updated') { const a = db.accounts.find((x) => x.id === id) || db.accounts[0];
      return { status: a.statusInfo.status, name: a.name, IBAN: a.IBAN }; }
    if (type === 'Transaction.Upcoming') { const t = db.upcoming.find((x) => x.id === id) || db.upcoming[0];
      return { status: 'Upcoming', side: t.side, creditor: t.counterparty, label: t.label, reference: t.reference, value: t.amount.value, currency: t.amount.currency, date: t.executionDate }; }
    if (type === 'SupportingDocumentCollection.Updated') return { status: 'WaitingForDocument', clientName: 'ACME SAS', email: 'compta@acme.fr',
      txLabel: 'VIR ACME SAS - Acompte projet', amount: '18 500,00 €', date: new Date().toISOString(), docs: ['Contrat ou facture justifiant le virement'],
      deadline: new Date(Date.now() + 10 * 864e5).toISOString() };
    if (type === 'SupportingDocument.Updated') return { status: mockStatus || 'Validated', reason: mockStatus === 'Refused' ? 'Document illisible, merci de fournir un scan de meilleure qualité.' : null, reasonCode: mockStatus === 'Refused' ? 'BadDocumentQuality' : null };
    return { status: 'Finalized', IBAN: db.accounts[0].IBAN, BIC: db.accounts[0].BIC };
  },
  submitDocument: async () => ({ documentId: 'doc_' + uid() }),
  onboard: async ({ legalName }) => ({ onboarding: { id: uid(), onboardingUrl: null, legalName }, mock: true }),
};

export const swan = isLive ? live : mock;

// Maquette dépôt de capital : crédit fictif sur le compte (mode test uniquement)
export function mockCredit({ label, counterparty, amount }) {
  if (isLive) return;
  const now = new Date().toISOString(), a = db.accounts[0];
  a.balances.available.value = (Number(a.balances.available.value) + Number(amount)).toFixed(2);
  db.transactions.unshift({ id: uid(), label, side: 'Credit', createdAt: now, executionDate: now, statusInfo: { status: 'Booked' }, amount: { value: Number(amount).toFixed(2), currency: 'EUR' },
    counterparty, reference: 'CAPITAL', paymentMethodIdentifier: a.IBAN, product: 'SEPACreditTransfer', isCancelable: false });
}

// Webhook Swan : événement reçu → on peut mettre à jour la base/notifier le client
export function handleWebhook(event) {
  console.log('[webhook]', event.eventType, event.resourceId);
  if (!isLive && event.mockStatus && /^(Card|Account)\.Updated$/.test(event.eventType)) {   // simulation : change le statut d'une carte/compte
    const t = event.eventType === 'Card.Updated' ? db.cards : db.accounts;
    const x = t.find((y) => y.id === event.resourceId) || t[0]; if (x) x.statusInfo.status = event.mockStatus;
  }
  if (!isLive && event.eventType === 'Transaction.Booked') {
    const now = new Date().toISOString();
    db.transactions.unshift({ id: event.resourceId, label: 'Événement webhook', side: 'Credit', createdAt: now, executionDate: now, statusInfo: { status: 'Booked' },
      amount: { value: '100.00', currency: 'EUR' }, counterparty: 'Simulation', reference: 'SIM', paymentMethodIdentifier: '', product: 'SEPACreditTransfer', isCancelable: false });
  }
  if (!isLive && event.eventType === 'Transaction.Upcoming' && !db.upcoming.some((t) => t.id === event.resourceId)) {   // simulation : nouveau prélèvement SEPA reçu
    db.upcoming.push({ id: event.resourceId, label: 'Abonnement Free Pro', counterparty: 'Free Pro SAS', reference: 'FREE-PRO-' + event.resourceId.slice(-4), side: 'Debit', product: 'SEPADirectDebit',
      createdAt: new Date().toISOString(), executionDate: new Date(Date.now() + 5 * 864e5).toISOString(), statusInfo: { status: 'Upcoming' }, amount: { value: '29.99', currency: 'EUR' },
      paymentMethodIdentifier: db.accounts[0].IBAN, isCancelable: true });
  }
}
