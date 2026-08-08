/**
 * Payment Service for UPI Demo App
 * Uses @babuperumana/upipg UpiPG directly (bypasses the broken wrapper in upipg-new).
 * Handles per-merchant instances, polling, SQLite persistence, and VPA enrichment.
 */

const { EventEmitter } = require('events');
const { UpiPG } = require('@babuperumana/upipg');
const axios = require('axios');
const db = require('./database');

const https = require('https');
const agent = new https.Agent({ keepAlive: true, maxSockets: 10 });
const bharatpeAxios = axios.create({ httpsAgent: agent, timeout: 15000 });

class PaymentService extends EventEmitter {
  constructor() {
    super();
    this.gateways = new Map();       // mid → UpiPG instance
    this.pollIntervals = new Map();  // mid → interval handle
    this.pollLocks = new Map();      // mid → boolean
    this.lastTxns = new Map();       // mid → { txns, timestamp }
  }

  _mid(id) { return Number(id); }

  registerMerchant(merchant) {
    const mid = this._mid(merchant.id);
    if (this.gateways.has(mid)) this.unregisterMerchant(mid);

    const pg = new UpiPG({
      upiId: merchant.upi_id,
      merchantName: merchant.name,
      merchantId: merchant.merchant_id,
      apiToken: merchant.api_token,
      apiCookie: merchant.api_cookie,
      bharatpeApi: merchant.bharatpe_api || undefined,
      userAgent: merchant.user_agent,
      pollInterval: merchant.poll_interval || 5000,
      timeout: merchant.timeout || 300,
      minAmount: merchant.min_amount || 1.0,
      maxAmount: merchant.max_amount || 50000.0,
    });

    pg.on('success', (session) => {
      this._asyncHandleSuccess(mid, session).catch(err => {
        console.error(`Error in success handler for ${session.orderId}:`, err.message);
      });
    });
    pg.on('expired', (session) => this._handleExpired(mid, session));
    pg.on('credentials_expired', (err) => this._handleCredsExpired(mid));

    const doPoll = async () => {
      if (this.pollLocks.get(mid)) return;
      this.pollLocks.set(mid, true);
      try { await pg.pollOnce(); }
      catch (err) { if (/credentials/i.test(err.message)) console.error(`Credentials expired for merchant ${mid}`); }
      finally { this.pollLocks.set(mid, false); }
    };

    this.gateways.set(mid, { pg, config: merchant });
    this.pollLocks.set(mid, false);

    setTimeout(doPoll, 500);
    const pollTimer = setInterval(doPoll, merchant.poll_interval || 5000);
    this.pollIntervals.set(mid, pollTimer);
    return pg;
  }

  unregisterMerchant(merchantId) {
    const mid = this._mid(merchantId);
    const entry = this.gateways.get(mid);
    if (entry) { entry.pg.stopPolling(); this.gateways.delete(mid); }
    const timer = this.pollIntervals.get(mid);
    if (timer) { clearInterval(timer); this.pollIntervals.delete(mid); }
    this.pollLocks.delete(mid);
  }

  createPayment(merchantId, options) {
    const mid = this._mid(merchantId);
    let entry = this.gateways.get(mid);
    if (!entry) {
      const merchant = db.getMerchantById(mid);
      if (!merchant) throw new Error('Merchant not found');
      this.registerMerchant(merchant);
      entry = this.gateways.get(mid);
    }
    if (!entry) throw new Error('Failed to initialize payment gateway');

    const session = await entry.pg.createPayment(options);
    if (!session || !session.orderId) {
      throw new Error(`UpiPG returned invalid session: ${JSON.stringify(session)}`);
    }

    // Insert into demo's SQLite DB (UpiPG doesn't persist to DB)
    const payment = db.insertPayment(
      session.orderId, mid, session.baseAmount, session.sessionAmount, options.metadata || null
    );
    db.logEvent(payment.id, 'created', {
      orderId: session.orderId, baseAmount: session.baseAmount, sessionAmount: session.sessionAmount,
    });

    return {
      order_id: session.orderId,
      merchant_id: mid,
      amount: session.baseAmount,
      session_amount: session.sessionAmount,
      status: 'PENDING',
      qrBuffer: session.qrBuffer,
      created_at: payment.created_at,
    };
  }

  getPaymentDetails(orderId) {
    const payment = db.getPaymentByOrderId(orderId);
    if (!payment) return null;
    const events = db.getEventsByPayment(payment.id);
    const merchant = db.getMerchantById(payment.merchant_id);
    return { ...payment, events, merchant: merchant ? { name: merchant.name, upi_id: merchant.upi_id } : null };
  }

  getMerchantPayments(merchantId, page = 1, limit = 20) {
    return db.getPaymentsByMerchant(this._mid(merchantId), page, limit);
  }

  async pollOnce(merchantId) {
    const mid = this._mid(merchantId);
    const entry = this.gateways.get(mid);
    if (!entry) throw new Error('Merchant gateway not initialized');
    await entry.pg.pollOnce();
  }

