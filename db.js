// Base SQLite embarquée (node:sqlite, Node ≥ 22.5). Montants stockés en centimes.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// Environnement test (MODE=mock, défaut) : base séparée, jamais mélangée aux vraies données
export const db = new DatabaseSync(process.env.DB_FILE || fileURLToPath(new URL(process.env.MODE === 'live' ? './data.db' : './data-test.db', import.meta.url)));
db.exec(`
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY, kind TEXT, to_email TEXT, from_email TEXT, subject TEXT, body TEXT,
  mode TEXT, error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, address TEXT, siret TEXT, vat_number TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'invoice' CHECK (kind IN ('invoice','credit')),
  number TEXT UNIQUE,                       -- attribué à l'émission uniquement
  client_id INTEGER NOT NULL REFERENCES clients(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','cancelled')),
  issue_date TEXT, due_date TEXT, subject TEXT, notes TEXT,
  related_id INTEGER REFERENCES invoices(id),  -- facture d'origine d'un avoir
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS lines (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0, description TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1, unit_price_cents INTEGER NOT NULL, vat_rate REAL NOT NULL DEFAULT 20);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  amount_cents INTEGER NOT NULL, date TEXT NOT NULL, method TEXT, tx_id TEXT UNIQUE);
`);

export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);
export const transaction = (fn) => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};

// Migrations légères (ajout de colonnes) — facturation électronique 2026/2027
const cols = (t) => all(`PRAGMA table_info(${t})`).map((c) => c.name);
const addCol = (t, c, def) => { if (!cols(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
addCol('clients', 'siren', 'TEXT');
addCol('clients', 'country', "TEXT DEFAULT 'FR'");
addCol('invoices', 'operation_category', "TEXT DEFAULT 'services'"); // services | goods | mixed
addCol('invoices', 'vat_on_debits', 'INTEGER DEFAULT 0');             // option TVA sur les débits
addCol('invoices', 'delivery_address', 'TEXT');

// Boîte de réception : factures fournisseurs reçues (obligation de réception depuis le 1er sept. 2026)
db.exec(`
CREATE TABLE IF NOT EXISTS supplier_invoices (
  id INTEGER PRIMARY KEY, supplier_name TEXT NOT NULL, supplier_siren TEXT, supplier_vat TEXT, supplier_iban TEXT,
  number TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'invoice', issue_date TEXT, due_date TEXT,
  ht_cents INTEGER NOT NULL, vat_cents INTEGER NOT NULL, ttc_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','approved','refused','paid')),
  refusal_reason TEXT, source TEXT, xml TEXT, paid_date TEXT, tx_id TEXT,
  events TEXT NOT NULL DEFAULT '[]',          -- historique des statuts (transmis à la plateforme agréée)
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);

// Relances de factures clients en retard
addCol('invoices', 'reminders_paused', 'INTEGER DEFAULT 0');
db.exec(`
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id), level INTEGER NOT NULL,
  to_email TEXT, subject TEXT, body TEXT, mode TEXT NOT NULL CHECK (mode IN ('sent','simulated','failed')), error TEXT,
  sent_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);

// Devis (convertibles en facture)
db.exec(`
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY, number TEXT UNIQUE, client_id INTEGER NOT NULL REFERENCES clients(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','refused','converted')),
  issue_date TEXT, valid_until TEXT, subject TEXT, notes TEXT,
  operation_category TEXT DEFAULT 'services', vat_on_debits INTEGER DEFAULT 0, delivery_address TEXT,
  invoice_id INTEGER REFERENCES invoices(id), decided_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS quote_lines (
  id INTEGER PRIMARY KEY, quote_id INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0, description TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1, unit_price_cents INTEGER NOT NULL, vat_rate REAL NOT NULL DEFAULT 20);
`);
