// routes/billing.js
// Billing endpoints: create Razorpay order (skeleton), create subscription record, handle webhook
const express = require('express');
const db = require('../db');
const config = require('../config');

const router = express.Router();

/**
 * POST /billing/create-order
 * Body: { org_id, amount, currency, receipt }
 * Returns a Razorpay order object (if credentials present) or simulated order
 */
router.post('/create-order', async (req, res) => {
  try {
    const { org_id, amount, currency, receipt } = req.body || {};
    if (!org_id || !amount) return res.status(400).json({ ok:false, error:'org_id_and_amount_required' });

    // If Razorpay credentials present in config, call Razorpay to create an order.
    const keyId = process.env.RAZORPAY_KEY_ID || config.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET || config.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      // simulate an order (for dev)
      const order = {
        id: 'sim_' + Date.now(),
        amount: amount,
        currency: currency || 'INR',
        receipt: receipt || `rcpt_${Date.now()}`
      };
      // store minimal order record in DB if you want
      try {
        await db.query('INSERT INTO billing_orders (org_id, provider_order_id, amount, currency, created_at) VALUES (?, ?, ?, ?, NOW())', [org_id, order.id, amount, currency || 'INR']);
      } catch (e) {
        // ignore if table missing
      }
      return res.json({ ok:true, order, simulated: true });
    }

    // TODO: implement Razorpay SDK call here. Example with razorpay package:
    // const Razorpay = require('razorpay');
    // const rp = new Razorpay({ key_id: keyId, key_secret: keySecret });
    // const order = await rp.orders.create({ amount: amount, currency: currency || 'INR', receipt: receipt });
    // Save order to DB and return.

    return res.status(501).json({ ok:false, error:'not_implemented', message:'Razorpay integration not yet configured. Add keys to .env and enable code.' });
  } catch (err) {
    console.error('POST /billing/create-order error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

/**
 * POST /billing/webhook
 * Razorpay webhook endpoint (verify using WEBHOOK_SECRET)
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // optional: verify signature with process.env.WEBHOOK_SECRET
    // For now accept and return 200
    const payload = req.body;
    // TODO parse and update billing_orders or subscriptions accordingly
    console.log('billing webhook received');
    res.status(200).send('ok');
  } catch (err) {
    console.error('POST /billing/webhook error', err);
    res.status(500).send('error');
  }
});

module.exports = router;
