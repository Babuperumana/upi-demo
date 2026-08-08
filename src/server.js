/**
 * UPI Payment Demo Server
 *
 * Coolify-ready Express app for demonstrating UPI payment capturing.
 * Deploy: push to GitHub → connect to Coolify → done.
 */

require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const db = require('./database');
const paymentService = require('./paymentService');
const { buildUpiUri, generateQR, paymentCardHTML, paymentCardJS } = require('./qrHelper');

console.log('[BOOT] All modules loaded');
console.log('[BOOT] paymentService:', typeof paymentService);
console.log('[BOOT] paymentService keys:', paymentService ? Object.keys(paymentService) : 'N/A');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ---- Health ----

app.get('/health', (req, res) => {
  try {
    const stats = db.db.prepare(
      `SELECT status, COUNT(*) as count FROM payments GROUP BY status`
    ).all();
    const merchants = db.getActiveMerchants();
    res.json({
      status: 'ok', uptime: process.uptime(),
      merchants: merchants.length,
      payments: stats.reduce((a, s) => ({ ...a, [s.status]: s.count }), {}),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ---- Setup: Interactive merchant creation on first run ----

app.get('/setup', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>UPI Demo — Setup</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; padding: 40px 20px; }
        .container { max-width: 560px; margin: 0 auto; }
        h1 { font-size: 24px; margin-bottom: 8px; }
        .subtitle { color: #94a3b8; font-size: 14px; margin-bottom: 32px; }
        label { display: block; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #94a3b8; margin-bottom: 6px; margin-top: 16px; }
        input, textarea { width: 100%; padding: 10px 14px; background: #1e293b; border: 1px solid #334155; border-radius: 8px; color: #e2e8f0; font-size: 14px; outline: none; transition: border-color 0.2s; }
        input:focus, textarea:focus { border-color: #3b82f6; }
        textarea { font-family: monospace; font-size: 12px; }
        button { width: 100%; padding: 12px; background: #3b82f6; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 24px; transition: background 0.2s; }
        button:hover { background: #2563eb; }
        .note { margin-top: 24px; padding: 14px; background: #1e293b; border-radius: 8px; font-size: 13px; color: #94a3b8; line-height: 1.6; }
        .note strong { color: #e2e8f0; }
        .error { color: #ef4444; margin-top: 12px; font-size: 13px; }
        .success { color: #10b981; margin-top: 12px; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>UPI Demo Setup</h1>
        <p class="subtitle">Register your BharatPe merchant account to start accepting payments.</p>

        <form id="setupForm">
          <label>Merchant Name</label>
          <input type="text" id="name" placeholder="e.g. My Store" required />

          <label>Merchant UPI ID</label>
          <input type="text" id="upi" placeholder="e.g. merchant@okaxis" required />

          <label>BharatPe Merchant ID</label>
          <input type="text" id="mid" placeholder="e.g. 49354135" required />

          <label>BharatPe API Token</label>
          <textarea id="token" rows="3" placeholder="Paste the token from browser DevTools" required></textarea>

          <label>BharatPe Cookie</label>
          <textarea id="cookie" rows="3" placeholder="Paste the Cookie header from browser DevTools" required></textarea>

          <button type="submit">Create Merchant</button>
        </form>

        <div id="result"></div>

        <div class="note">
          <strong>How to get BharatPe credentials:</strong><br>
          1. Open merchant.bharatpe.com and log in<br>
          2. Open <strong>DevTools → Network</strong><br>
          3. Go to the transactions page<br>
          4. Find a request to <strong>payments-tesseract.bharatpe.in</strong><br>
          5. Copy the <strong>token</strong> and <strong>Cookie</strong> headers
        </div>
      </div>

      <script>
        document.getElementById('setupForm').addEventListener('submit', async function(e) {
          e.preventDefault();
          const result = document.getElementById('result');
          const btn = e.target.querySelector('button');
          btn.disabled = true; btn.textContent = 'Creating...';

          try {
            const res = await fetch('/merchants', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: document.getElementById('name').value,
                upi_id: document.getElementById('upi').value,
                merchant_id: document.getElementById('mid').value,
                api_token: document.getElementById('token').value.trim(),
                api_cookie: document.getElementById('cookie').value.trim(),
              }),
            });
            const data = await res.json();
            if (res.ok) {
              result.innerHTML = '<div class="success">Merchant created! Redirecting to dashboard...</div>';
              setTimeout(() => window.location.href = '/', 1500);
            } else {
              result.innerHTML = '<div class="error">Error: ' + (data.error || 'Unknown') + '</div>';
              btn.disabled = false; btn.textContent = 'Create Merchant';
            }
          } catch(err) {
            result.innerHTML = '<div class="error">Error: ' + err.message + '</div>';
            btn.disabled = false; btn.textContent = 'Create Merchant';
          }
        });
      </script>
    </body>
    </html>
  `);
});

// ---- Merchants ----

app.get('/merchants', (req, res) => {
  try {
    const merchants = db.getActiveMerchants();
    res.json(merchants.map(m => ({
      id: m.id, name: m.name, upi_id: m.upi_id, merchant_id: m.merchant_id,
      poll_interval: m.poll_interval, timeout: m.timeout,
      created_at: m.created_at,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/merchants/:id', (req, res) => {
  try {
    const merchant = db.getMerchantById(req.params.id);
    if (!merchant) return res.status(404).json({ error: 'Merchant not found' });
    const { api_token, api_cookie, ...safe } = merchant;
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/merchants', (req, res) => {
  try {
    const { name, upi_id, merchant_id, api_token, api_cookie, bharatpe_api } = req.body;
    if (!name || !upi_id || !merchant_id || !api_token || !api_cookie) {
      return res.status(400).json({ error: 'Missing required fields: name, upi_id, merchant_id, api_token, api_cookie' });
    }
    const merchant = db.createMerchant({
      name, upi_id, merchant_id, api_token, api_cookie, bharatpe_api,
      user_agent: 'UPI-Demo/1.0',
    });
    paymentService.registerMerchant(merchant);
    const { api_token: _, api_cookie: __, ...safe } = merchant;
    res.status(201).json({ message: 'Merchant created', merchant: safe });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/merchants/:id', (req, res) => {
  try {
    const updated = db.updateMerchant(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Merchant not found' });
    paymentService.unregisterMerchant(req.params.id);
    paymentService.registerMerchant(updated);
    const { api_token, api_cookie, ...safe } = updated;
    res.json({ message: 'Merchant updated', merchant: safe });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/merchants/:id', (req, res) => {
  try {
    paymentService.unregisterMerchant(req.params.id);
    db.softDeleteMerchant(req.params.id);
    res.json({ message: 'Merchant deactivated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Payments ----

app.post('/payments', (req, res) => {
  try {
    const { merchant_id, amount, metadata } = req.body;
    if (!merchant_id || !amount) {
      return res.status(400).json({ error: 'Missing required fields: merchant_id, amount' });
    }
    const session = paymentService.createPayment(merchant_id, { amount: Number(amount), metadata });
    res.status(201).json({
      order_id: session.order_id,
      amount: session.base_amount,
      session_amount: session.session_amount,
      status: 'PENDING',
      qr_url: `${req.protocol}://${req.get('host')}/qr/${session.order_id}`,
      upi_uri: buildUpiUri(session.merchant?.upi_id || '', session.merchant?.name || '', session.session_amount, session.order_id),
      status_url: `${req.protocol}://${req.get('host')}/pay/${session.order_id}`,
      created_at: session.created_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/payments', (req, res) => {
  try {
    const { status, merchant_id, limit = 50, offset = 0 } = req.query;
    let query = 'SELECT * FROM payments WHERE 1=1';
    const params = [];
    if (status) { query += ' AND status = ?'; params.push(status); }
    if (merchant_id) { query += ' AND merchant_id = ?'; params.push(merchant_id); }
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(Number(limit), Number(offset));
    const rows = db.db.prepare(query).all(...params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/payments/:orderId', (req, res) => {
  try {
    const payment = paymentService.getPaymentDetails(req.params.orderId);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    const merchant = db.getMerchantById(payment.merchant_id);
    res.json({
      order_id: payment.order_id, merchant_id: payment.merchant_id,
      amount: payment.amount, session_amount: payment.session_amount,
      status: payment.status, utr: payment.utr, payer_vpa: payment.payer_vpa,
      payer_name: payment.payer_name, payer_handle: payment.payer_handle,
      created_at: payment.created_at, completed_at: payment.completed_at,
      merchant: merchant ? { name: merchant.name, upi_id: merchant.upi_id } : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/merchants/:merchantId/payments', (req, res) => {
  try {
    const result = paymentService.getMerchantPayments(req.params.merchantId, Number(req.query.page) || 1, Number(req.query.limit) || 20);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- QR & UPI ----

app.get('/qr/:orderId', async (req, res) => {
  try {
    const payment = db.getPaymentByOrderId(req.params.orderId);
    if (!payment) return res.status(404).send('Payment not found');
    const merchant = db.getMerchantById(payment.merchant_id);
    if (!merchant) return res.status(404).send('Merchant not found');
    const buffer = await generateQR(merchant.upi_id, merchant.name, payment.session_amount, payment.order_id);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-cache');
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Error generating QR');
  }
});

app.get('/payments/:orderId/qr', async (req, res) => {
  try {
    const payment = db.getPaymentByOrderId(req.params.orderId);
    if (!payment) return res.status(404).send('Payment not found');
    const merchant = db.getMerchantById(payment.merchant_id);
    const buffer = await generateQR(merchant.upi_id, merchant.name, payment.session_amount, payment.order_id);
    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `attachment; filename="qr-${payment.order_id}.png"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Error');
  }
});

app.get('/payments/:orderId/qr/uri', (req, res) => {
  try {
    const payment = db.getPaymentByOrderId(req.params.orderId);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    const merchant = db.getMerchantById(payment.merchant_id);
    res.json({ uri: buildUpiUri(merchant.upi_id, merchant.name, payment.session_amount, payment.order_id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Payment Status Page (SSE + fallback) ----

app.get('/pay/demo', async (req, res) => {
  try {
    const merchants = db.getActiveMerchants();
    if (!merchants.length) return res.redirect('/setup');
    const merchant = merchants[0];
    const session = paymentService.createPayment(merchant.id, { amount: 1.00, metadata: { demo: true } });
    res.redirect(`/pay/${session.order_id}`);
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

app.get('/pay/demo', async (req, res) => {
  try {
    const merchants = db.getActiveMerchants();
    if (!merchants.length) return res.redirect('/setup');
    const merchant = merchants[0];
    const session = await paymentService.createPayment(merchant.id, { amount: 1.00, metadata: { demo: true } });
    res.redirect(`/pay/${session.order_id}`);
  } catch (err) {
    res.status(500).send(`Error: ${err.message}<pre>${err.stack}</pre>`);
  }
});

app.get('/pay/:orderId', async (req, res) => {
  try {
    const payment = db.getPaymentByOrderId(req.params.orderId);
    if (!payment) return res.status(404).send('Payment not found');
    const merchant = db.getMerchantById(payment.merchant_id);
    const host = `${req.protocol}://${req.get('host')}`;
    const card = paymentCardHTML(payment, merchant, host, payment.order_id);
    const js = paymentCardJS(host, payment.order_id);

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>Pay ₹${payment.session_amount.toFixed(2)} — UPI Demo</title>
  <meta name="description" content="Scan QR or open UPI app to pay">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); min-height: 100vh; min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: white; border-radius: 24px; box-shadow: 0 25px 50px rgba(0,0,0,0.3); padding: 32px; max-width: 380px; width: 100%; text-align: center; position: relative; overflow: hidden; }
    .card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px; background: #f59e0b; transition: background 0.5s; }
    .card.success::before { background: #10b981; }
    .status { display: inline-block; padding: 5px 16px; border-radius: 20px; color: white; font-weight: 700; font-size: 12px; background: #f59e0b; letter-spacing: 0.5px; margin-bottom: 16px; }
    .amount { font-size: 44px; font-weight: 800; color: #0f172a; margin: 8px 0; letter-spacing: -1px; }
    .label { color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; font-weight: 600; margin-top: 4px; }
    .qr-section { margin: 20px auto; position: relative; display: inline-block; }
    .qr-img { max-width: 220px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); transition: opacity 0.3s; }
    .qr-text { color: #64748b; font-size: 13px; margin-top: 10px; font-weight: 500; }
    .vpa-row { display: flex; justify-content: center; align-items: center; gap: 8px; margin-top: 16px; padding: 10px 16px; background: #f8fafc; border-radius: 10px; }
    .vpa-label { color: #94a3b8; font-size: 12px; font-weight: 600; }
    .vpa-value { color: #1e293b; font-size: 13px; font-weight: 500; font-family: monospace; }
    .details { text-align: left; margin-top: 20px; border-top: 1px solid #f1f5f9; padding-top: 16px; }
    .detail-row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px; }
    .detail-row span:first-child { color: #94a3b8; }
    .detail-row .mono { color: #334155; font-family: monospace; font-size: 12px; }
    .polling { margin-top: 16px; }
    .polling p { font-size: 12px; color: #94a3b8; margin-bottom: 8px; }
    .spinner { width: 20px; height: 20px; border: 2px solid #e2e8f0; border-top-color: #3b82f6; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .success-overlay { text-align: center; padding: 20px 0; }
    .success-icon { font-size: 56px; margin-bottom: 12px; animation: pop 0.4s ease; }
    @keyframes pop { 0% { transform: scale(0); } 70% { transform: scale(1.2); } 100% { transform: scale(1); } }
    .success-amount { font-size: 32px; font-weight: 800; color: #10b981; }
    .success-label { color: #64748b; font-size: 14px; margin-top: 4px; font-weight: 500; }

    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div class="card" id="card">
    <div class="status" id="status">${payment.status}</div>
    <div class="amount" id="amount">₹${payment.session_amount.toFixed(2)}</div>
    <div class="label">Amount</div>
    ${card}
    <div class="polling" id="polling">
      <p>Waiting for payment...</p>
      <div class="spinner"></div>
    </div>
    <div class="success-overlay hidden" id="success-overlay">
      <div class="success-icon">✓</div>
      <div class="success-amount">₹${payment.session_amount.toFixed(2)}</div>
      <div class="success-label">Payment Successful!</div>
    </div>
  </div>
  ${js}
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Error');
  }
});

// ---- Dashboard ----

app.get('/', (req, res) => {
  const merchants = db.getActiveMerchants();
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UPI Demo — Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
    .header { background: #1e293b; padding: 20px 32px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #334155; }
    .header h1 { font-size: 20px; }
    .header .tag { background: #3b82f6; color: white; padding: 4px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; }
    .container { max-width: 960px; margin: 0 auto; padding: 32px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; margin-top: 24px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 24px; transition: transform 0.2s, border-color 0.2s; }
    .card:hover { transform: translateY(-2px); border-color: #3b82f6; }
    .card h3 { font-size: 16px; margin-bottom: 4px; }
    .card .vpa { color: #64748b; font-family: monospace; font-size: 13px; margin-bottom: 12px; }
    .btn { display: inline-block; padding: 10px 20px; background: #3b82f6; color: white; text-decoration: none; border-radius: 10px; font-size: 14px; font-weight: 600; transition: background 0.2s; }
    .btn:hover { background: #2563eb; }
    .btn.secondary { background: #334155; }
    .btn.secondary:hover { background: #475569; }
    .btn.small { padding: 6px 14px; font-size: 12px; border-radius: 8px; }
    .setup-card { background: linear-gradient(135deg, #1e293b 0%, #334155 100%); border: 2px dashed #475569; text-align: center; padding: 48px 24px; }
    .setup-card a { color: #3b82f6; }
    .actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
    .empty { text-align: center; padding: 60px 20px; color: #64748b; }
    .empty h2 { color: #94a3b8; margin-bottom: 8px; }
    .api-section { margin-top: 32px; padding-top: 24px; border-top: 1px solid #334155; }
    .api-section h2 { font-size: 14px; color: #64748b; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
    .endpoint { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-family: monospace; font-size: 13px; }
    .method { background: #10b981; color: #0f172a; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; }
    .method.post { background: #f59e0b; }
    .method.delete { background: #ef4444; }
    .path { color: #e2e8f0; }
  </style>
</head>
<body>
  <div class="header">
    <h1>UPI Demo Dashboard</h1>
    <span class="tag">${merchants.length} Merchant${merchants.length !== 1 ? 's' : ''} Active</span>
  </div>
  <div class="container">
    ${merchants.length === 0 ? `
      <div class="empty">
        <h2>No Merchant Configured</h2>
        <p>Set up a BharatPe merchant account to start accepting payments.</p>
        <br>
        <a href="/setup" class="btn">Configure Merchant</a>
      </div>
    ` : `
      <div class="grid">
        ${merchants.map(m => `
          <div class="card">
            <h3>${m.name}</h3>
            <div class="vpa">${m.upi_id}</div>
            <a href="/pay/demo" class="btn">New Payment</a>
            <div class="actions">
              <a href="/pay/demo" class="btn secondary small">Test Payment</a>
            </div>
          </div>
        `).join('')}
        <div class="card setup-card">
          <h3 style="color:#64748b;margin-bottom:8px;">Add Merchant</h3>
          <p style="color:#64748b;font-size:13px;margin-bottom:16px;">Configure another BharatPe account</p>
          <a href="/setup" class="btn">Setup</a>
        </div>
      </div>
      <div class="api-section">
        <h2>Quick Links</h2>
        <div class="endpoint"><span class="method">GET</span><span class="path">/health</span></div>
        <div class="endpoint"><span class="method">GET</span><span class="path">/merchants</span></div>
        <div class="endpoint"><span class="method">GET</span><span class="path">/payments</span></div>
        <div class="endpoint"><span class="method post">POST</span><span class="path">/payments { "merchant_id": 1, "amount": 100 }</span></div>
        <div class="endpoint"><span class="method">GET</span><span class="path">/events/stream</span></div>
      </div>
    `}
  </div>
</body>
</html>`);
});

// ---- Events ----

app.get('/events/:orderId', (req, res) => {
  try {
    const payment = db.getPaymentByOrderId(req.params.orderId);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    const events = db.getEventsByPayment(payment.id);
    res.json({ order_id: req.params.orderId, events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/events/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ type: 'connected', message: 'SSE connected' });

  const onSuccess = (data) => send({ type: 'payment:success', ...data });
  const onExpired = (data) => send({ type: 'payment:expired', ...data });
  const onCredsExpired = (data) => send({ type: 'credentials:expired', ...data });

  paymentService.on('payment:success', onSuccess);
  paymentService.on('payment:expired', onExpired);
  paymentService.on('credentials:expired', onCredsExpired);

  req.on('close', () => {
    paymentService.off('payment:success', onSuccess);
    paymentService.off('payment:expired', onExpired);
    paymentService.off('credentials:expired', onCredsExpired);
  });
});

// ---- Merchant debug endpoints ----

app.get('/merchants/:id/credentials/check', async (req, res) => {
  try {
    const result = await paymentService.checkCredentials(req.params.id);
    res.json({ valid: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/merchants/:id/credentials/update', async (req, res) => {
  try {
    const { token, cookie } = req.body;
    const updated = await paymentService.updateMerchantCredentials(req.params.id, token, cookie);
    res.json({ updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/merchants/:id/poll', async (req, res) => {
  try {
    await paymentService.pollOnce(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/merchants/:id/poll-logs', (req, res) => {
  try {
    const rows = db.db.prepare(
      `SELECT * FROM polling_log WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 50`
    ).all(req.params.id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Enrich old payments ----

app.post('/payments/:orderId/enrich', async (req, res) => {
  try {
    const result = await paymentService.enrichPayment(req.params.orderId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Create demo payment (convenience route) ----

app.get('/pay/demo', (req, res) => {
  const merchants = db.getActiveMerchants();
  if (merchants.length === 0) return res.redirect('/setup');
  const merchant = merchants[0];
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UPI Demo — New Payment</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .form-card { background: #1e293b; border: 1px solid #334155; border-radius: 20px; padding: 40px; max-width: 400px; width: 100%; }
    h1 { font-size: 22px; margin-bottom: 4px; }
    .subtitle { color: #64748b; font-size: 14px; margin-bottom: 28px; }
    label { display: block; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #94a3b8; margin-bottom: 6px; margin-top: 18px; }
    input { width: 100%; padding: 12px 16px; background: #0f172a; border: 1px solid #334155; border-radius: 10px; color: #e2e8f0; font-size: 16px; outline: none; }
    input:focus { border-color: #3b82f6; }
    .amount-presets { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 8px; }
    .preset { padding: 10px; text-align: center; background: #0f172a; border: 1px solid #334155; border-radius: 8px; color: #94a3b8; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.15s; }
    .preset:hover, .preset.active { background: #3b82f6; border-color: #3b82f6; color: white; }
    button { width: 100%; padding: 14px; background: #3b82f6; color: white; border: none; border-radius: 10px; font-size: 16px; font-weight: 700; cursor: pointer; margin-top: 24px; transition: background 0.2s; }
    button:hover { background: #2563eb; }
    button:disabled { background: #475569; cursor: not-allowed; }
    .error { color: #ef4444; margin-top: 12px; font-size: 13px; }
    a { color: #3b82f6; text-decoration: none; }
  </style>
  </head>
  <body>
    <div class="form-card">
      <h1>New Payment</h1>
      <p class="subtitle">Enter amount for ${merchant.name}</p>
      <form id="paymentForm">
        <label>Amount (INR)</label>
        <div class="amount-presets">
          <div class="preset" data-amount="10">₹10</div>
          <div class="preset" data-amount="50">₹50</div>
          <div class="preset" data-amount="100">₹100</div>
          <div class="preset" data-amount="500">₹500</div>
        </div>
        <input type="number" id="amount" placeholder="Enter amount" step="0.01" min="1" max="50000" required style="margin-top:12px;" />
        <input type="hidden" id="merchant_id" value="${merchant.id}" />
        <button type="submit" id="submitBtn">Create Payment</button>
      </form>
      <div id="result"></div>
      <p style="margin-top:20px;text-align:center;"><a href="/">&larr; Dashboard</a></p>
    </div>
    <script>
      document.querySelectorAll('.preset').forEach(el => {
        el.addEventListener('click', () => {
          document.querySelectorAll('.preset').forEach(p => p.classList.remove('active'));
          el.classList.add('active');
          document.getElementById('amount').value = el.dataset.amount;
        });
      });
      document.getElementById('paymentForm').addEventListener('submit', async function(e) {
        e.preventDefault();
        const btn = document.getElementById('submitBtn');
        const result = document.getElementById('result');
        btn.disabled = true; btn.textContent = 'Creating...';

        try {
          const res = await fetch('/payments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              merchant_id: document.getElementById('merchant_id').value,
              amount: parseFloat(document.getElementById('amount').value),
            }),
          });
          const data = await res.json();
          if (res.ok) {
            result.innerHTML = '<div style="color:#10b981;margin-top:12px;font-size:14px;">Payment created! Redirecting...</div>';
            setTimeout(() => window.location.href = '/pay/' + data.order_id, 500);
          } else {
            result.innerHTML = '<div class="error">Error: ' + (data.error || 'Unknown') + '</div>';
            btn.disabled = false; btn.textContent = 'Create Payment';
          }
        } catch(err) {
          result.innerHTML = '<div class="error">Error: ' + err.message + '</div>';
          btn.disabled = false; btn.textContent = 'Create Payment';
        }
      });
    </script>
  </body>
  </html>`);
});

// ---- Boot: auto-register merchants and start polling ----

function boot() {
  try {
    const merchants = db.getActiveMerchants();
    merchants.forEach(m => {
      try { paymentService.registerMerchant(m); }
      catch (err) { console.error(`[WARN] Failed to boot merchant ${m.id}:`, err.message); }
    });
    console.log(`[OK] UPI Demo started on ${HOST}:${PORT}`);
    console.log(`[OK] Dashboard: http://localhost:${PORT}`);
    console.log(`[OK] Health:    http://localhost:${PORT}/health`);
    console.log(`[OK] Merchants: ${merchants.length} active`);
  } catch (err) {
    console.error('[FATAL] Boot failed:', err.message);
    console.error(err.stack);
  }
}

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err.message);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message, err.stack);
  process.exit(1);
});

const server = app.listen(PORT, HOST, boot);

server.on('error', (err) => {
  console.error('[FATAL] Server error:', err.message);
  process.exit(1);
});
