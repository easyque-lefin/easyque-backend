// routes/bookings.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { sendLive } = require('../services/liveBus');
const { onServe } = require('../services/metrics');

/**
 * Create a booking (STRICT schema, Option A)
 * Required: org_id, user_name, user_phone, booking_datetime (YYYY-MM-DD HH:mm:ss)
 * Optional: assigned_user_id, department, division, receptionist_id,
 *           user_email, user_alt_phone, prefer_video, notes, place
 *
 * Tokening:
 *   nextToken = MAX(token_no) for (org_id, assigned_user_id [NULL or value]) + same calendar DATE(booking_datetime)
 * booking_number:
 *   set equal to nextToken (changeable later if you prefer a different rule)
 */
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};

    const org_id = parseInt(b.org_id, 10);
    const user_name = (b.user_name || '').trim();
    const user_phone = (b.user_phone || '').trim();
    const booking_datetime = b.booking_datetime; // 'YYYY-MM-DD HH:mm:ss'
    const assigned_user_id =
      b.assigned_user_id != null ? parseInt(b.assigned_user_id, 10) : null;

    if (!org_id || !user_name || !user_phone || !booking_datetime) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }

    // Scope for token numbering: same org, same doc (or null), same DATE(booking_datetime)
    let where = 'org_id = ? AND DATE(booking_datetime) = DATE(?)';
    const args = [org_id, booking_datetime];

    if (assigned_user_id == null) {
      where += ' AND assigned_user_id IS NULL';
    } else {
      where = 'org_id = ? AND assigned_user_id = ? AND DATE(booking_datetime) = DATE(?)';
      args.splice(1, 0, assigned_user_id);
    }

    const [mx] = await db.query(
      `SELECT COALESCE(MAX(token_no),0) AS m FROM bookings WHERE ${where}`,
      args
    );
    const nextToken = (mx?.m || 0) + 1;

    // Insert ONLY columns that exist in your DB.
    // Fill booking_date / booking_time from booking_datetime (NOT NULL in schema).
    // booking_number is set to nextToken (adjust if you want a different policy).
    const insertSql = `
      INSERT INTO bookings (
        org_id,
        user_name,
        user_phone,
        user_email,
        department,
        division,
        assigned_user_id,
        receptionist_id,
        user_alt_phone,
        prefer_video,
        notes,
        place,
        booking_date,
        booking_time,
        booking_datetime,
        booking_number,
        token_no,
        status,
        created_at
      )
      VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?,
        DATE(?),
        TIME(?),
        ?,
        ?,        -- booking_number
        ?,        -- token_no
        'waiting',
        NOW()
      )
    `;

    const params = [
      org_id,
      user_name,
      user_phone,
      b.user_email ?? null,
      b.department ?? null,
      b.division ?? null,
      assigned_user_id,
      b.receptionist_id ?? null,
      b.user_alt_phone ?? null,
      b.prefer_video ?? 0,
      b.notes ?? null,
      b.place ?? null,
      booking_datetime, // DATE(?)
      booking_datetime, // TIME(?)
      booking_datetime, // booking_datetime
      nextToken,        // booking_number
      nextToken         // token_no
    ];

    await db.query(insertSql, params);

    // Live broadcast to viewers
    await sendLive(org_id, assigned_user_id || null);

    res.json({
      ok: true,
      booking: {
        org_id,
        assigned_user_id,
        user_name,
        user_phone,
        booking_datetime,
        token_no: nextToken,
        booking_number: nextToken,
        place: b.place ?? null
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Serve a booking
 * Marks served_at and updates live metrics, then broadcasts.
 */
router.post('/:id/serve', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad_id' });

    const [bk] = await db.query(
      `SELECT id, org_id, assigned_user_id, token_no, booking_datetime
         FROM bookings
        WHERE id = ?
        LIMIT 1`,
      [id]
    );
    if (!bk) return res.status(404).json({ ok: false, error: 'not_found' });

    await db.query(
      `UPDATE bookings
          SET served_at = NOW(),
              status = 'served'
        WHERE id = ?`,
      [id]
    );

    // Update metrics and broadcast
    await onServe(bk.org_id, bk.assigned_user_id || null);
    await sendLive(bk.org_id, bk.assigned_user_id || null);

    res.json({ ok: true, served_at: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
