// routes/signup.js
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require("../services/db");
const router = express.Router();

/**
 * POST /signup/complete
 * Body:
 *  {
 *    name, email, password,
 *    org_name (optional),
 *    billing_id (optional - numeric id returned by create-order),
 *    external_order_id (optional - razorpay order id),
 *    messaging_mode ('semi'|'full'),
 *    expected_users, expected_bookings_per_day
 *  }
 */
router.post('/complete', async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      org_name,
      billing_id,
      external_order_id,
      messaging_mode,
      expected_users,
      expected_bookings_per_day,
      signup_option
    } = req.body || {};

    if (!email || !password || !name) {
      return res.status(400).json({ ok: false, error: 'name, email and password are required' });
    }

    // 1) create organization
    const orgName = org_name || `${name}'s Org`;
    const slugBase = (orgName || email).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
    // ensure unique slug (append random suffix if necessary)
    let slug = slugBase;
    let slugTry = 0;
    while (true) {
      const existing = await db.query('SELECT id FROM organizations WHERE slug = ? LIMIT 1', [slug]);
      if (!Array.isArray(existing) || existing.length === 0) break;
      slugTry += 1;
      slug = `${slugBase}-${Math.floor(Math.random() * 9000 + 1000)}`;
      if (slugTry > 5) break;
    }

    const createOrgRes = await db.query('INSERT INTO organizations (name, slug, created_at) VALUES (?, ?, NOW())', [orgName, slug]);
    const org_id = createOrgRes && (createOrgRes.insertId || (Array.isArray(createOrgRes) && createOrgRes[0] && createOrgRes[0].insertId)) ? (createOrgRes.insertId || createOrgRes[0].insertId) : (createOrgRes && createOrgRes.insertId ? createOrgRes.insertId : null);

    // 2) create user (admin) - store bcrypt hash in password_hash
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);

    const createUserSql = 'INSERT INTO users (uid, org_id, name, email, password, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, NOW(), NOW())';
    const uid = `u_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const createUserRes = await db.query(createUserSql, [uid, org_id, name, email, password_hash, 'admin']);
    const user_id = createUserRes && (createUserRes.insertId || (Array.isArray(createUserRes) && createUserRes[0] && createUserRes[0].insertId)) ? (createUserRes.insertId || createUserRes[0].insertId) : (createUserRes && createUserRes.insertId ? createUserRes.insertId : null);

    // 3) create signup_trials record
    // Calculate trial start/expiry using fee_settings free_trial_days
    let freeTrialDays = 7;
    try {
      const f = await db.query('SELECT value_decimal FROM fee_settings WHERE key_name = ? LIMIT 1', ['free_trial_days']);
      if (Array.isArray(f) && f.length) freeTrialDays = Number(f[0].value_decimal) || freeTrialDays;
    } catch (e) { /* ignore */ }

    const now = new Date();
    const trial_started_at = now.toISOString().slice(0, 19).replace('T', ' ');
    let trial_expires_at = null;
    if (!signup_option || signup_option === 'trial') {
      // set expiry after freeTrialDays
      const expiry = new Date(now.getTime() + (freeTrialDays * 24 * 60 * 60 * 1000));
      trial_expires_at = expiry.toISOString().slice(0, 19).replace('T', ' ');
    }

    const insertTrialSql = `INSERT INTO signup_trials
      (user_id, org_id, signup_option, messaging_mode, expected_users, expected_bookings_per_day, trial_started_at, trial_expires_at, payment_status, external_billing_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`;
    const trialVals = [user_id, org_id, signup_option || 'signup_now', messaging_mode || 'semi', expected_users || null, expected_bookings_per_day || null, trial_started_at, trial_expires_at, 'pending', external_order_id || billing_id || null];
    const trialRes = await db.query(insertTrialSql, trialVals);
    const trial_id = trialRes && (trialRes.insertId || (Array.isArray(trialRes) && trialRes[0] && trialRes[0].insertId)) ? (trialRes.insertId || trialRes[0].insertId) : (trialRes && trialRes.insertId ? trialRes.insertId : null);

    // 4) update billing_records to attach org_id and user_id and maybe external_billing link
    try {
      if (billing_id) {
        await db.query('UPDATE billing_records SET org_id = ?, user_id = ?, updated_at = NOW() WHERE id = ?', [org_id, user_id, billing_id]);
      } else if (external_order_id) {
        await db.query('UPDATE billing_records SET org_id = ?, user_id = ?, updated_at = NOW() WHERE external_order_id = ?', [org_id, user_id, external_order_id]);
      }
    } catch (uerr) {
      console.warn('Failed to attach billing record:', uerr && uerr.message);
    }

    // return success with user and trial info
    return res.json({
      ok: true,
      msg: 'account created',
      user: { id: user_id, email, name, org_id },
      trial_id,
      org_id
    });
  } catch (err) {
    console.error('POST /signup/complete error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'server error', details: err && err.message });
  }
});

module.exports = router;

