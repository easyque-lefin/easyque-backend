// routes/status.js — uses your actual DB columns
const express = require('express');
const router = express.Router();
const db = require('../services/db');

const pick = (...vals) => vals.find(v => v !== null && v !== undefined && v !== '') ?? null;

/**
 * GET /status/view
 * ?org_id=   (required)
 * ?booking_id= or ?token=booking_number (optional)
 * ?phone= (optional; ignored unless you later need it)
 */
router.get('/view', async (req, res, next) => {
  try {
    const { org_id, booking_id, token } = req.query;
    if (!org_id) return res.status(400).json({ ok: false, error: 'org_id required' });

    // ---- ORG ----
    const [orgRows] = await db.query(
      `SELECT id, name, map_url, org_banner_url, banner_url, google_review_url
       FROM organizations WHERE id = ? LIMIT 1`, [org_id]
    );
    const org = orgRows[0];
    if (!org) return res.status(404).json({ ok: false, error: 'Organization not found' });
    org.banner = pick(org.org_banner_url, org.banner_url, null);

    // ---- BOOKING (optional) ----
    let booking = null;
    if (booking_id) {
      const [b] = await db.query(
        `SELECT id, org_id, assigned_user_id, booking_number, status,
                user_name, user_phone, booking_datetime
           FROM bookings
          WHERE id = ? AND org_id = ?
          LIMIT 1`,
        [booking_id, org_id]
      );
      booking = b[0] || null;
    } else if (token) {
      // allow lookup by booking_number
      const [b] = await db.query(
        `SELECT id, org_id, assigned_user_id, booking_number, status,
                user_name, user_phone, booking_datetime
           FROM bookings
          WHERE org_id = ? AND booking_number = ?
          ORDER BY id DESC
          LIMIT 1`,
        [org_id, token]
      );
      booking = b[0] || null;
    }

    // ---- METRICS (prefer assigned user's stream, else org rollup/null user) ----
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
        `SELECT org_id, assigned_user_id, now_serving_token, avg_service_seconds,
                break_until, updated_at
           FROM assigned_live_metrics
          WHERE org_id = ? AND (assigned_user_id IS NULL OR assigned_user_id = 0)
          ORDER BY updated_at DESC
          LIMIT 1`,
        [org_id]
      );
      metrics = m[0] || null;
    }

    // ---- compute simple state + ETA ----
    if (metrics) {
      const now = Date.now();
      const breakUntil = metrics.break_until ? new Date(metrics.break_until).getTime() : null;
      metrics.state = (breakUntil && breakUntil > now) ? 'break' : 'live';

      if (booking?.booking_number != null && metrics.now_serving_token != null) {
        const ahead = Math.max(0, Number(booking.booking_number) - Number(metrics.now_serving_token));
        const avg = Math.max(30, Number(metrics.avg_service_seconds || 120));
        metrics.eta_seconds = ahead * avg;
        metrics.queue_ahead = ahead;
      } else {
        metrics.eta_seconds = null;
        metrics.queue_ahead = null;
      }
    }

    res.json({ ok: true, org, booking, metrics });
  } catch (e) {
    next(e);
  }
});

module.exports = router;


