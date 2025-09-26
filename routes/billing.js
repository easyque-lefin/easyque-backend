// routes/billing.js
// Minimal endpoints to list billing orders/events/records (admin-only surfaced later if needed).

const express = require('express');
const router = express.Router();
const db = require('../services/db');

router.get('/orders', async (_req, res, next) => {
  try {
    const [rows] = await db.query(`SELECT id, order_id, amount_paise, currency, receipt, status, created_at FROM billing_orders ORDER BY id DESC LIMIT 500`);
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

router.get('/events', async (_req, res, next) => {
  try {
    const [rows] = await db.query(`SELECT id, event_type, order_id, payment_id, subscription_id, created_at FROM billing_events ORDER BY id DESC LIMIT 500`);
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

router.get('/records', async (_req, res, next) => {
  try {
    const [rows] = await db.query(`SELECT id, org_id, amount, tax, total, cycle_date, created_at FROM billing_records ORDER BY id DESC LIMIT 500`);
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

module.exports = router;

