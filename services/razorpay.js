// services/razorpay.js
// Thin wrapper around the Razorpay SDK + helpers for amount calc and order/event persistence.

require('dotenv').config();
const Razorpay = require('razorpay');
const crypto = require('crypto');
const db = require('./db');

const {
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  WEBHOOK_SECRET = 'change_me_webhook_secret'
} = process.env;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.warn('⚠️  Razorpay keys are missing. Payments will not work until you set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env');
}

const client = (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET)
  ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
  : null;

/** Create a Razorpay order (INR, amount in paise) */
async function createOrder({ amountPaise, currency = 'INR', receipt, notes = {} }) {
  if (!client) throw new Error('Razorpay client not configured');
  const order = await client.orders.create({
    amount: amountPaise,
    currency,
    receipt: receipt || `rcpt_${Date.now()}`,
    notes
  });
  // persist billing_orders minimal row
  await db.query(
    `INSERT INTO billing_orders (order_id, amount_paise, currency, receipt, notes_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE amount_paise=VALUES(amount_paise), currency=VALUES(currency),
     receipt=VALUES(receipt), notes_json=VALUES(notes_json), status=VALUES(status)`,
    [order.id, order.amount, order.currency, order.receipt, JSON.stringify(order.notes||{}), order.status || 'created']
  );
  return order;
}

/** Verify webhook signature; returns boolean */
function verifyWebhookSignature(payloadRaw, signature) {
  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  hmac.update(payloadRaw);
  const digest = hmac.digest('hex');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature || '', 'utf8'));
}

/** Store webhook event safely */
async function recordEvent(event) {
  const type = event?.event || 'unknown';
  const orderId = event?.payload?.order?.entity?.id || null;
  const paymentId = event?.payload?.payment?.entity?.id || null;
  const subscriptionId = event?.payload?.subscription?.entity?.id || null;
  await db.query(
    `INSERT INTO billing_events (event_type, order_id, payment_id, subscription_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [type, orderId, paymentId, subscriptionId, JSON.stringify(event)]
  );
  // Update order status if available
  const newStatus = event?.payload?.order?.entity?.status || null;
  if (orderId && newStatus) {
    await db.query(`UPDATE billing_orders SET status = ? WHERE order_id = ?`, [newStatus, orderId]);
  }
}

module.exports = {
  client,
  createOrder,
  verifyWebhookSignature,
  recordEvent
};
