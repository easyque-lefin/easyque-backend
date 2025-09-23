// routes/payments.js
const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const db = require('../db');

const router = express.Router();

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

async function loadFeeSettings() {
  const rows = await db.query('SELECT key_name, value_decimal, value_text FROM fee_settings');
  const map = {};
  if (Array.isArray(rows)) {
    rows.forEach(r => {
      if (r.value_decimal !== null && r.value_decimal !== undefined && r.value_decimal !== '') map[r.key_name] = Number(r.value_decimal);
      else map[r.key_name] = r.value_text !== undefined && r.value_text !== null ? r.value_text : null;
    });
  }
  return map;
}

/**
 * Calculate rupees amount according to your rules:
 * - semi: initial = annual_fee + (expected_users * monthly_platform_fee_per_user)
 * - full: initial = (expected_bookings_per_day * message_cost_per_booking * 30) + trial_extra(if any)
 */
function calculateAmountRupees(payload = {}, feeSettings = {}) {
  const messaging_mode = payload.messaging_mode || 'semi';
  const expected_users = Number(payload.expected_users || 0);
  const expected_bookings_per_day = Number(payload.expected_bookings_per_day || 0);
  const trial_message_count = Number(payload.trial_message_count || 0);

  const annual_fee = Number(feeSettings['annual_fee'] || 0);
  const monthly_platform_fee_per_user = Number(feeSettings['monthly_platform_fee_per_user'] || 0);
  const message_cost_per_booking = Number(feeSettings['message_cost_per_booking'] || 0);

  if (messaging_mode === 'semi') {
    const initial = annual_fee + (expected_users * monthly_platform_fee_per_user);
    return Math.max(0, Math.round(initial));
  } else {
    const estimated_message_cost_30 = expected_bookings_per_day * message_cost_per_booking * 30;
    const trial_extra = trial_message_count * message_cost_per_booking;
    const initial = estimated_message_cost_30 + trial_extra;
    return Math.max(0, Math.round(initial));
  }
}

// GET /payments/calc?messaging_mode=full&expected_users=10&expected_bookings_per_day=500
router.get('/calc', async (req, res) => {
  try {
    const { messaging_mode, expected_users, expected_bookings_per_day, trial_message_count } = req.query || {};
    const feeSettings = await loadFeeSettings();
    const amount_rupees = calculateAmountRupees({
      messaging_mode,
      expected_users: Number(expected_users || 0),
      expected_bookings_per_day: Number(expected_bookings_per_day || 0),
      trial_message_count: Number(trial_message_count || 0)
    }, feeSettings);
    return res.json({ ok: true, amount_rupees, feeSettings });
  } catch (err) {
    console.error('GET /payments/calc error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'server error', details: err && err.message });
  }
});

// POST /payments/create-order
router.post('/create-order', async (req, res) => {
  try {
    const payload = req.body || {};
    const messaging_mode = payload.messaging_mode || 'semi';
    const expected_users = Number(payload.expected_users || 0);
    const expected_bookings_per_day = Number(payload.expected_bookings_per_day || 0);
    const email = payload.email || null;
    const name = payload.name || null;
    const org_id = payload.org_id || null;
    const user_id = payload.user_id || null;

    const feeSettings = await loadFeeSettings();
    const amount_rupees = calculateAmountRupees({ messaging_mode, expected_users, expected_bookings_per_day, trial_message_count: payload.trial_message_count }, feeSettings);

    if (!amount_rupees || Number(amount_rupees) <= 0) {
      return res.status(400).json({ ok: false, error: 'Calculated amount must be > 0' });
    }

    const amount_paise = Math.round(Number(amount_rupees) * 100);

    const detailsObj = {
      messaging_mode,
      expected_users,
      expected_bookings_per_day,
      feeSettingsSnapshot: feeSettings,
      flow: payload.flow || 'signup'
    };

    const insertSql = `INSERT INTO billing_records
      (org_id, user_id, amount, currency, details, status, created_at, updated_at)
      VALUES (?, ?, ?, 'INR', ?, 'pending', NOW(), NOW())`;
    const insertParams = [org_id, user_id, amount_rupees, JSON.stringify(detailsObj)];
    const insertRes = await db.query(insertSql, insertParams);

    const insertId = insertRes && (insertRes.insertId || (Array.isArray(insertRes) && insertRes[0] && insertRes[0].insertId)) ? (insertRes.insertId || insertRes[0].insertId) : (insertRes && insertRes.insertId ? insertRes.insertId : null);

    const orderOptions = {
      amount: amount_paise,
      currency: 'INR',
      receipt: `easyque_rcpt_${Date.now()}`,
      notes: {
        billing_record_id: insertId || null,
        email: email || '',
        name: name || ''
      }
    };

    const order = await razorpay.orders.create(orderOptions);

    try {
      await db.query('UPDATE billing_records SET external_order_id = ?, receipt = ?, updated_at = NOW() WHERE id = ?', [order.id, orderOptions.receipt, insertId]);
    } catch (uerr) {
      console.warn('Failed to update billing_records with external_order_id:', uerr && uerr.message);
    }

    return res.json({
      ok: true,
      order,
      razor_key_id: RAZORPAY_KEY_ID,
      billing_id: insertId,
      amount_rupees
    });
  } catch (err) {
    console.error('POST /payments/create-order error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'server error', details: err && err.message });
  }
});

// POST /payments/verify
router.post('/verify', async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature, billing_id } = req.body || {};
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({ ok: false, error: 'Missing payment verification fields' });
    }

    // verify signature using RAZORPAY_KEY_SECRET
    const h = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET);
    h.update(razorpay_order_id + '|' + razorpay_payment_id);
    const expectedSignature = h.digest('hex');

    if (expectedSignature !== razorpay_signature) {
      console.warn('Payment verify signature mismatch', { expectedSignature, razorpay_signature });
      return res.status(400).json({ ok: false, error: 'Invalid signature' });
    }

    let updateSql;
    let updateParams = [];
    if (billing_id) {
      updateSql = 'UPDATE billing_records SET status = ?, external_payment_id = ?, updated_at = NOW() WHERE id = ?';
      updateParams = ['paid', razorpay_payment_id, billing_id];
    } else {
      updateSql = 'UPDATE billing_records SET status = ?, external_payment_id = ?, updated_at = NOW() WHERE external_order_id = ?';
      updateParams = ['paid', razorpay_payment_id, razorpay_order_id];
    }

    await db.query(updateSql, updateParams);

    try {
      await db.query('UPDATE signup_trials SET payment_status = ? WHERE external_billing_id = ? OR external_billing_id = ?', ['paid', razorpay_order_id, razorpay_order_id]);
    } catch (e) {
      console.debug('signup_trials update skipped or failed:', e && e.message);
    }

    return res.json({ ok: true, message: 'Payment verified and billing recorded' });
  } catch (err) {
    console.error('POST /payments/verify error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'server error', details: err && err.message });
  }
});

