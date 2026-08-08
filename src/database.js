/**
 * SQLite Database layer for UPI Demo App
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'upi-demo.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS merchants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    upi_id TEXT NOT NULL,
    merchant_id TEXT NOT NULL,
    api_token TEXT NOT NULL,
    api_cookie TEXT NOT NULL,
    bharatpe_api TEXT,
    user_agent TEXT DEFAULT 'UPI-Demo/1.0',
    is_active INTEGER DEFAULT 1,
    poll_interval INTEGER DEFAULT 5000,
    timeout INTEGER DEFAULT 300,
    min_amount REAL DEFAULT 1.0,
    max_amount REAL DEFAULT 50000.0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT UNIQUE NOT NULL,
    merchant_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    session_amount REAL NOT NULL,
    status TEXT DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'SUCCESS', 'FAILURE', 'EXPIRED')),
    utr TEXT,
    payer_vpa TEXT,
    payer_name TEXT,
    payer_handle TEXT,
    metadata TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    FOREIGN KEY (merchant_id) REFERENCES merchants(id)
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (payment_id) REFERENCES payments(id)
  );

  CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);
  CREATE INDEX IF NOT EXISTS idx_payments_merchant ON payments(merchant_id, status, created_at);
  CREATE INDEX IF NOT EXISTS idx_events_payment ON events(payment_id);
`);

// ---- Prepared Statements ----

const stmts = {
  createMerchant: db.prepare(
    `INSERT INTO merchants (name, upi_id, merchant_id, api_token, api_cookie, bharatpe_api, user_agent, poll_interval, timeout, min_amount, max_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  getAllMerchants: db.prepare(`SELECT * FROM merchants WHERE is_active = 1`),
  getMerchantById: db.prepare(`SELECT * FROM merchants WHERE id = ?`),
  updateMerchant: db.prepare(
    `UPDATE merchants SET name=?, upi_id=?, merchant_id=?, api_token=?, api_cookie=?, bharatpe_api=?, user_agent=?, poll_interval=?, timeout=?, min_amount=?, max_amount=?, updated_at=datetime('now') WHERE id=?`
  ),
  deleteMerchant: db.prepare(`UPDATE merchants SET is_active = 0 WHERE id = ?`),

  insertPayment: db.prepare(
    `INSERT INTO payments (order_id, merchant_id, amount, session_amount, status, metadata) VALUES (?, ?, ?, ?, ?, ?)`
  ),
  getPaymentByOrderId: db.prepare(`SELECT * FROM payments WHERE order_id = ?`),
  getPaymentsByMerchant: db.prepare(
    `SELECT * FROM payments WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ),
  countPaymentsByMerchant: db.prepare(`SELECT COUNT(*) as count FROM payments WHERE merchant_id = ?`),
  getPendingPayments: db.prepare(`SELECT * FROM payments WHERE status = 'PENDING'`),
  updatePaymentSuccess: db.prepare(
    `UPDATE payments SET status = 'SUCCESS', utr = ?, payer_vpa = ?, payer_name = ?, payer_handle = ?, completed_at = datetime('now') WHERE order_id = ?`
  ),
  updatePaymentExpired: db.prepare(
    `UPDATE payments SET status = 'EXPIRED', completed_at = datetime('now') WHERE order_id = ?`
  ),

  insertEvent: db.prepare(`INSERT INTO events (payment_id, event_type, payload) VALUES (?, ?, ?)`),
  getEventsByPayment: db.prepare(`SELECT * FROM events WHERE payment_id = ? ORDER BY created_at ASC`),
};

// ---- Merchant operations ----

function createMerchant(data) {
  const result = stmts.createMerchant.run(
    data.name, data.upi_id, data.merchant_id, data.api_token, data.api_cookie,
    data.bharatpe_api || null, data.user_agent || 'UPI-Demo/1.0',
    data.poll_interval || 5000, data.timeout || 300,
    data.min_amount ?? 1.0, data.max_amount ?? 50000.0
  );
  return getMerchantById(result.lastInsertRowid);
}

function getActiveMerchants() {
  return stmts.getAllMerchants.all();
}

function getMerchantById(id) {
  return stmts.getMerchantById.get(id);
}

function updateMerchant(id, data) {
  const m = getMerchantById(id);
  if (!m) return null;
  stmts.updateMerchant.run(
    data.name ?? m.name, data.upi_id ?? m.upi_id, data.merchant_id ?? m.merchant_id,
    data.api_token ?? m.api_token, data.api_cookie ?? m.api_cookie,
    data.bharatpe_api ?? m.bharatpe_api, data.user_agent ?? m.user_agent,
    data.poll_interval ?? m.poll_interval, data.timeout ?? m.timeout,
    data.min_amount ?? m.min_amount, data.max_amount ?? m.max_amount, id
  );
  return getMerchantById(id);
}

function softDeleteMerchant(id) {
  return stmts.deleteMerchant.run(id);
}

// ---- Payment operations ----

function insertPayment(orderId, merchantId, amount, sessionAmount, metadata) {
  try {
    stmts.insertPayment.run(orderId, merchantId, amount, sessionAmount, 'PENDING', metadata ? JSON.stringify(metadata) : null);
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) return getPaymentByOrderId(orderId);
    throw err;
  }
  return getPaymentByOrderId(orderId);
}

function getPaymentByOrderId(orderId) {
  return stmts.getPaymentByOrderId.get(orderId);
}

function getPaymentsByMerchant(merchantId, page = 1, limit = 20) {
  const offset = (page - 1) * limit;
  const rows = stmts.getPaymentsByMerchant.all(merchantId, limit, offset);
  const total = stmts.countPaymentsByMerchant.get(merchantId);
  return { payments: rows, total: total.count, page, limit };
}

function markPaymentSuccess(orderId, utr, payerVpa, payerName, payerHandle) {
  stmts.updatePaymentSuccess.run(utr, payerVpa, payerName, payerHandle, orderId);
  return getPaymentByOrderId(orderId);
}

function markPaymentExpired(orderId) {
  stmts.updatePaymentExpired.run(orderId);
  return getPaymentByOrderId(orderId);
}

function getPendingPayments() {
  return stmts.getPendingPayments.all().map(r => ({ ...r, metadata: r.metadata ? JSON.parse(r.metadata) : null }));
}

// ---- Event logging ----

function logEvent(paymentId, eventType, payload) {
  stmts.insertEvent.run(paymentId, eventType, payload ? JSON.stringify(payload) : null);
}

function getEventsByPayment(paymentId) {
  return stmts.getEventsByPayment.all(paymentId);
}

module.exports = {
  db,
  createMerchant, getActiveMerchants, getMerchantById, updateMerchant, softDeleteMerchant,
  insertPayment, getPaymentByOrderId, getPaymentsByMerchant, getPendingPayments,
  markPaymentSuccess, markPaymentExpired,
  logEvent, getEventsByPayment,
};