  async checkCredentials(merchantId) {
    const mid = this._mid(merchantId);
    const entry = this.gateways.get(mid);
    if (!entry) throw new Error('Merchant gateway not initialized');
    return entry.pg.checkCredentials();
  }

  async updateMerchantCredentials(merchantId, token, cookie) {
    const mid = this._mid(merchantId);
    const merchant = db.getMerchantById(mid);
    if (!merchant) throw new Error('Merchant not found');
    const updated = db.updateMerchant(mid, { api_token: token, api_cookie: cookie });
    if (updated) { this.unregisterMerchant(mid); this.registerMerchant(updated); }
    return updated;
  }

  async _fetchPayerVpa(merchantId, utr) {
    const merchant = db.getMerchantById(merchantId);
    if (!merchant) return null;

    const apiUrl = merchant.bharatpe_api || 'https://payments-tesseract.bharatpe.in/api/v1/merchant/transactions';
    const mid = this._mid(merchantId);
    let txns;
    const cached = this.lastTxns.get(mid);
    if (cached && Date.now() - cached.timestamp < 10000) {
      txns = cached.txns;
    } else {
      const now = new Date();
      const istOffset = 5.5 * 60 * 60 * 1000;
      const nowIst = new Date(now.getTime() + istOffset);
      const fromIst = new Date(nowIst.getTime() - 2 * 24 * 60 * 60 * 1000);
      const fmt = (d) => d.toISOString().split('T')[0];
      const listRes = await bharatpeAxios.get(apiUrl, {
        params: { module: 'PAYMENT_QR', merchantId: merchant.merchant_id, sDate: fmt(fromIst), eDate: fmt(nowIst) },
        headers: { token: merchant.api_token, Cookie: merchant.api_cookie, 'User-Agent': merchant.user_agent },
      });
      txns = listRes.data?.data?.transactions || [];
      this.lastTxns.set(mid, { txns, timestamp: Date.now() });
    }

    const matched = txns.find(tx => tx.bankReferenceNo === utr && tx.status === 'SUCCESS');
    if (!matched || !matched.id) return null;

    const detailUrl = `${apiUrl}/${matched.id}`;
    const detailRes = await bharatpeAxios.get(detailUrl, {
      params: { module: 'PAYMENT_QR', merchantId: merchant.merchant_id },
      headers: { token: merchant.api_token, Cookie: merchant.api_cookie, 'User-Agent': merchant.user_agent },
    });
    return detailRes.data?.data?.payerVpa || null;
  }

  async _asyncHandleSuccess(merchantId, session) {
    const payment = db.getPaymentByOrderId(session.orderId);
    if (!payment || payment.status !== 'PENDING') return;

    let payerVpa = session.payerVpa;
    if (!payerVpa && session.utr) {
      try { payerVpa = await this._fetchPayerVpa(merchantId, session.utr); }
      catch (err) { console.error(`VPA enrichment failed for ${session.orderId}:`, err.message); }
    }

    db.markPaymentSuccess(session.orderId, session.utr, payerVpa, session.payerName, session.payerHandle);
    if (payment.id) db.logEvent(payment.id, 'success', {
      utr: session.utr, payerVpa, payerName: session.payerName, payerHandle: session.payerHandle,
    });
    this.emit('payment:success', { merchantId, orderId: session.orderId, session, payerVpa });
  }

  _handleExpired(merchantId, session) {
    const payment = db.getPaymentByOrderId(session.orderId);
    if (payment && payment.status === 'PENDING') {
      db.markPaymentExpired(session.orderId);
      if (payment.id) db.logEvent(payment.id, 'expired', { orderId: session.orderId });
      this.emit('payment:expired', { merchantId, orderId: session.orderId });
    }
  }

  _handleCredsExpired(merchantId) {
    this.emit('credentials:expired', { merchantId });
  }

  async enrichPayment(orderId) {
    const payment = db.getPaymentByOrderId(orderId);
    if (!payment) throw new Error('Payment not found');
    if (!payment.utr) throw new Error('Payment has no UTR yet');
    if (payment.payer_vpa) return { alreadyEnriched: true, payer_vpa: payment.payer_vpa };

    const payerVpa = await this._fetchPayerVpa(payment.merchant_id, payment.utr);
    if (payerVpa) {
      db.db.prepare('UPDATE payments SET payer_vpa = ? WHERE order_id = ?').run(payerVpa, orderId);
      db.logEvent(payment.id, 'vpa_enriched', { payer_vpa: payerVpa });
    }
    return { payer_vpa: payerVpa };
  }

  getStatus() {
    const statuses = [];
    this.gateways.forEach((entry, merchantId) => {
      const merchant = db.getMerchantById(merchantId);
      statuses.push({
        merchantId, merchantName: merchant?.name, upiId: merchant?.upi_id,
        isActive: merchant?.is_active, registered: true,
      });
    });
    return statuses;
  }

  reloadAll() {
    this.gateways.forEach((_, id) => this.unregisterMerchant(id));
    db.getActiveMerchants().forEach(m => this.registerMerchant(m));
  }
}

module.exports = new PaymentService();
