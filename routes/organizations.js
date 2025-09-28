// /routes/organizations.js
import { Router } from 'express';
import { pool } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';

const router = Router();

/**
 * PUT /organizations/:id/banner
 * Body: { org_banner_url?, banner_url?, google_map_url?, lat?, lng? }
 */
router.put('/organizations/:id/banner', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { org_banner_url, banner_url, google_map_url, lat, lng } = req.body || {};
  await pool.query(
    `UPDATE organizations
       SET org_banner_url = COALESCE(?, org_banner_url),
           banner_url     = COALESCE(?, banner_url),
           google_map_url = COALESCE(?, google_map_url),
           lat            = COALESCE(?, lat),
           lng            = COALESCE(?, lng)
     WHERE id=?`,
    [org_banner_url || null, banner_url || null, google_map_url || null, lat || null, lng || null, id]
  );
  res.json({ ok: true });
});

/**
 * GET /organizations/:id/limits
 * Returns current plan & caps.
 */
router.get('/organizations/:id/limits', requireAuth, async (req, res) => {
  const { id } = req.params;
  const [[org]] = await pool.query(
    `SELECT id, name,
            plan_mode, trial_starts_at, trial_ends_at,
            messaging_option,
            users_limit, daily_booking_limit, monthly_booking_limit,
            expected_bookings_per_day
       FROM organizations WHERE id=?`, [id]
  );
  if (!org) return res.status(404).json({ ok:false, error:'org_not_found' });
  res.json({ ok:true, limits: org });
});

/**
 * POST /organizations/:id/limits
 * Body:
 * {
 *   plan_mode: 'trial' | 'paid',
 *   trial_days?: number (default 7),
 *   messaging_option: 'option1' | 'option2',
 *   users_limit?: number,
 *   daily_booking_limit?: number,
 *   monthly_booking_limit?: number,
 *   expected_bookings_per_day?: number
 * }
 */
router.post('/organizations/:id/limits', requireAuth, async (req, res) => {
  const { id } = req.params;
  const {
    plan_mode,                 // 'trial' | 'paid'
    trial_days = 7,            // defaults to 7
    messaging_option,          // 'option1' | 'option2'
    users_limit,
    daily_booking_limit,
    monthly_booking_limit,
    expected_bookings_per_day
  } = req.body || {};

  // Validate minimal inputs
  if (!plan_mode || !['trial','paid'].includes(plan_mode)) {
    return res.status(400).json({ ok:false, error:'invalid_plan_mode' });
  }
  if (messaging_option && !['option1','option2'].includes(messaging_option)) {
    return res.status(400).json({ ok:false, error:'invalid_messaging_option' });
  }

  // Compute trial dates if needed
  let trialStarts = null;
  let trialEnds = null;
  if (plan_mode === 'trial') {
    const [[nowRow]] = await pool.query('SELECT NOW() AS now');
    const now = new Date(nowRow.now);
    trialStarts = now;
    trialEnds = new Date(now.getTime() + (Number(trial_days || 7) * 24 * 60 * 60 * 1000));
  }

  // Build dynamic update
  const fields = ['plan_mode = ?'];
  const vals = [plan_mode];

  if (plan_mode === 'trial') {
    fields.push('trial_starts_at = ?', 'trial_ends_at = ?');
    vals.push(trialStarts, trialEnds);
  } else {
    // clear trial when switching to paid
    fields.push('trial_starts_at = NULL', 'trial_ends_at = NULL');
  }

  if (messaging_option) { fields.push('messaging_option = ?'); vals.push(messaging_option); }
  if (users_limit != null) { fields.push('users_limit = ?'); vals.push(Number(users_limit)); }
  if (daily_booking_limit != null) { fields.push('daily_booking_limit = ?'); vals.push(Number(daily_booking_limit)); }
  if (monthly_booking_limit != null) { fields.push('monthly_booking_limit = ?'); vals.push(Number(monthly_booking_limit)); }
  if (expected_bookings_per_day != null) { fields.push('expected_bookings_per_day = ?'); vals.push(Number(expected_bookings_per_day)); }

  vals.push(id);

  const sql = `UPDATE organizations SET ${fields.join(', ')} WHERE id = ?`;
  await pool.query(sql, vals);

  // Return the saved values
  const [[org]] = await pool.query(
    `SELECT id, name, plan_mode, trial_starts_at, trial_ends_at,
            messaging_option, users_limit, daily_booking_limit, monthly_booking_limit,
            expected_bookings_per_day
       FROM organizations WHERE id=?`, [id]
  );
  res.json({ ok:true, limits: org });
});

export default router;
