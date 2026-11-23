// Espace séparé « Dépôt de capital » : dossiers, emails du partenaire (mailing) et boîte de test, sur son propre port.
// Même base SQLite que l'app principale (DB_FILE / MODE), process distinct.
// Lancement : npm run capital   (CAPITAL_PORT=3100 par défaut ; MAIN_URL = app principale, pour créditer le compte pro en maquette)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isLive } from './swan.js';
import * as capital from './capital.js';
import * as partnerMail from './swanmail.js';
import { refusalStats } from './docrules.js';
import { run, get } from './db.js';
import * as threads from './threads.js';
import * as gmail from './gmail.js';

const PORT = process.env.CAPITAL_PORT || process.env.PORT || 3100;   // PORT : imposé par l'hébergeur (Render)
const MAIN_URL = process.env.MAIN_URL || `http://localhost:${process.env.PORT || 3000}`;
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const send = (res, code, type, data, extra = {}) => { res.writeHead(code, { 'Content-Type': type, ...extra }); res.end(data); };

const routes = [];
const R = (m, p, h) => routes.push([m, new RegExp(`^${p}$`), h]);
const testOnly = (h) => async (...a) => { if (isLive) throw new Error('Disponible uniquement en mode test'); return h(...a); };

R('GET', '/api/config', async () => ({ mode: isLive ? 'live' : 'mock', mainUrl: MAIN_URL }));

// Dépôt de capital en marque blanche (maquette : API et webhooks Swan simulés)
R('GET', '/api/capital/queue', async () => capital.queue());
R('GET', '/api/capital/refusals', async (req, u) => capital.refusalDashboard({ days: Number(u.searchParams.get('days')) || 90, source: u.searchParams.get('source') || 'all' }));
R('GET', '/api/capital', async (req, u) => capital.view(Number(u.searchParams.get('id')) || undefined));
R('POST', '/api/capital', async (req) => capital.create(await body(req)));
R('POST', '/api/capital/(\\d+)/docs/(\\d+)', async (req, u, [id, d]) => capital.uploadDoc(+id, +d, await body(req)));
R('POST', '/api/capital/(\\d+)/act', async (req, u, [id]) => {
  const before = capital.view(+id).case?.status;
  let out = await capital.act(+id, await body(req));
  await capital.checkAlerts(); out = capital.view(+id);   // ouvre ou résout les alertes de délai partenaire
  // Maquette : le compte pro (mock en mémoire) vit dans le process de l'app principale → on lui transmet la libération du capital
  if (!isLive && before !== 'Completed' && out.case?.status === 'Completed') {
    const c = out.case;
    fetch(`${MAIN_URL}/api/test/credit`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: `Libération du capital — ${c.company_name}`, counterparty: 'Notaire (compte séquestre)', amount: (c.total_cents / 100).toFixed(2) }) })
      .catch(() => console.warn(`[capital] app principale injoignable (${MAIN_URL}) : crédit du compte pro non transmis`));
  }
  return out;
});
R('POST', '/api/capital/(\\d+)/withdraw', async (req, u, [id]) => { await capital.withdraw(+id); await capital.checkAlerts(); return capital.view(+id); });
R('POST', '/api/test/backdate', testOnly(async (req) => { const b = await body(req); capital.backdate(Number(b.caseId), b.days); await capital.checkAlerts(); return capital.view(Number(b.caseId)); }));
R('POST', '/api/capital/(\\d+)/delete', testOnly(async (req, u, [id]) => capital.remove(+id)));
R('POST', '/api/test/clear-mails', testOnly(async () => capital.clearMails()));
R('POST', '/api/test/clear-cases', testOnly(async () => capital.clearCases()));
R('GET', '/api/capital/(\\d+)/docs/(\\d+)/preview.pdf', async (req, u, [id, d]) => ({ raw: await capital.generatedPdf(+id, +d), type: 'application/pdf', headers: { 'Content-Disposition': 'inline; filename="document.pdf"' } }));
R('GET', '/api/capital/(\\d+)/certificate.pdf', async (req, u, [id]) => ({ raw: await capital.certificate(+id), type: 'application/pdf', headers: { 'Content-Disposition': 'inline; filename="attestation-depot-capital.pdf"' } }));
R('GET', '/api/mailing', async () => capital.mailing());

