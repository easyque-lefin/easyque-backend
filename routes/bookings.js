// routes/bookings.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { onServe } = require('../services/metrics');
const { sendLive } = require('../services/liveBus');

// Create booking: assigns next token number per (org, assigned_user_id?, date)
router.post('/', async (req, res, next) => {
  try {
    const {
      org_id,
      full_name,
      phone,
      email = null,
      place = null,
      department = null,
      assigned_user_id = null,
      booking_datetime // ISO or 'YYYY-MM-DD HH:mm:ss'
    } = req.body;

    if (!org_id || !full_name || !phone || !booking_datetime) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }

    const orgId = parseInt(org_id, 10);
    const assignedUserId = assigned_user_id ? parseInt(assigned_user_id, 10) : null;

    // Compute date scope
    // NOTE: Use DATE(booking_datetime) to scope tokens by day
    const [mx] = await db.query(
      assignedUserId
        ? `SELECT COALESCE(MAX(token_no),0) AS m
             FROM bookings
            WHERE org_id = ?
              AND assigned_user_id = ?
              AND DATE(booking_datetime) = DATE(?)
          `
        : `SELECT COALESCE(MAX(token_no),0) AS m
             FROM bookings
            WHERE org_id = ?
              AND assigned_user_id IS NULL
              AND DATE(booking_datetime) = DATE(?)
          `,
      assignedUserId ? [orgId, assignedUserId, booking_datetime] : [orgId, booking_datetime]
    );

    const nextToken = (mx?.m || 0) + 1;

    const r = await db.query(
      `INSERT INTO bookings
       (org_id, full_name, phone, email, place, department, assigned_user_id, booking_datetime, token_no, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', NOW())`,
      [orgId, full_name, phone, email, place, department, assignedUserId, booking_datetime, nextToken]
    );

    const bookingId = r.insertId;

    // TODO: trigger notifications (SMS/WA/email) with live status link
    // (hook into services/notifications.js when ready)

    // Push a live snapshot so the board updates
    await sendLive(orgId, assignedUserId);

    res.json({
      ok: true,
      booking_id: bookingId,
      token_no: nextToken
    });
  } catch (e) { next(e); }
});

// Serve a booking (mark served_at, update metrics/average, broadcast live)
// POST /bookings/:id/serve
router.post('/:id/serve', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const now = new Date();

    // Fetch booking
    const [bk] = await db.query(
      `SELECT id, org_id, assigned_user_id, token_no, booking_datetime, served_at, status
         FROM bookings
        WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!bk) return res.status(404).json({ ok: false, error: 'not_found' });

    // Already served? return idempotently
    if (bk.served_at) {
      // still broadcast (it might move the "now serving" number for others)
      await sendLive(bk.org_id, bk.assigned_user_id || null);
      return res.json({ ok: true, already_served: true, served_at: bk.served_at });
    }

    // Mark served
    await db.query(
      `UPDATE bookings
          SET served_at = NOW(),
              status = 'served'
        WHERE id = ?`,
      [id]
    );

    // Update org/assigned metrics (avg_seconds, now_serving_token, clocks, etc.)
    const metricsResult = await onServe(
      bk.org_id,
      bk.assigned_user_id || null,
      bk.token_no,
      now
    );

    // Broadcast to listeners
    await sendLive(bk.org_id, bk.assigned_user_id || null);

    res.json({
      ok: true,
      served_at: now,
      metrics: metricsResult
    });
  } catch (e) { next(e); }
});

module.exports = router;

