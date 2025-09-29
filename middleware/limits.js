// middleware/limits.js
const dayjs = require('dayjs');
let db;
try { db = require('../services/db'); } catch { db = require('../db'); }

function num(x,d=0){ const n=Number(x); return Number.isFinite(n)?n:d; }

async function enforceOrgLimits(req, res, next) {
  try {
    const org_id = num(req.body?.org_id || req.query?.org_id || req.params?.org_id);
    if (!org_id) return res.status(400).json({ ok:false, error:'org_id required' });

    const [rows] = await db.query(
      `SELECT id, plan_mode, users_limit, daily_booking_limit, monthly_booking_limit, trial_starts_at, trial_ends_at
         FROM organizations WHERE id=?`, [org_id]
    );
    if (!rows.length) return res.status(404).json({ ok:false, error:'org_not_found' });

    const org = rows[0];
    const today = dayjs().format('YYYY-MM-DD');
    const monthStart = dayjs().startOf('month').format('YYYY-MM-DD');
    const monthEnd   = dayjs().endOf('month').format('YYYY-MM-DD');

    // Trial expiry
    if (org.plan_mode === 'trial') {
      if (org.trial_ends_at && dayjs().isAfter(dayjs(org.trial_ends_at))) {
        return res.status(402).json({ ok:false, error:'trial_expired' });
      }
    }

    // Daily cap
    if (org.daily_booking_limit) {
      const [d] = await db.query(
        `SELECT COUNT(*) AS c FROM bookings WHERE org_id=? AND booking_date=?`,
        [org_id, today]
      );
      if (num(d[0].c) >= num(org.daily_booking_limit)) {
        return res.status(429).json({ ok:false, error:'daily_limit_reached' });
      }
    }

    // Monthly cap
    if (org.monthly_booking_limit) {
      const [m] = await db.query(
        `SELECT COUNT(*) AS c FROM bookings WHERE org_id=? AND booking_date BETWEEN ? AND ?`,
        [org_id, monthStart, monthEnd]
      );
      if (num(m[0].c) >= num(org.monthly_booking_limit)) {
        return res.status(429).json({ ok:false, error:'monthly_limit_reached' });
      }
    }

    return next();
  } catch (e) { next(e); }
}

module.exports = { enforceOrgLimits };


