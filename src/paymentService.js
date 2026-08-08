/**
 * Payment Service for UPI Demo App
 * Delegates to @babuperumana/upipg-new's built-in paymentService,
 * adds VPA enrichment on top of what the package already provides.
 */

const { paymentService: packageService } = require('@babuperumana/upipg-new');
const { EventEmitter } = require('events');
const axios = require('axios');
const db = require('./database');

const https = require('https');
const agent = new https.Agent({ keepAlive: true, maxSockets: 10 });
const bharatpeAxios = axios.create({ httpsAgent: agent, timeout: 15000 });

class PaymentService extends EventEmitter {
  constructor() {
    this.lastTxns = new Map();
    this._listenersAttached = false;
    this._onSuccess = (data) => this.emit('payment:success', data);
    this._onExpired = (data) => this.emit('payment:expired', data);
    this._onCredsExpired = (data) => this.emit('credentials:expired', data);
  }

  _ensureListeners() {
    if (this._listenersAttached) return;
    packageService.on('payment:success', this._onSuccess);
    packageService.on('payment:expired', this._onExpired);
    packageService.on('credentials:expired', this._onCredsExpired);
    this._listenersAttached = true;
  }

  registerMerchant(merchant) {
    this._ensureListeners();
    packageService.registerMerchant(merchant);
  }

  createPayment(merchantId, options) {
    const session = packageService.createPayment(merchantId, options);
    const payment = db.insertPayment(
      session.orderId, merchantId, session.baseAmount, session.sessionAmount, options.metadata || null
    );
    db.logEvent(payment.id, 'created', {
      orderId: session.orderId, baseAmount: session.baseAmount, sessionAmount: session.sessionAmount,
    });
    return { ...payment, qrBuffer: session.qrBuffer };
  }

  getPaymentDetails(orderId) {
    const payment = db.getPaymentByOrderId(orderId);
    if (!payment) return null;
    const events = db.getEventsByPayment(payment.id);
    const merchant = db.getMerchantById(payment.merchant_id);
    return { ...payment, events, merchant: merchant ? { name: merchant.name, upi_id: merchant.upi_id } : null };
  }

  getMerchantPayments(merchantId, page = 1, limit = 20) {
    return db.getPaymentsByMerchant(merchantId, page, limit);
  }

  async _fetchPayerVpa(merchantId, utr) {
    const merchant = db.getMerchantById(merchantId);
    if (!merchant) return null;

    const apiUrl = merchant.bharatpe_api || 'https://payments-tesseract.bharatpe.in/api/v1/merchant/transactions';
    const mid = Number(merchantId);
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
    return packageService.getStatus();
  }
}

module.exports = new PaymentService();
