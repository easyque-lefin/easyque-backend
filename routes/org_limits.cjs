// routes/org_limits.cjs
const express = require('express');
const router = express.Router();

let pool, requireAuth;
try {
  // Adjust these paths if your project keeps them elsewhere
  ({ pool } = require('../lib/db'));
  ({ requireAuth } = require('../lib/auth'));
} catch (e) {
  console.error('Import error (adjust paths):', e.message);
  // Fallback no-auth for quick smoke tests (comment out in prod)
  requireAuth = (req, _res, next) => next();
}

// GET current limits
router.get('/organizations/:id/limits', requireAuth, async (req, res) => {
  const orgId = Number(req.params.id);
  try {
    const [rows] = await pool.query(
      `SELECT id, name, plan_mode, trial_starts_at, trial_ends_at,
              messaging_option, users_limit, daily_booking_limit,
              monthly_booking_limit, expected_bookings_per_day
         FROM organizations WHERE id=?`,
      [orgId]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'org_not_found' });
    res.json({ ok: true, limits: rows[0] });
  } catch (e) {
    console.error('GET limits error', e);
    res.status(500).json({ ok: false, error: 'get_limits_failed' });
  }
});

// POST set limits
router.post('/organizations/:id/limits', requireAuth, async (req, res) => {
  const orgId = Number(req.params.id);
  const {
    plan_mode,
    trial_days = 7,
    messaging_option,
    users_limit,
    daily_booking_limit,
    monthly_booking_limit,
    expected_bookings_per_day
  } = req.body || {};

  if (!plan_mode || !['trial', 'paid'].includes(plan_mode)) {
    return res.status(400).json({ ok: false, error: 'invalid_plan_mode' });
  }
  if (messaging_option && !['option1', 'option2'].includes(messaging_option)) {
    return res.status(400).json({ ok: false, error: 'invalid_messaging_option' });
  }

  try {
    // compute trial dates if trial
    let trialStarts = null, trialEnds = null;
    if (plan_mode === 'trial') {
      const [[nowRow]] = await pool.query('SELECT NOW() AS now');
      const now = new Date(nowRow.now);
      trialStarts = now;
      trialEnds = new Date(now.getTime() + Number(trial_days || 7) * 24 * 60 * 60 * 1000);
    }

    const fields = ['plan_mode = ?'];
    const vals = [plan_mode];

    if (plan_mode === 'trial') {
      fields.push('trial_starts_at = ?', 'trial_ends_at = ?');
      vals.push(trialStarts, trialEnds);
    } else {
      fields.push('trial_starts_at = NULL', 'trial_ends_at = NULL');
    }

    if (messaging_option) { fields.push('messaging_option = ?'); vals.push(messaging_option); }
    if (users_limit != null) { fields.push('users_limit = ?'); vals.push(Number(users_limit)); }
    if (daily_booking_limit != null) { fields.push('daily_booking_limit = ?'); vals.push(Number(daily_booking_limit)); }
    if (monthly_booking_limit != null) { fields.push('monthly_booking_limit = ?'); vals.push(Number(monthly_booking_limit)); }
    if (expected_bookings_per_day != null) { fields.push('expected_bookings_per_day = ?'); vals.push(Number(expected_bookings_per_day)); }

    vals.push(orgId);
    const sql = `UPDATE organizations SET ${fields.join(', ')} WHERE id=?`;
    await pool.query(sql, vals);

    const [[org]] = await pool.query(
      `SELECT id, name, plan_mode, trial_starts_at, trial_ends_at,
              messaging_option, users_limit, daily_booking_limit,
              monthly_booking_limit, expected_bookings_per_day
         FROM organizations WHERE id=?`,
      [orgId]
    );
    res.json({ ok: true, limits: org });
  } catch (e) {
    console.error('POST limits error', e);
    res.status(500).json({ ok: false, error: 'set_limits_failed' });
  }
});

module.exports = router;