// Emails du partenaire : réception (service d'email entrant), brouillon, validation humaine
R('POST', '/api/swanmail/inbound', async (req) => {     // appelé par le service d'email entrant, protégé par un secret partagé
  const secret = process.env.SWANMAIL_SECRET;
  if (secret && req.headers['x-inbound-secret'] !== secret) throw new Error('Secret d’entrée invalide');
  return partnerMail.ingest(await body(req));
});
R('GET', '/api/swanmail', async () => ({ items: partnerMail.list(), stats: partnerMail.stats() }));
R('POST', '/api/swanmail/simulate', testOnly(async (req) => { const b = await body(req); return partnerMail.ingest(partnerMail.sample(b.kind, b.caseId)); }));
R('POST', '/api/swanmail/(\\d+)/send', async (req, u, [id]) => partnerMail.send(+id, await body(req)));
R('POST', '/api/swanmail/(\\d+)/ignore', async (req, u, [id]) => partnerMail.ignore(+id, (await body(req)).reason));
R('POST', '/api/swanmail/(\\d+)/attach', async (req, u, [id]) => partnerMail.attach(+id, Number((await body(req)).caseId)));
R('GET', '/api/doc-refusals', async () => refusalStats());

// Conversations Swan / nous / client (une par demande du partenaire)
const tid = (id) => threads.full(+id);
R('GET', '/api/threads', async (req, u) => ({ items: threads.list({ caseId: Number(u.searchParams.get('caseId')) || undefined }), gmail: gmail.status() }));
R('GET', '/api/threads/(\\d+)', async (req, u, [id]) => tid(id));
R('POST', '/api/threads/(\\d+)/client', async (req, u, [id]) => {
  const b = await body(req), t = threads.full(+id), to = t.shareholders.find((s) => s.email === b.to_email);
  if (!to) throw new Error('Destinataire inconnu pour ce dossier');
  if (/swan/i.test(`${b.subject} ${b.body}`)) throw new Error('Le message mentionne le partenaire : reformulez avant d’envoyer au client');
  await threads.toClient(+id, { to: { name: to.name, email: to.email }, subject: b.subject, body: b.body });
  return tid(id);
});
R('POST', '/api/threads/(\\d+)/partner', async (req, u, [id]) => {
  const b = await body(req);
  await threads.toPartner(+id, { body: b.body });
  // Réponse transmise au partenaire alors qu'il attendait un complément : le dossier repart en revue
  const c = threads.full(+id).case;
  if (b.resume !== false && c.status === 'WaitingForAdditionalInformation' && c.info_source === 'email' && c.info_relayed) await capital.act(c.id, { action: 'answer' });
  return tid(id);
});
R('POST', '/api/threads/(\\d+)/note', async (req, u, [id]) => { threads.note(+id, (await body(req)).body); return tid(id); });
R('POST', '/api/threads/(\\d+)/close', async (req, u, [id]) => { threads.setClosed(+id, (await body(req)).closed !== false); return tid(id); });
R('POST', '/api/threads/(\\d+)/simulate-client', testOnly(async (req, u, [id]) => {
  const b = await body(req), s = threads.sampleClientReply(+id);
  threads.fromClient({ threadId: +id, from_email: b.from_email || s.from_email, text: b.text?.trim() || s.text }); return tid(id); }));
R('POST', '/api/threads/(\\d+)/simulate-partner', testOnly(async (req, u, [id]) => { const b = await body(req); threads.partnerReply(+id, b.text?.trim() || threads.samplePartnerReply(+id)); return tid(id); }));
// Côté client : ses échanges avec nous, et sa réponse (en réel, c'est un email reçu sur l'adresse du dossier)
R('GET', '/api/client-messages', async (req, u) => threads.forClient(Number(u.searchParams.get('caseId')), u.searchParams.get('email') || ''));
R('POST', '/api/client-messages/reply', testOnly(async (req) => { const b = await body(req);
  if (!b.text?.trim()) throw new Error('Message vide');
  threads.fromClient({ caseId: Number(b.caseId), from_email: b.email, text: b.text.trim() }); return threads.forClient(Number(b.caseId), b.email); }));
R('GET', '/api/gmail/status', async () => gmail.status());

// Horloge de démo : avancer le temps pour voir délais et retards évoluer (0 = revenir à aujourd'hui)
R('POST', '/api/test/clock', testOnly(async (req) => { const c = capital.clock.shift(Number((await body(req)).days)); return { ...c, alertsOpened: (await capital.checkAlerts()).length }; }));
R('POST', '/api/capital/alerts/(\\d+)/(relaunch|ack)', async (req, u, [id, action]) => capital.alertAction(+id, action));

