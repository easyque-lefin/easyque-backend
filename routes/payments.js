// routes/payments.js
// Plan calculation + order creation + webhook verification + admin fees CRUD (simple)

const express = require('express');
const router = express.Router();
const db = require('../services/db');
const { createOrder, verifyWebhookSignature, recordEvent } = require('../services/razorpay');

// ---- Helpers to read fee settings
async function getFeesMap() {
  const [rows] = await db.query(`SELECT \`key\`, \`value\` FROM fee_settings`);
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  return map;
}

function asNumber(x, def = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}

// ---- POST /payments/calc  { mode, users_count, expected_bookings_per_day }
router.post('/calc', async (req, res, next) => {
  try {
    const { mode = 'semi', users_count = 1, expected_bookings_per_day = 0 } = req.body || {};
    const fees = await getFeesMap();

    const annual = asNumber(fees['option1.annual_fee'], 0);
    const monthlyPerUser = asNumber(fees['option1.monthly_per_user'], 0);
    const msgCost = asNumber(fees['option2.message_cost'], 1);
    const taxPct = asNumber(fees['tax.percent'], 0);

    let base = 0;
    let usage = 0;

    if (mode === 'semi') {
      base = annual + monthlyPerUser * asNumber(users_count, 1);
    } else {
      const perDay = asNumber(expected_bookings_per_day, 0);
      const monthlyExpected = perDay * 30;
      usage = msgCost * monthlyExpected;
      base = usage; // Option 2 base equals usage estimate
    }

    const tax = Math.round((base * taxPct) / 100);
    const total = base + tax;

    res.json({
      ok: true,
      inputs: { mode, users_count: Number(users_count), expected_bookings_per_day: Number(expected_bookings_per_day) },
      fees: { annual, monthlyPerUser, msgCost, taxPct },
      result: { base, usage, tax, total }
    });
  } catch (e) { next(e); }
});

// ---- POST /payments/create-order  { amount, currency, org_id, notes? }
router.post('/create-order', async (req, res, next) => {
  try {
    const { amount, currency = 'INR', org_id, notes = {} } = req.body || {};
    if (!amount || !org_id) return res.status(400).json({ ok: false, error: 'amount and org_id required' });
    const amountPaise = Math.round(Number(amount) * 100);
    const order = await createOrder({
      amountPaise,
      currency,
      notes: { ...notes, org_id: String(org_id) }
    });
    res.json({ ok: true, order });
  } catch (e) { next(e); }
});

// ---- POST /payments/webhook  (Razorpay -> our server)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const payloadRaw = req.body; // Buffer
    const payloadStr = payloadRaw.toString('utf8');

    if (!verifyWebhookSignature(payloadStr, signature)) {
      return res.status(400).json({ ok: false, error: 'Invalid signature' });
    }

    const event = JSON.parse(payloadStr);
    await recordEvent(event);

    // When payment is captured for an order, mark org paid (and set cycle day)
    if (event.event === 'payment.captured') {
      const orderId = event?.payload?.payment?.entity?.order_id || event?.payload?.order?.entity?.id;
      if (orderId) {
        const [[ord]] = await db.query(`SELECT notes_json FROM billing_orders WHERE order_id = ? LIMIT 1`, [orderId]);
        const notes = ord?.notes_json ? JSON.parse(ord.notes_json) : {};
        const org_id = Number(notes.org_id || 0);
        if (org_id) {
          await db.query(`UPDATE organizations SET is_paid = 1, billing_cycle_day = DAY(CURDATE()) WHERE id = ?`, [org_id]);
        }
      }
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('Webhook error', e);
    res.status(500).json({ ok: false });
  }
});

// ---- Admin fees CRUD (simple)
router.get('/admin/fees', async (_req, res, next) => {
  try {
    const [rows] = await db.query(`SELECT id, \`key\`, \`value\` FROM fee_settings ORDER BY \`key\``);
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

router.post('/admin/fees', async (req, res, next) => {
  try {
    const { key, value } = req.body || {};
    if (!key) return res.status(400).json({ ok: false, error: 'key required' });
    await db.query(
      `INSERT INTO fee_settings (\`key\`, \`value\`) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE \`value\`=VALUES(\`value\`)`,
      [key, String(value ?? '')]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
