// routes/billing.js
const express = require('express');
const db = require('../db');
const config = require('../config');
const Razorpay = require('razorpay');

const router = express.Router();

const razor = new Razorpay({
  key_id: config.razorpayKeyId,
  key_secret: config.razorpayKeySecret
});

/**
 * POST /billing/create-order
 * body: { org_id, amount, currency, receipt_note }
 * Creates a razorpay order for manual payment (called from frontend).
 */
router.post('/create-order', async (req, res) => {
  try {
    const { org_id, amount, currency, receipt_note } = req.body;
    if (!org_id || !amount) return res.status(400).json({ ok:false, error:'org_id_and_amount_required' });

    const order = await razor.orders.create({
      amount: Math.round(amount * 100), // in paise
      currency: currency || 'INR',
      receipt: `org_${org_id}_${Date.now()}`,
      payment_capture: 1
    });

    // store payment intent in payments table
    await db.query('INSERT INTO payments (org_id, provider, provider_order_id, amount, currency, status, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
      [org_id, 'razorpay', order.id, amount, currency || 'INR', 'created']);

    return res.json({ ok:true, order });
  } catch (err) {
    console.error('POST /billing/create-order error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

/**
 * POST /billing/webhook/razorpay
 * Razorpay webhook receiver: set your webhook secret in environment/webhook config
 * This endpoint expects to be called by Razorpay to confirm payments.
 */
router.post('/webhook/razorpay', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // For production verify signature using webhook secret.
    const event = JSON.parse(req.body.toString());
    // handle payment authorized/captured events
    if (event && event.event === 'payment.captured') {
      const payload = event.payload.payment.entity;
      // update payments table
      await db.query('UPDATE payments SET status = ?, provider_payment_id = ?, updated_at = NOW() WHERE provider_order_id = ?',
        ['completed', payload.id, payload.order_id]);
      // find org via order -> payment -> billing logic as needed
    }
    res.json({ ok:true });
  } catch (err) {
    console.error('POST /billing/webhook/razorpay error', err);
    res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

/**
 * POST /billing/schedule-recurring
 * Admin or org creates recurring billing events.
 * body: { org_id, amount, interval_days }
 */
router.post('/schedule-recurring', async (req, res) => {
  try {
    const { org_id, amount, interval_days } = req.body;
    if (!org_id || !amount || !interval_days) return res.status(400).json({ ok:false, error:'fields_required' });
    const next = new Date(Date.now() + (interval_days * 24 * 3600 * 1000));
    await db.query('INSERT INTO billing_events (org_id, amount, currency, scheduled_at, status, created_at) VALUES (?, ?, ?, ?, "scheduled", NOW())', [org_id, amount, 'INR', next]);
    return res.json({ ok:true, message:'billing_scheduled', next });
  } catch (err) {
    console.error('POST /billing/schedule-recurring error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

/**
 * POST /billing/execute-pending
 * Admin endpoint to run billing event executor now (cron-style).
 * This will attempt to charge each scheduled billing_event.
 * For safety this endpoint should be protected; here it's open for convenience.
 */
router.post('/execute-pending', async (req, res) => {
  try {
    // find due events
    const due = await db.query('SELECT * FROM billing_events WHERE scheduled_at <= NOW() AND status = "scheduled"');
    const results = [];
    for (const e of due) {
      // For each, attempt to charge via stored payment method (not implemented) or create a razorpay order and mark as attempted.
      // For now, mark executed and create billing_record as placeholder.
      await db.query('UPDATE billing_events SET status = "executing", updated_at = NOW() WHERE id = ?', [e.id]);
      await db.query('INSERT INTO billing_records (org_id, billing_event_id, amount, currency, status, created_at) VALUES (?, ?, ?, ?, ?, NOW())', [e.org_id, e.id, e.amount, e.currency||'INR', 'attempted']);
      await db.query('UPDATE billing_events SET status = "completed", executed_at = NOW(), updated_at = NOW() WHERE id = ?', [e.id]);
      results.push({ id: e.id, status: 'completed' });
    }
    return res.json({ ok:true, results });
  } catch (err) {
    console.error('POST /billing/execute-pending error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

module.exports = router;
