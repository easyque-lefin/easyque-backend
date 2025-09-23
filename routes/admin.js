// routes/admin.js
const express = require('express');
const db = require('../db');
const router = express.Router();

// GET /admin/fees
router.get('/fees', async (req, res) => {
  try {
    const rows = await db.query('SELECT key_name, value_decimal, value_text FROM fee_settings');
    const fees = {};
    (rows || []).forEach(r => {
      if (r.value_decimal !== null && r.value_decimal !== undefined) fees[r.key_name] = Number(r.value_decimal);
      else fees[r.key_name] = r.value_text;
    });
    res.json({ ok: true, fees });
  } catch (err) {
    console.error('GET /admin/fees error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /admin/fees  body: { fees: { annual_fee: 1000, monthly_platform_fee_per_user: 10, message_cost_per_booking: 0.05, free_trial_days: 7 } }
router.put('/fees', async (req, res) => {
  try {
    const payload = req.body && req.body.fees ? req.body.fees : null;
    if (!payload || typeof payload !== 'object') return res.status(400).json({ ok: false, error: 'fees object required' });

    const keys = Object.keys(payload);
    for (const k of keys) {
      const v = payload[k];
      if (v === null || v === undefined) continue;
      // numeric -> value_decimal, otherwise value_text
      if (typeof v === 'number' || (!isNaN(Number(v)) && String(v).trim() !== '')) {
        await db.query(
          'INSERT INTO fee_settings (key_name, value_decimal, updated_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE value_decimal = VALUES(value_decimal), updated_at = NOW()',
          [k, Number(v)]
        );
      } else {
        await db.query(
          'INSERT INTO fee_settings (key_name, value_text, updated_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE value_text = VALUES(value_text), updated_at = NOW()',
          [k, String(v)]
        );
      }
    }

    const rows = await db.query('SELECT key_name, value_decimal, value_text FROM fee_settings');
    const fees = {};
    (rows || []).forEach(r => {
      fees[r.key_name] = (r.value_decimal !== null && r.value_decimal !== undefined) ? Number(r.value_decimal) : r.value_text;
    });

    res.json({ ok: true, fees });
  } catch (err) {
    console.error('PUT /admin/fees error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