// webhookHandler
async function webhookHandler(req, res) {
  try {
    const signature = req.headers['x-razorpay-signature'] || req.headers['x_razorpay_signature'] || '';
    if (!WEBHOOK_SECRET) {
      console.warn('WEBHOOK_SECRET not set; rejecting webhook for safety');
      return res.status(500).send('webhook secret not configured');
    }
    const body = req.body instanceof Buffer ? req.body.toString('utf8') : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

    if (!signature || expected !== signature) {
      console.warn('Webhook signature mismatch', { expected, signature });
      return res.status(400).send('invalid signature');
    }

    let event;
    try { event = JSON.parse(body); } catch (e) { event = req.body; }
    const eventType = (event.event || '').toLowerCase();

    if (eventType.startsWith('payment.')) {
      const payloadPayment = (event.payload && event.payload.payment && event.payload.payment.entity) || null;
      if (!payloadPayment) {
        console.warn('Webhook payment event missing payload', event);
        return res.status(200).send('no payment entity');
      }
      const orderId = payloadPayment.order_id || null;
      const paymentId = payloadPayment.id || null;
      const status = (payloadPayment.status || '').toLowerCase();

      if (orderId) {
        let newStatus = 'pending';
        if (status === 'captured') newStatus = 'paid';
        if (status === 'failed' || status === 'cancelled') newStatus = 'failed';
        if (status === 'authorized') newStatus = 'authorized';

        try {
          await db.query('UPDATE billing_records SET status = ?, external_payment_id = ?, updated_at = NOW() WHERE external_order_id = ?', [newStatus, paymentId, orderId]);
        } catch (uerr) {
          console.error('Webhook: failed updating billing_records', uerr && uerr.message);
        }

        try {
          await db.query('UPDATE signup_trials SET payment_status = ? WHERE external_billing_id = ? OR external_billing_id = ?', [newStatus === 'paid' ? 'paid' : newStatus, orderId, orderId]);
        } catch (e) { /* ignore */ }
      } else {
        console.warn('Webhook: payment without order_id', paymentId);
      }
    } else {
      console.log('Unhandled webhook event:', eventType);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('webhookHandler error', err && err.stack ? err.stack : err);
    return res.status(500).send('server error');
  }
}

module.exports = { router, webhookHandler };
