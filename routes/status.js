// routes/status.js — public status view; uses token_number

const express = require('express');
const dayjs = require('dayjs');
const db = require('../services/db');

const router = express.Router();
const num = (x, d=0) => { const n = Number(x); return Number.isFinite(n) ? n : d; };

/**
 * GET /status/view?org_id=...&booking_id=...&token=...&phone=...
 * returns { org, booking, metrics }
 */
router.get('/view', async (req, res, next) => {
  try {
    const org_id = num(req.query.org_id);
    const booking_id = num(req.query.booking_id);
    const token = req.query.token ? num(req.query.token) : null;
    const phone = req.query.phone || null;
    if (!org_id || (!booking_id && !token && !phone)) {
      return res.status(400).json({ ok:false, error:'org_id and one of booking_id|token|phone required' });
    }

    const [orgRows] = await db.query(
      `SELECT id, name, map_url, google_review_url, now_serving_token,
              break_started_at, break_until, service_start_at, avg_service_seconds
         FROM organizations
        WHERE id=? LIMIT 1`, [org_id]
    );
    const org = orgRows[0] || null;
    if (!org) return res.status(404).json({ ok:false, error:'org_not_found' });

    // locate booking by id/token/phone (today preferred)
    let booking = null;
    if (booking_id) {
      const [b] = await db.query(
        `SELECT * FROM bookings WHERE id=? AND org_id=? LIMIT 1`, [booking_id, org_id]
      );
      booking = b[0] || null;
    } else if (token) {
      const [b] = await db.query(
        `SELECT * FROM bookings WHERE org_id=? AND booking_date=? AND token_number=? LIMIT 1`,
        [org_id, dayjs().format('YYYY-MM-DD'), token]
      );
      booking = b[0] || null;
    } else if (phone) {
      const [b] = await db.query(
        `SELECT * FROM bookings
          WHERE org_id=? AND booking_date=? AND user_phone=? 
          ORDER BY id DESC LIMIT 1`,
        [org_id, dayjs().format('YYYY-MM-DD'), phone]
      );
      booking = b[0] || null;
    }

    // metrics: per-assigned or per-org based on ASSIGNED_METRICS
    let metrics = null;
    const assignedMode = String(process.env.ASSIGNED_METRICS || 'false').toLowerCase() === 'true';
    if (!assignedMode) {
      metrics = {
        now_serving: org.now_serving_token || null,
        avg_service_seconds: org.avg_service_seconds || null,
        break_until: org.break_until || null,
        updated_at: null
      };
    } else if (booking?.assigned_user_id) {
      const [m] = await db.query(
        `SELECT now_serving_token AS now_serving, avg_service_seconds, break_until, updated_at
           FROM assigned_live_metrics
          WHERE org_id=? AND assigned_user_id=? AND booking_date=?`,
        [org_id, booking.assigned_user_id, dayjs(booking.booking_date || new Date()).format('YYYY-MM-DD')]
      );
      metrics = m[0] || { now_serving: null, avg_service_seconds: null, break_until: null, updated_at: null };
    }

    res.json({ ok:true, org_id, booking_id: booking?.id || booking_id || null, org, booking, metrics });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.default = router;


