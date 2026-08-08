/**
 * QR Code & UPI deep-link generation for UPI Demo App
 */

const QRCode = require('qrcode');

const STATUS_COLORS = {
  PENDING: '#f59e0b',
  SUCCESS: '#10b981',
  FAILURE: '#ef4444',
  EXPIRED: '#6b7280',
};

function buildUpiUri(pa, pn, amount, orderId) {
  const p = encodeURIComponent(pa);
  const n = encodeURIComponent(pn);
  const t = encodeURIComponent(`Payment for ${orderId}`);
  return `upi://pay?pa=${p}&pn=${n}&am=${amount.toFixed(2)}&tr=${encodeURIComponent(orderId)}&tn=${t}&cu=INR`;
}

async function generateQR(pa, pn, amount, orderId) {
  const uri = buildUpiUri(pa, pn, amount, orderId);
  return QRCode.toBuffer(uri, {
    width: 600,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#1f2937', light: '#ffffff' },
  });
}

function paymentCardHTML(payment, merchant, host, orderId) {
  const statusColor = STATUS_COLORS[payment.status] || '#6b7280';
  const qrUrl = `${host}/qr/${orderId}`;
  const isPending = payment.status === 'PENDING';

  return `
  <div class="card" id="card">
    <div class="status" id="status">${payment.status}</div>
    <div class="amount" id="amount">₹${payment.session_amount.toFixed(2)}</div>

    <div class="qr-section" id="qr-section">
      <img class="qr-img" id="qr-img" src="${qrUrl}" alt="UPI QR" />
      <div class="qr-text">Scan with any UPI app</div>
    </div>

    <div class="vpa-row">
      <span class="vpa-label">Pay to:</span>
      <span class="vpa-value">${merchant.upi_id}</span>
    </div>

    <div class="details" id="details">
      <div class="detail-row"><span>Order</span><span class="mono">${orderId}</span></div>
      <div class="detail-row"><span>Created</span><span>${new Date(payment.created_at).toLocaleString()}</span></div>
      <div id="payment-fields"></div>
    </div>

    ${isPending ? `
      <div class="polling" id="polling">
        <div class="spinner"></div>
        <p class="poll-text">Waiting for payment...</p>
      </div>
    ` : ''}

    <div class="success-overlay hidden" id="success-overlay">
      <div class="success-icon">&#10003;</div>
      <div class="success-amount">₹${payment.session_amount.toFixed(2)}</div>
      <div class="success-label">Payment Successful!</div>
      <div id="success-fields"></div>
    </div>
  </div>`;
}

function paymentCardJS(host, orderId) {
  const apiHost = host;
  return `
  <script>
    const apiHost = "${apiHost}";
    const orderId = "${orderId}";
    const statusEl = document.getElementById('status');
    const qrSection = document.getElementById('qr-section');
    const pollingEl = document.getElementById('polling');
    const paymentFields = document.getElementById('payment-fields');
    const successOverlay = document.getElementById('success-overlay');
    const successFields = document.getElementById('success-fields');

    function addField(label, value) {
      const row = document.createElement('div');
      row.className = 'detail-row';
      row.innerHTML = '<span>' + label + '</span><span class="mono">' + value + '</span>';
      paymentFields.appendChild(row);
    }

    function showSuccess(data) {
      statusEl.textContent = 'SUCCESS';
      statusEl.style.background = '#10b981';
      qrSection.classList.add('hidden');
      pollingEl.classList.add('hidden');
      successOverlay.classList.remove('hidden');
      if (data.utr) addField('UTR', data.utr);
      if (data.payerVpa) addField('From', data.payerVpa);
      if (data.payerName) addField('Name', data.payerName);
      if (data.payerHandle) addField('via', data.payerHandle);
    }

    const evtSource = new EventSource(apiHost + '/events/stream');
    evtSource.addEventListener('payment:success', function(e) {
      const data = JSON.parse(e.data);
      if (data.orderId === orderId) showSuccess(data.session || data);
    });
    evtSource.onerror = function() {
      evtSource.close();
      startPolling();
    };

    function startPolling() {
      setInterval(async function() {
        try {
          const r = await fetch(apiHost + '/payments/' + orderId);
          const d = await r.json();
          if (d.status === 'SUCCESS' && d.utr) {
            showSuccess({ utr: d.utr, payerVpa: d.payer_vpa, payerName: d.payer_name, payerHandle: d.payer_handle });
          } else if (d.status !== 'PENDING') {
            statusEl.textContent = d.status;
          }
        } catch(e) {}
      }, 4000);
    }
  </script>`;
}

module.exports = {
  buildUpiUri, generateQR, STATUS_COLORS, paymentCardHTML, paymentCardJS,
};
