// routes/status.js — returns { org, booking, metrics } used by /public/status.html

const express = require('express');
const router = express.Router();
const db = require('../services/db');

// Helpers
const pick = (...vals) => vals.find(v => v !== null && v !== undefined && v !== '') ?? null;

async function getTableColumns(table) {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
  );
  return new Set(rows.map(r => r.COLUMN_NAME));
}

function aliasOrNull(cols, candidates, alias) {
  // candidates: array of possible column names in priority order
  const found = candidates.find(c => cols.has(c));
  if (!found) return `NULL AS ${alias}`;
  return `${found} AS ${alias}`;
}

function exist(cols, name) {
  return cols.has(name);
}

/**
 * GET /status/view
 * Query:
 *  - org_id (required)
 *  - booking_id OR token (optional)
 *  - phone (optional; narrows token)
 *
 * Response:
 *  {
 *    ok: true,
 *    org: { id, name, address, map_url, banner (best), google_review_url, ... },
 *    booking: { id, org_id, assigned_user_id, token_number, status, customer_name, customer_phone, created_at } | null,
 *    metrics: { now_serving_token, avg_service_seconds, break_until, service_started_at, state, eta_seconds, queue_ahead } | null
 *  }
 */
router.get('/view', async (req, res, next) => {
  try {
    const { org_id, booking_id, token, phone } = req.query;
    if (!org_id) return res.status(400).json({ ok: false, error: 'org_id required' });

    /* --------------------------- ORGANIZATION --------------------------- */
    const orgCols = await getTableColumns('organizations');

    // Build a SELECT that adapts to whatever columns exist
    const orgSelect = [
      exist(orgCols, 'id') ? 'id' : 'NULL AS id',
      aliasOrNull(orgCols, ['name', 'org_name', 'organization_name'], 'name'),
      aliasOrNull(orgCols, ['address', 'org_address', 'location'], 'address'),
      aliasOrNull(orgCols, ['map_url', 'google_map_url'], 'map_url'),
      aliasOrNull(orgCols, ['org_banner_url'], 'org_banner_url'),
      aliasOrNull(orgCols, ['banner_url'], 'banner_url'),
      aliasOrNull(orgCols, ['google_review_url', 'review_url'], 'google_review_url'),
    ].join(', ');

    const [orgRows] = await db.query(
      `SELECT ${orgSelect} FROM organizations WHERE id = ? LIMIT 1`,
      [org_id]
    );
    const org = orgRows[0];
    if (!org) return res.status(404).json({ ok: false, error: 'Organization not found' });

    // Best banner (org_banner_url first, then banner_url)
    org.banner = pick(org.org_banner_url, org.banner_url, null);

    /* ------------------------------ BOOKING ---------------------------- */
    let booking = null;

    const bookingCols = await getTableColumns('bookings');

    // Token column and name/phone variants
    const tokenCol = bookingCols.has('token_number')
      ? 'token_number'
      : (bookingCols.has('token_no') ? 'token_no' : null);

    const nameCol = bookingCols.has('customer_name')
      ? 'customer_name'
      : (bookingCols.has('user_name') ? 'user_name' : (bookingCols.has('name') ? 'name' : null));

    const phoneCol = bookingCols.has('customer_phone')
      ? 'customer_phone'
      : (bookingCols.has('user_phone') ? 'user_phone' : (bookingCols.has('phone') ? 'phone' : null));

    const createdAtCol = bookingCols.has('created_at') ? 'created_at' : null;

    // Build normalized booking SELECT
    const bookingSelect = [
      'id',
      'org_id',
      bookingCols.has('assigned_user_id') ? 'assigned_user_id' : 'NULL AS assigned_user_id',
      tokenCol ? `${tokenCol} AS token_number` : 'NULL AS token_number',
      bookingCols.has('status') ? 'status' : `NULL AS status`,
      nameCol ? `${nameCol} AS customer_name` : 'NULL AS customer_name',
      phoneCol ? `${phoneCol} AS customer_phone` : 'NULL AS customer_phone',
      createdAtCol ? `${createdAtCol} AS created_at` : 'NULL AS created_at',
    ].join(', ');

    if (booking_id) {
      const [b] = await db.query(
        `SELECT ${bookingSelect} FROM bookings WHERE id = ? AND org_id = ? LIMIT 1`,
        [booking_id, org_id]
      );
      booking = b[0] || null;
    } else if (tokenCol && token) {
      if (phone && phoneCol) {
        const [b] = await db.query(
          `SELECT ${bookingSelect}
             FROM bookings
            WHERE org_id = ? AND ${tokenCol} = ? AND ${phoneCol} = ?
            ORDER BY id DESC LIMIT 1`,
          [org_id, token, phone]
        );
        booking = b[0] || null;
      } else {
        const [b] = await db.query(
          `SELECT ${bookingSelect}
             FROM bookings
            WHERE org_id = ? AND ${tokenCol} = ?
            ORDER BY id DESC LIMIT 1`,
          [org_id, token]
        );
        booking = b[0] || null;
      }
    }

    /* ------------------------------ METRICS ---------------------------- */
    // Prefer metrics for the assigned user of the booking; else org-level row
    let metrics = null;
    const metricsCols = await getTableColumns('assigned_live_metrics');

    if (metricsCols.size) {
      if (booking?.assigned_user_id) {
        const [m] = await db.query(
          `SELECT org_id, assigned_user_id,
                  ${metricsCols.has('now_serving_token') ? 'now_serving_token' : 'NULL AS now_serving_token'},
                  ${metricsCols.has('avg_service_seconds') ? 'avg_service_seconds' : 'NULL AS avg_service_seconds'},
                  ${metricsCols.has('break_started_at') ? 'break_started_at' : 'NULL AS break_started_at'},
                  ${metricsCols.has('break_until') ? 'break_until' : 'NULL AS break_until'},
                  ${metricsCols.has('service_started_at') ? 'service_started_at' : 'NULL AS service_started_at'},
                  ${metricsCols.has('updated_at') ? 'updated_at' : 'NULL AS updated_at'}
             FROM assigned_live_metrics
            WHERE org_id = ? AND assigned_user_id = ?
            ORDER BY updated_at DESC LIMIT 1`,
          [org_id, booking.assigned_user_id]
        );
        metrics = m[0] || null;
      }

      if (!metrics) {
        const [m] = await db.query(
          `SELECT org_id, NULL AS assigned_user_id,
                  ${metricsCols.has('now_serving_token') ? 'now_serving_token' : 'NULL AS now_serving_token'},
                  ${metricsCols.has('avg_service_seconds') ? 'avg_service_seconds' : 'NULL AS avg_service_seconds'},
                  ${metricsCols.has('break_started_at') ? 'break_started_at' : 'NULL AS break_started_at'},
                  ${metricsCols.has('break_until') ? 'break_until' : 'NULL AS break_until'},
                  ${metricsCols.has('service_started_at') ? 'service_started_at' : 'NULL AS service_started_at'},
                  ${metricsCols.has('updated_at') ? 'updated_at' : 'NULL AS updated_at'}
             FROM assigned_live_metrics
            WHERE org_id = ? AND (assigned_user_id IS NULL OR assigned_user_id = 0)
            ORDER BY updated_at DESC LIMIT 1`,
          [org_id]
        );
        metrics = m[0] || null;
      }
    }

    // Compute state + ETA
    if (metrics) {
      const now = Date.now();
      const breakUntil = metrics.break_until ? new Date(metrics.break_until).getTime() : null;
      metrics.state = breakUntil && breakUntil > now ? 'break' : 'live';

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

    res.json({ ok: true, org, booking, metrics });
  } catch (e) {
    // Return friendly JSON on errors so the front-end doesn't choke on HTML
    const message = e && e.message ? e.message : 'Internal error';
    res.status(500).json({ ok: false, error: message });
    next(e);
  }
});

module.exports = router;

