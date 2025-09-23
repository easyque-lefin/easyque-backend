// routes/signup.js
const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const router = express.Router();

// helper
async function getFeeSettings() {
  const rows = await db.query('SELECT key_name, value_decimal, value_text FROM fee_settings');
  const map = {};
  (rows || []).forEach(r => {
    if (r.value_decimal !== null && r.value_decimal !== undefined) map[r.key_name] = Number(r.value_decimal);
    else map[r.key_name] = r.value_text;
  });
  return map;
}

// GET /signup/options
router.get('/options', async (req, res) => {
  try {
    const fees = await getFeeSettings();
    res.json({ ok: true, fees, free_trial_days: fees.free_trial_days || 7, modes: ['semi', 'full'] });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message });
  }
});

// POST /signup/start-trial
router.post('/start-trial', async (req, res) => {
  const { email, password, name, org, messaging_mode } = req.body;
  if (!email || !password) return res.status(400).json({ ok:false, error:'missing' });

  try {
    const exists = await db.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
    if (exists && exists.length) return res.status(400).json({ ok:false, error:'email_exists' });

    const orgRes = await db.query(
      'INSERT INTO organizations(name, location, created_at) VALUES(?, ?, NOW())',
      [org?.name || 'Organization', org?.location || null]
    );
    const insertObj = Array.isArray(orgRes) ? orgRes[0] : orgRes;
    const orgId = insertObj.insertId;

    const hash = await bcrypt.hash(password, 10);
    const userRes = await db.query(
      'INSERT INTO users(email,password,name,role,org_id,is_active,created_at) VALUES(?,?,?,?,?,?,NOW())',
      [email, hash, name || '', 'organization_admin', orgId, 1]
    );
    const userInsert = Array.isArray(userRes) ? userRes[0] : userRes;
    const userId = userInsert.insertId;

    const fees = await getFeeSettings();
    const now = new Date();
    const expires = new Date(now.getTime() + (fees.free_trial_days || 7) * 24 * 3600 * 1000);

    const trialRes = await db.query(
      'INSERT INTO signup_trials(user_id,org_id,mode,messaging_mode,trial_started_at,trial_expires_at,payment_status,created_at) VALUES(?,?,?,?,?,?,?,NOW())',
      [userId, orgId, 'trial', messaging_mode || 'semi', now, expires, 'pending']
    );
    const trialInsert = Array.isArray(trialRes) ? trialRes[0] : trialRes;
    const trialId = trialInsert.insertId;

    res.json({ ok:true, user:{ id: userId, email, role: 'organization_admin', org_id: orgId }, trial: { id: trialId, trial_expires_at: expires } });
  } catch (err) {
    console.error('start-trial error', err);
    res.status(500).json({ ok:false, error: err.message });
  }
});

// POST /signup/start-paid
router.post('/start-paid', async (req, res) => {
  const { email, password, name, org, messaging_mode, chosen_users_count, expected_bookings_per_day } = req.body;

  if (!email || !password) return res.status(400).json({ ok:false, error:'missing email/password' });

  try {
    const exists = await db.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
    if (exists && exists.length) return res.status(400).json({ ok:false, error:'email_exists' });

    const orgRes = await db.query('INSERT INTO organizations(name, created_at) VALUES(?, NOW())', [org?.name || 'Organization']);
    const orgInsert = Array.isArray(orgRes) ? orgRes[0] : orgRes;
    const orgId = orgInsert.insertId;

    const hash = await bcrypt.hash(password, 10);
    const userRes = await db.query(
      'INSERT INTO users(email,password,name,role,org_id,is_active,created_at) VALUES(?,?,?,?,?,?,NOW())',
      [email, hash, name || '', 'organization_admin', orgId, 1]
    );
    const userInsert = Array.isArray(userRes) ? userRes[0] : userRes;
    const userId = userInsert.insertId;

    const fees = await getFeeSettings();
    const annual = Number(fees.annual_fee || 0);
    const platform = Number(fees.monthly_platform_fee_per_user || 0) * Number(chosen_users_count || 0); // current logic
    const messageCost = (messaging_mode === 'full') ? (Number(expected_bookings_per_day || 0) * Number(fees.message_cost_per_booking || 0) * 30) : 0;
    const total = Number(annual) + Number(platform) + Number(messageCost);

    const details = { annual, platform, messageCost, chosen_users_count, expected_bookings_per_day, messaging_mode };

    const billingRes = await db.query(
      'INSERT INTO billing_records(org_id,user_id,amount,currency,status,details,created_at) VALUES(?,?,?,?,?,?,NOW())',
      [orgId, userId, total, 'INR', 'pending', JSON.stringify(details)]
    );
    const billingInsert = Array.isArray(billingRes) ? billingRes[0] : billingRes;
    const billingId = billingInsert.insertId;

    // Return a lightweight payment object (payments route can use it to create order)
    res.json({
      ok: true,
      billing: { id: billingId, amount: total, currency: 'INR', details },
      user: { id: userId, email }
    });
  } catch (err) {
    console.error('start-paid error', err);
    res.status(500).json({ ok:false, error: err.message });
  }
});

module.exports = router;
