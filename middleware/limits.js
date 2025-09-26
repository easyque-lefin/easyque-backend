// middleware/limits.js
// Trial (7 days) & booking limit enforcement (daily/monthly)

const db = require('../services/db');

/** Helper: return org row */
async function getOrg(org_id) {
  const [rows] = await db.query(`SELECT * FROM organizations WHERE id = ? LIMIT 1`, [org_id]);
  return rows[0] || null;
}

/** Days difference (UTC date milliseconds) */
function daysBetween(a, b) {
  const MS = 24 * 60 * 60 * 1000;
  return Math.floor((b - a) / MS);
}

/** Enforce trial expiry on login and booking create (as needed) */
async function trialGuard(req, res, next) {
  try {
    const org_id = Number(req.body.org_id || req.query.org_id || req.params.org_id || 0);
    if (!org_id) return next(); // some routes may not be org-scoped
    const org = await getOrg(org_id);
    if (!org) return res.status(404).json({ ok: false, error: 'Organization not found' });

    if (org.trial_started_at && !org.is_paid) {
      const started = new Date(org.trial_started_at).getTime();
      const now = Date.now();
      const days = daysBetween(started, now);
      if (days >= 7) {
        return res.status(403).json({
          ok: false,
          error: 'Your free trial is over, please sign up now to continue using our service.'
        });
      }
    }
    next();
  } catch (e) { next(e); }
}

/** Enforce booking limits based on org settings */
async function bookingLimitsGuard(req, res, next) {
  try {
    const { org_id } = req.body;
    if (!org_id) return res.status(400).json({ ok: false, error: 'org_id required' });
    const org = await getOrg(org_id);
    if (!org) return res.status(404).json({ ok: false, error: 'Organization not found' });

    // If org is unpaid after trial, block
    if (!org.is_paid && org.trial_started_at) {
      const started = new Date(org.trial_started_at).getTime();
      if (daysBetween(started, Date.now()) >= 7) {
        return res.status(403).json({
          ok: false,
          error: 'Your free trial is over, please sign up now to continue using our service.'
        });
      }
    }

    const perDay = Number(org.expected_bookings_per_day || 0);
    const perMonth = Number(org.monthly_expected_bookings || (perDay ? perDay * 30 : 0));

    if (!perDay) return next(); // not configured => no limit

    // Count today for this org (local day in IST—approx via server date)
    const [todayRows] = await db.query(
      `SELECT COUNT(*) AS c FROM bookings WHERE org_id = ? AND DATE(booking_date) = CURDATE()`,
      [org_id]
    );
    const today = Number(todayRows[0]?.c || 0);
    if (today >= perDay) {
      return res.status(429).json({
        ok: false,
        error: 'Your booking limit is over as per your current plan, kindly contact EasyQue team for an upgrade.'
      });
    }

    // Count month
    if (perMonth) {
      const [mRows] = await db.query(
        `SELECT COUNT(*) AS c FROM bookings WHERE org_id = ? AND DATE_FORMAT(booking_date,'%Y-%m') = DATE_FORMAT(CURDATE(),'%Y-%m')`,
        [org_id]
      );
      const m = Number(mRows[0]?.c || 0);
      if (m >= perMonth) {
        return res.status(429).json({
          ok: false,
          error: 'Your booking limit is over as per your current plan, kindly contact EasyQue team for an upgrade.'
        });
      }
    }

    next();
  } catch (e) { next(e); }
}

module.exports = { trialGuard, bookingLimitsGuard };
