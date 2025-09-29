// routes/status.js
const express = require('express');
const dayjs = require('dayjs');
const db = require('../services/db');

const router = express.Router();
function num(x,d=0){ const n=Number(x); return Number.isFinite(n)?n:d; }

router.get('/view', async (req, res, next) => {
  try {
    const org_id = num(req.query.org_id);
    const booking_id = num(req.query.booking_id);
    const token = req.query.token || null;
    const phone = req.query.phone || null;

    if (!org_id || (!booking_id && !token && !phone)) {
      return res.json({ ok:true, org_id: org_id || null, booking_id: booking_id || null, org:null, booking:null, metrics:null });
    }

    const [orgRows] = await db.query(
      `SELECT id, name, banner_url, org_banner_url, google_map_url, google_review_url, now_serving_token, plan_mode
         FROM organizations WHERE id=?`, [org_id]);
    const org = orgRows[0] || null;

    let booking = null;
    if (booking_id) {
      const [rows] = await db.query(
        `SELECT id, org_id, booking_number,
                COALESCE(token_number, token_no) AS token,
                department AS dept,
                booking_date AS date, booking_time AS time,
                user_name AS name, user_phone AS phone,
                assigned_user_id, status, created_at
           FROM bookings WHERE id=? AND org_id=?`,
        [booking_id, org_id]);
      booking = rows[0] || null;
    } else if (token || phone) {
      const [rows] = await db.query(
        `SELECT id, org_id, booking_number,
                COALESCE(token_number, token_no) AS token,
                department AS dept,
                booking_date AS date, booking_time AS time,
                user_name AS name, user_phone AS phone,
                assigned_user_id, status, created_at
           FROM bookings
          WHERE org_id=? AND (COALESCE(token_number, token_no)=? OR user_phone=?)
          ORDER BY id DESC LIMIT 1`,
        [org_id, token || -1, phone || '']);
      booking = rows[0] || null;
    }

    let metrics = null;
    if (booking?.assigned_user_id && booking?.date) {
      const [m] = await db.query(
        `SELECT now_serving_token AS now_serving, avg_service_seconds, break_until, updated_at
           FROM assigned_live_metrics
          WHERE org_id=? AND assigned_user_id=? AND booking_date=?`,
        [org_id, booking.assigned_user_id, dayjs(booking.date).format('YYYY-MM-DD')]);
      metrics = m[0] || { now_serving: org?.now_serving_token || 0, avg_service_seconds: null, break_until: null, updated_at: null };
    }

    res.json({ ok:true, org_id, booking_id: booking?.id || booking_id || null, org, booking, metrics });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.default = router;


