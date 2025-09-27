// routes/status.js – uses actual column names you shared
const express = require('express');
const router = express.Router();
const db = require('../services/db');

// helper
const isNonEmpty = v => v !== undefined && v !== null && `${v}`.trim() !== '';

/**
 * GET /status/view
 * Query:
 *   org_id          (required)
 *   booking_id      (optional) exact booking
 *   token           (optional) the booking_number
 *   phone           (optional) use with token to disambiguate
 *
 * Response: { ok, org, booking, metrics }
 */
router.get('/view', async (req, res, next) => {
  try {
    const { org_id, booking_id, token, phone } = req.query;
    if (!isNonEmpty(org_id)) {
      return res.status(400).json({ ok: false, error: 'org_id required' });
    }

    // ---------- ORG ----------
    const [orgRows] = await db.query(
      `SELECT id, name, map_url, org_banner_url, banner_url, google_review_url,
              now_serving_token, avg_service_seconds, service_start_at, break_until
       FROM organizations
       WHERE id = ?
       LIMIT 1`,
      [org_id]
    );
    const org = orgRows[0];
    if (!org) return res.status(404).json({ ok: false, error: 'Organization not found' });

    // prefer org_banner_url, fall back to banner_url
    org.banner = org.org_banner_url || org.banner_url || null;

    // ---------- BOOKING (optional) ----------
    let booking = null;
    if (isNonEmpty(booking_id)) {
      const [b] = await db.query(
        `SELECT id, org_id, booking_number, user_name, user_phone,
                assigned_user_id, department, booking_date, booking_time, status
         FROM bookings
         WHERE id = ? AND org_id = ?
         LIMIT 1`,
        [booking_id, org_id]
      );
      booking = b[0] || null;
    } else if (isNonEmpty(token)) {
      if (isNonEmpty(phone)) {
        const [b] = await db.query(
          `SELECT id, org_id, booking_number, user_name, user_phone,
                  assigned_user_id, department, booking_date, booking_time, status
           FROM bookings
           WHERE org_id = ? AND booking_number = ? AND user_phone = ?
           ORDER BY id DESC
           LIMIT 1`,
          [org_id, token, phone]
        );
        booking = b[0] || null;
      } else {
        const [b] = await db.query(
          `SELECT id, org_id, booking_number, user_name, user_phone,
                  assigned_user_id, department, booking_date, booking_time, status
           FROM bookings
           WHERE org_id = ? AND booking_number = ?
           ORDER BY id DESC
           LIMIT 1`,
          [org_id, token]
        );
        booking = b[0] || null;
      }
    }

    // ---------- METRICS ----------
    // Try the assignee row if we have one; else fall back to org-level columns
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
      // Fall back to org-level fields mapped into the same shape
      metrics = {
        org_id: Number(org_id),
        assigned_user_id: booking?.assigned_user_id ?? null,
        now_serving_token: org.now_serving_token ?? null,
        avg_service_seconds: org.avg_service_seconds ?? null,
        break_started_at: null,
        break_until: org.break_until ?? null,
        service_started_at: org.service_start_at ?? null,
        updated_at: org.service_start_at ?? null,
      };
    }

    // ---------- Derived state and ETA ----------
    const now = Date.now();
    const breakUntilTs = metrics.break_until ? new Date(metrics.break_until).getTime() : null;
    metrics.state = breakUntilTs && breakUntilTs > now ? 'break' : 'live';

    // compute ETA when we have both current and booking token
    const currentToken = Number(metrics.now_serving_token ?? 0);
    const bookingToken = Number(booking?.booking_number ?? 0);
    if (bookingToken && currentToken >= 0) {
      const ahead = Math.max(0, bookingToken - currentToken);
      const avg = Math.max(30, Number(metrics.avg_service_seconds ?? org.avg_service_seconds ?? 120));
      metrics.queue_ahead = ahead;
      metrics.eta_seconds = ahead * avg;
    } else {
      metrics.queue_ahead = null;
      metrics.eta_seconds = null;
    }

    // Keep only the fields the front-end needs
    const orgPublic = {
      id: org.id,
      name: org.name,
      banner: org.banner,
      map_url: org.map_url,
      google_review_url: org.google_review_url,
    };

    const bookingPublic = booking
      ? {
          id: booking.id,
          token: booking.booking_number,
          user_name: booking.user_name,
          user_phone: booking.user_phone,
          assigned_user_id: booking.assigned_user_id,
          department: booking.department,
          booking_date: booking.booking_date,
          booking_time: booking.booking_time,
          status: booking.status,
        }
      : null;

    res.json({ ok: true, org: orgPublic, booking: bookingPublic, metrics });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /reviews/add
 * Body: { org_id, booking_id, rating, review }
 * (assigned_user_id is auto-copied from the booking if available)
 */
router.post('/reviews/add', async (req, res, next) => {
  try {
    const { org_id, booking_id, rating, review } = req.body || {};
    if (!isNonEmpty(org_id) || !isNonEmpty(booking_id) || !isNonEmpty(rating)) {
      return res.status(400).json({ ok: false, error: 'org_id, booking_id, rating required' });
    }
    // pull the assignee for the booking to store with review (nullable if not found)
    const [b] = await db.query(
      `SELECT assigned_user_id FROM bookings WHERE id = ? AND org_id = ? LIMIT 1`,
      [booking_id, org_id]
    );
    const assigned_user_id = b[0]?.assigned_user_id ?? null;

    await db.query(
      `INSERT INTO reviews (org_id, booking_id, assigned_user_id, rating, review)
       VALUES (?, ?, ?, ?, ?)`,
      [org_id, booking_id, assigned_user_id, Number(rating), review ?? null]
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

