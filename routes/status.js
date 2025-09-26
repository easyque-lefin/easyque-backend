// routes/status.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { getMetrics } = require('../services/metrics');

/**
 * GET /status/view?org_id=...&token=...&assigned_user_id=...
 * Returns: { org, booking, metrics }
 */
router.get('/view', async (req, res, next) => {
  try {
    const org_id = parseInt(req.query.org_id, 10);
    const token = parseInt(req.query.token || req.query.viewer_token || '0', 10) || 0;
    const assigned_user_id = req.query.assigned_user_id ? parseInt(req.query.assigned_user_id, 10) : null;

    if (!org_id || !token) {
      return res.status(400).json({ ok:false, error:'missing_params' });
    }

    // org record
    const org = (await db.query(
      `SELECT id, name, map_url, org_banner_url, banner_url, service_start_at, avg_service_seconds, now_serving_token
         FROM organizations WHERE id = ? LIMIT 1`, [org_id]
    ))[0] || {};

    // booking by token
    const booking = (await db.query(
      `SELECT id AS booking_id, org_id, user_name, user_phone, department, assigned_user_id, token_no, booking_datetime
         FROM bookings WHERE org_id = ? AND token_no = ? LIMIT 1`, [org_id, token]
    ))[0] || {};

    // live metrics (org-level or assigned user specific)
    const m = await getMetrics(org_id, assigned_user_id);

    const metrics = {
      now_serving_token: m.now_serving_token || org.now_serving_token || null,
      service_start_at: m.service_start_at || org.service_start_at || null,
      avg_service_seconds: m.avg_service_seconds || org.avg_service_seconds || 0,
      on_break: !!m.on_break,
      break_until: m.break_until || null
    };

    return res.json({ org, booking, metrics });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

