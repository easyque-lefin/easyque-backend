// /opt/easyque-backend/routes/status.js
// Returns { ok, org, booking, metrics } for /status/view?... used by the static status page.

const express = require('express');
const router = express.Router();
const db = require('../services/db');

// helper: first non-empty value
const pick = (...vals) => vals.find(v => v !== null && v !== undefined && v !== '') ?? null;

/**
 * GET /status/view
 * Query:
 *  - org_id (required)
 *  - booking_id (optional)  OR  token (uses bookings.booking_number)
 *  - phone (optional; narrows searches combined with token)
 */
router.get('/view', async (req, res, next) => {
  try {
    const { org_id, booking_id, token, phone } = req.query;
    if (!org_id) return res.status(400).json({ ok: false, error: 'org_id required' });

    // ---------- ORG ----------
    const [orgRows] = await db.query(
      `SELECT
          id, name,
          org_banner_url, banner_url,
          map_url, google_review_url,
          now_serving_token, avg_service_seconds, break_until
       FROM organizations
       WHERE id = ? LIMIT 1`,
      [org_id]
    );
    const org = orgRows[0];
    if (!org) return res.status(404).json({ ok: false, error: 'Organization not found' });
    org.banner = pick(org.org_banner_url, org.banner_url, null);

    // ---------- BOOKING (optional) ----------
    let booking = null;
    if (booking_id) {
      const [b] = await db.query(
        `SELECT
            id, org_id, assigned_user_id,
            booking_number, status,
            department, division,
            booking_date, booking_time, booking_datetime,
            user_name, user_phone,
            queue_code
         FROM bookings
         WHERE id = ? AND org_id = ?
         LIMIT 1`,
        [booking_id, org_id]
      );
      booking = b[0] || null;
    } else if (token) {
      const args = [org_id, token];
      let where = `org_id = ? AND booking_number = ?`;
      if (phone) {
        where += ` AND user_phone = ?`;
        args.push(phone);
      }
      const [b] = await db.query(
        `SELECT
            id, org_id, assigned_user_id,
            booking_number, status,
            department, division,
            booking_date, booking_time, booking_datetime,
            user_name, user_phone,
            queue_code
         FROM bookings
         WHERE ${where}
         ORDER BY id DESC
         LIMIT 1`,
        args
      );
      booking = b[0] || null;
    }

    // ---------- METRICS ----------
    let metrics = null;
    if (booking?.assigned_user_id) {
      const [m] = await db.query(
        `SELECT org_id, assigned_user_id, now_serving_token, avg_service_seconds,
                break_until, updated_at
         FROM assigned_live_metrics
         WHERE org_id = ? AND assigned_user_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
        [org_id, booking.assigned_user_id]
      );
      metrics = m[0] || null;
    }
    if (!metrics) {
      const [m] = await db.query(
        `SELECT org_id, NULL AS assigned_user_id, now_serving_token, avg_service_seconds,
                break_until, updated_at
         FROM assigned_live_metrics
         WHERE org_id = ? AND (assigned_user_id IS NULL OR assigned_user_id = 0)
         ORDER BY updated_at DESC
         LIMIT 1`,
        [org_id]
      );
      metrics = m[0] || null;
    }

    // ---------- derived values (state + ETA) ----------
    if (metrics) {
      const now = Date.now();
      const breakUntil = metrics.break_until ? new Date(metrics.break_until).getTime() : null;
      metrics.state = breakUntil && breakUntil > now ? 'break' : 'live';

      const nowServing = Number(metrics.now_serving_token ?? 0);
      const avg = Math.max(30, Number(metrics.avg_service_seconds || 120));
      const myToken = booking?.booking_number ? Number(booking.booking_number) : null;

      if (myToken != null && !Number.isNaN(myToken) && !Number.isNaN(nowServing)) {
        const ahead = Math.max(0, myToken - nowServing);
        metrics.queue_ahead = ahead;
        metrics.eta_seconds = ahead * avg;
      } else {
        metrics.queue_ahead = null;
        metrics.eta_seconds = null;
      }
    }

    // ---------- nice aliases for UI ----------
    if (booking) {
      booking.token_number = booking.booking_number;
      booking.customer_name = booking.user_name;
      booking.customer_phone = booking.user_phone;
      booking.created_at = booking.booking_datetime;
    }

    return res.json({ ok: true, org, booking, metrics });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

