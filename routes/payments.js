// routes/payments.js
// Node. Uses razorpay npm package (npm i razorpay)
const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''; // must match Razorpay dashboard

if (!KEY_ID || !KEY_SECRET) {
  console.warn('Razorpay keys not set in env (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET). Payments will fail until configured.');
}

const razor = new Razorpay({
  key_id: KEY_ID,
  key_secret: KEY_SECRET
});

/**
 * Helper: convert rupees (decimal or integer or string) -> paise (integer)
 */
function rupeesToPaise(amountRupees) {
  if (amountRupees == null) return null;
  // parse as number, round to 2 decimals then *100
  const n = Number(amountRupees);
  if (!isFinite(n)) return null;
  const paise = Math.round(n * 100);
  return paise;
}

/**
 * POST /payments/create-order
 * Body expectation:
 *  {
 *    email, name,
 *    org: { name, location } (optional),
 *    messaging_mode: 'full'|'semi',
 *    chosen_users_count: number,
 *    expected_bookings_per_day: number
 *  }
 *
 * Server will compute price using fee_settings table (or fallback constants).
 */
router.post('/create-order', async (req, res) => {
  try {
    const body = req.body || {};
    const {
      email,
      name,
      org,
      messaging_mode,
      chosen_users_count = 0,
      expected_bookings_per_day = 0
    } = body;

    // simple validation
    if (!email) return res.status(400).json({ ok:false, error: 'email required' });

    // load fee settings (if your system has a fee_settings table)
    const feeRows = await db.query('SELECT key_name, value_decimal FROM fee_settings');
    const fees = {};
    (feeRows || []).forEach(r => fees[r.key_name] = Number(r.value_decimal || 0));

    // fallback default values if fee_settings missing
    const monthlyPlatformPerUser = fees.monthly_platform_fee_per_user || 100; // rupees
    const messageCostPerBooking = fees.message_cost_per_booking || 0.1; // rupees
    const annualFee = fees.annual_fee || 500; // rupees
    // If you have any other pricing rules, adapt here.

    // price calculation (same logic you used in signup.start-paid)
    const platform = (monthlyPlatformPerUser) * Number(chosen_users_count || 0);
    const messageCost = (messaging_mode === 'full')
      ? (Number(expected_bookings_per_day || 0) * messageCostPerBooking * 30)
      : 0;
    const totalRupees = Number(annualFee || 0) + Number(platform || 0) + Number(messageCost || 0);

    const amountPaise = rupeesToPaise(totalRupees);

    if (!amountPaise || amountPaise <= 0) {
      return res.status(400).json({ ok:false, error: 'invalid_amount', message: 'Create order failed: amount (rupees) is required and must be > 0' });
    }

    // Create a DB billing record (status pending) — so you can reconcile later
    const details = {
      email, name, org, messaging_mode, chosen_users_count, expected_bookings_per_day,
      computed: { annualFee, platform, messageCost, totalRupees }
    };

    const billingInsert = await db.query(
      'INSERT INTO billing_records (org_id, user_id, amount, details, status, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [null, null, totalRupees, JSON.stringify(details), 'pending']
    );
    // get billing id (mysql insertId)
    const billingInsertObj = Array.isArray(billingInsert) ? billingInsert[0] : billingInsert;
    const billingId = billingInsertObj.insertId || billingInsertObj.insert_id || null;

    // create Razorpay order
    const orderPayload = {
      amount: amountPaise,       // paise (integer)
      currency: 'INR',
      receipt: 'bill_' + (billingId || Math.floor(Math.random()*1e6)),
      notes: {
        billing_id: billingId ? String(billingId) : '',
        email: email || '',
        name: name || ''
      }
    };

    const order = await razor.orders.create(orderPayload);

    // update billing record with razorpay order id
    if (billingId) {
      await db.query('UPDATE billing_records SET external_order_id = ?, updated_at = NOW() WHERE id = ?', [order.id, billingId]);
    }

    return res.json({
      ok: true,
      order: {
        id: order.id,
        amount: order.amount,
        currency: order.currency,
        receipt: order.receipt
      },
      razor_key_id: KEY_ID
    });
  } catch (err) {
    console.error('POST /payments/create-order error', err && err.message ? err.message : err);
    return res.status(500).json({ ok:false, error: err.message || String(err) });
  }
});

/**
 * Simple GET to check keys (debug)
 */
router.get('/test-keys', (req, res) => {
  res.json({ ok:true, key_id: process.env.RAZORPAY_KEY_ID ? true : false });
});

/**
 * Webhook handler (raw body verification should be done by index.js before parse)
 * We export handler so index.js can call it when route receives raw body.
 *
 * The handler expects:
 *  - req.body is a Buffer (raw) or a string
 *  - header 'x-razorpay-signature' contains signature
 */
async function webhookHandler(req, res) {
  try {
    const signature = req.headers['x-razorpay-signature'] || req.headers['X-Razorpay-Signature'];
    const rawBody = req.body; // should be Buffer because index.js used express.raw
    if (!signature || !rawBody) {
      console.warn('Webhook missing signature or body');
      return res.status(400).send('invalid webhook');
    }

    // compute expected signature
    const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
    hmac.update(rawBody);
    const expected = hmac.digest('hex');

    if (expected !== signature) {
      console.warn('Webhook signature mismatch', { expected, got: signature });
      return res.status(400).send('signature mismatch');
    }

    // parse JSON after verification
    const payload = JSON.parse(rawBody.toString('utf8'));
    // Example: payload.event = 'payment.captured'
    const ev = payload.event || (payload && payload.payload && payload.payload.payment && payload.payload.payment.entity && payload.payload.payment.entity.status) || '';
    console.log('Razorpay webhook received:', ev);

    // react to common events
    if (payload.event === 'payment.captured' || payload.event === 'payment.authorized') {
      const payment = (payload.payload && payload.payload.payment && payload.payload.payment.entity) || null;
      if (payment) {
        const orderId = payment.order_id || null;
        const amount = payment.amount; // paise
        const paymentId = payment.id;
        const status = payment.status;

        // update billing_records by external_order_id
        if (orderId) {
          // set record as paid / store payment info
          await db.query('UPDATE billing_records SET status=?, external_payment_id=?, executed_at=NOW(), updated_at=NOW() WHERE external_order_id = ?', ['paid', paymentId, orderId]);
        }

        // If there's a signup trial associated, mark it paid
        // (You may need to adapt SQL depending on your schema)
        if (orderId) {
          await db.query("UPDATE signup_trials SET payment_status='paid', updated_at=NOW() WHERE external_order_id = ?", [orderId]);
        }
      }
    }

    if (payload.event === 'payment.failed') {
      const payment = (payload.payload && payload.payload.payment && payload.payload.payment.entity) || null;
      if (payment && payment.order_id) {
        await db.query('UPDATE billing_records SET status=?, updated_at=NOW() WHERE external_order_id = ?', ['failed', payment.order_id]);
      }
    }

    // respond 200 quickly
    res.json({ ok:true });
  } catch (err) {
    console.error('webhookHandler error', err);
    res.status(500).send('server error');
  }
}

module.exports = { router, webhookHandler };
