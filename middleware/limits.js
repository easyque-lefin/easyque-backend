// middleware/limits.js
// Enforce org trial expiry and daily/monthly booking caps (CommonJS)
//
// Plugs into POST /bookings create route.
// Uses the project's services/db.js (mysql2/promise pool wrapper).

const db = require('../services/db');

async function enforceOrgLimits(req, res, next) {
  try {
    const org_id = Number(req.body?.org_id || req.query?.org_id);
    if (!org_id) return res.status(400).json({ ok: false, error: 'org_id_required' });

    const [rows] = await db.query(
      `SELECT plan_mode, trial_starts_at, trial_ends_at,
              daily_booking_limit, monthly_booking_limit
         FROM organizations WHERE id = ?`,
      [org_id]
    );
    const org = rows && rows[0];
    if (!org) return res.status(404).json({ ok: false, error: 'org_not_found' });

    // Trial gate (block if trial expired and not paid)
    if (org.plan_mode === 'trial' && org.trial_ends_at) {
      const now = new Date();
      if (now > new Date(org.trial_ends_at)) {
        return res.status(402).json({ ok: false, error: 'trial_expired', message: 'Trial ended. Please upgrade plan.' });
      }
    }

    // Only enforce caps on booking creation
    if (req.method === 'POST' && (req.path === '/' || req.path === '/bookings')) {
      const [cntRows] = await db.query(
        `SELECT
            SUM(DATE(booking_date) = CURRENT_DATE()) AS today_count,
            SUM(DATE_FORMAT(booking_date,'%Y-%m') = DATE_FORMAT(CURRENT_DATE(),'%Y-%m')) AS month_count
         FROM bookings
        WHERE org_id = ?`,
        [org_id]
      );
      const today = Number(cntRows && cntRows[0] && cntRows[0].today_count || 0);
      const month = Number(cntRows && cntRows[0] && cntRows[0].month_count || 0);

      if (org.daily_booking_limit != null && today >= org.daily_booking_limit) {
        return res.status(429).json({ ok: false, error: 'daily_limit_reached' });
      }
      if (org.monthly_booking_limit != null && month >= org.monthly_booking_limit) {
        return res.status(429).json({ ok: false, error: 'monthly_limit_reached' });
      }
    }

    next();
  } catch (err) {
    console.error('enforceOrgLimits error:', err);
    res.status(500).json({ ok: false, error: 'limits_check_failed' });
  }
}

module.exports = { enforceOrgLimits };

