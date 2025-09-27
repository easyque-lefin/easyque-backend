// routes/status.js — returns { org, booking, metrics } used by /public/status.html

const express = require('express');
const router = express.Router();
const db = require('../services/db');

// Small helper: pick first non-empty
const pick = (...vals) => vals.find(v => v !== null && v !== undefined && v !== '') ?? null;

/**
 * GET /status/view
 * Params:
 *  - org_id (required)
 *  - booking_id OR token (optional)
 *  - phone (optional; when token not unique)
 *
 * Response:
 *  {
 *    org: {
 *      id, name, map_url, org_banner_url, banner_url, google_review_url,
 *      banner    // computed: first non-empty of org_banner_url, banner_url
 *    },
 *    booking: {...} | null,
 *    metrics: { now_serving_token, avg_service_seconds, break_until, state, eta_seconds, queue_ahead } | null
 *  }
 */
router.get('/view', async (req, res, next) => {
  try {
    const { org_id, booking_id, token, phone } = req.query;
    if (!org_id) return res.status(400).json({ ok: false, error: 'org_id required' });

    // ---- ORG ----
    const [orgRows] = await db.query(
      `SELECT id, name, map_url, org_banner_url, banner_url, google_review_url
       FROM organizations
       WHERE id = ? LIMIT 1`,
      [org_id]
    );
    const org = orgRows[0];
    if (!org) return res.status(404).json({ ok: false, error: 'Organization not found' });

    // computed banner field: prefer org_banner_url over old banner_url
    org.banner = pick(org.org_banner_url, org.banner_url, null);

    // ---- BOOKING (optional) ----
    let booking = null;
    if (booking_id) {
      const [b] = await db.query(
        `SELECT id, org_id, assigned_user_id, token_number, status,
                customer_name, customer_phone, created_at
         FROM bookings
         WHERE id = ? AND org_id = ?
         LIMIT 1`,
        [booking_id, org_id]
      );
      booking = b[0] || null;
    } else if (token) {
      if (phone) {
        const [b] = await db.query(
          `SELECT id, org_id, assigned_user_id, token_number, status,
                  customer_name, customer_phone, created_at
           FROM bookings
           WHERE org_id = ? AND token_number = ? AND customer_phone = ?
           ORDER BY id DESC
           LIMIT 1`,
          [org_id, token, phone]
        );
        booking = b[0] || null;
      } else {
        const [b] = await db.query(
          `SELECT id, org_id, assigned_user_id, token_number, status,
                  customer_name, customer_phone, created_at
           FROM bookings
           WHERE org_id = ? AND token_number = ?
           ORDER BY id DESC
           LIMIT 1`,
          [org_id, token]
        );
        booking = b[0] || null;
      }
    }

    // ---- METRICS (prefer assignee of booking; fallback to org rollup) ----
    let metrics = null;
    if (booking?.assigned_user_id) {
      const [m] = await db.query(
        `SELECT org_id, assigned_user_id, now_serving_token, avg_service_seconds,
                break_started_at, break_until, service_started_at, updated_at
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
        `SELECT org_id, NULL as assigned_user_id, now_serving_token, avg_service_seconds,
                break_started_at, break_until, service_started_at, updated_at
         FROM assigned_live_metrics
         WHERE org_id = ? AND (assigned_user_id IS NULL OR assigned_user_id = 0)
         ORDER BY updated_at DESC
         LIMIT 1`,
        [org_id]
      );
      metrics = m[0] || null;
    }

    // ---- Compute state + ETA (best-effort) ----
    if (metrics) {
      const now = Date.now();
      const breakUntil = metrics.break_until ? new Date(metrics.break_until).getTime() : null;
      let state = 'live';
      if (breakUntil && breakUntil > now) state = 'break';
      metrics.state = state;

      if (booking?.token_number != null && metrics.now_serving_token != null) {
        const ahead = Math.max(0, Number(booking.token_number) - Number(metrics.now_serving_token));
        const avg = Math.max(30, Number(metrics.avg_service_seconds || 120));
        metrics.eta_seconds = ahead * avg;
        metrics.queue_ahead = ahead;
      } else {
        metrics.eta_seconds = null;
        metrics.queue_ahead = null;
      }
    }

    return res.json({ ok: true, org, booking, metrics });
  } catch (e) {
    next(e);
  }
});

module.exports = router;