// Polices (aperçu identique au PDF)
R('GET', '/fonts/((?:inter|source-serif-4|nunito)-latin-(?:400|700)-normal\\.woff2)', async (req, u, [file]) => ({
  raw: await readFile(new URL(`./node_modules/@fontsource/${file.split('-latin')[0]}/files/${file}`, import.meta.url)), type: 'font/woff2', headers: { 'Cache-Control': 'public, max-age=86400' } }));

// Délais partenaire : vérification au démarrage puis toutes les 10 minutes
const sweep = () => capital.checkAlerts().then((o) => o.length && console.log(`[alertes] ${o.length} alerte(s) délai partenaire ouverte(s)`)).catch(console.error);
sweep(); setInterval(sweep, 10 * 60e3).unref();

// Gmail réel : relève de la boîte chaque minute. Réponse sur depot+REF@ → client du dossier ; ticket Swan/Zendesk → emails partenaire.
async function syncGmail() {
  for (const m of await gmail.fetchNew()) {
    try {
      const ref = gmail.refFromAddress(m.to), c = ref && get('SELECT id FROM cd_cases WHERE ref=?', ref);
      if (c) { threads.fromClient({ caseId: c.id, from_email: m.from, subject: m.subject, text: m.text, gmail: m }); gmail.markSeen(m.id, `client:${ref}`); }
      else if (get('SELECT id FROM cd_threads WHERE partner_thread=?', m.threadId)) {   // suite d'un ticket déjà suivi : on l'ajoute à la conversation
        threads.partnerReply(get('SELECT id FROM cd_threads WHERE partner_thread=?', m.threadId).id, m.text, m); gmail.markSeen(m.id, 'partner-reply'); }
      else if (/swan\.io|zendesk\.com/i.test(m.from)) { await partnerMail.ingest({ from: m.from, subject: m.subject, text: m.text, gmail: m }); gmail.markSeen(m.id, 'partner'); }
      else gmail.markSeen(m.id, 'ignored');
    } catch (e) { console.error('[gmail]', m.id, e.message); }
  }
}
if (gmail.isLive) { syncGmail().catch((e) => console.error('[gmail]', e.message)); setInterval(() => syncGmail().catch((e) => console.error('[gmail]', e.message)), 60e3).unref(); }

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    for (const [m, re, h] of routes) {
      const match = m === req.method && re.exec(u.pathname);
      if (!match) continue;
      const out = await h(req, u, match.slice(1));
      return out?.raw !== undefined ? send(res, 200, out.type, out.raw, out.headers) : send(res, 200, 'application/json', JSON.stringify(out));
    }
    // Pages : / (accueil de la démo), /client (vue du fondateur ou d'un associé), /agent (console du formaliste), /atelier (atelier technique + Mailing)
    const PAGES = { '/agent/conversation': 'conversation.html', '/': 'accueil.html', '/atelier': 'capital.html', '/client': 'client.html', '/agent': 'agent.html', '/agent/statuts': 'statuts.html', '/dashboard': 'dashboard.html', '/nova.css': 'nova.css',
      '/maquettes/client': 'maquette-client.html', '/maquettes/formaliste': 'maquette-formaliste.html', '/maquettes/accueil': 'maquette-accueil.html' };
    const page = PAGES[u.pathname];
    if (!page) return send(res, 404, 'application/json', JSON.stringify({ error: 'Introuvable' }));
    send(res, 200, page.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8', await readFile(new URL('./public/' + page, import.meta.url)));
  } catch (e) {
    send(res, e.code === 'ENOENT' ? 404 : 400, 'application/json', JSON.stringify({ error: e.message, warnings: e.warnings }));
  }
}).listen(PORT, () => {
  console.log(`Nova Pro · Dépôt de capital [${isLive ? 'LIVE' : 'MOCK'}] · Gmail ${gmail.isLive ? `réel (${gmail.ADDRESS})` : 'simulé'} → http://localhost:${PORT}`);
  // Démo en ligne : base vide au démarrage → on crée les dossiers d'exemple (DEMO_SEED=1, mode simulé uniquement)
  if (process.env.DEMO_SEED === '1' && !isLive && !get('SELECT id FROM cd_cases LIMIT 1'))
    spawn(process.execPath, [fileURLToPath(new URL('./scripts/demo-capital.mjs', import.meta.url))], { stdio: 'inherit', env: { ...process.env, CAPITAL_URL: `http://localhost:${PORT}` } });
});
