// routes/bookings.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { sendLive } = require('../services/liveBus');
const { onServe } = require('../services/metrics');

/**
 * Create a booking
 * Strict schema (Option A):
 *   - user_name, user_phone, booking_datetime, org_id
 * Optional:
 *   - assigned_user_id, department, division, receptionist_id,
 *     user_email, user_alt_phone, prefer_video, notes, place
 *
 * Tokening rule:
 *   Next token = MAX(token_no) for (org_id, assigned_user_id NULL or value) and DATE(booking_datetime)
 */
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};

    const org_id = parseInt(b.org_id, 10);
    const user_name = (b.user_name || '').trim();
    const user_phone = (b.user_phone || '').trim();
    const booking_datetime = b.booking_datetime; // Expect 'YYYY-MM-DD HH:mm:ss'
    const assigned_user_id = b.assigned_user_id != null ? parseInt(b.assigned_user_id, 10) : null;

    if (!org_id || !user_name || !user_phone || !booking_datetime) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }

    // scope for the day
    const dayArg = booking_datetime;

    let where = 'org_id = ? AND DATE(booking_datetime) = DATE(?)';
    const args = [org_id, dayArg];

    if (assigned_user_id == null) {
      where += ' AND assigned_user_id IS NULL';
    } else {
      where += ' AND assigned_user_id = ?';
      args.splice(1,0,assigned_user_id); // keep order: org_id, assigned_user_id, day
    }

    const [mx] = await db.query(
      `SELECT COALESCE(MAX(token_no),0) AS m FROM bookings WHERE ${where}`,
      args
    );
    const nextToken = (mx?.m || 0) + 1;

    // Insert
    const insertCols = [
      'org_id','user_name','user_phone','user_email','place','department','division',
      'assigned_user_id','receptionist_id','prefer_video','notes','booking_datetime','token_no','status','created_at'
    ];
    const insertVals = [
      org_id,
      user_name,
      user_phone,
      b.user_email ?? null,
      b.place ?? null,
      b.department ?? null,
      b.division ?? null,
      assigned_user_id,
      b.receptionist_id ?? null,
      b.prefer_video ?? 0,
      b.notes ?? null,
      booking_datetime,
      nextToken,
      'waiting',
      new Date()
    ];

    const r = await db.query(
      `INSERT INTO bookings (${insertCols.join(',')}) VALUES (${insertCols.map(_=>'?').join(',')})`,
      insertVals
    );

    // Fire a live update (org-wide and/or doctor specific channel)
    await sendLive(org_id, assigned_user_id || null);

    res.json({
      ok: true,
      booking: {
        id: r.insertId,
        token_no: nextToken,
        org_id,
        assigned_user_id,
        user_name,
        user_phone,
        booking_datetime
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
    if (!id) return res.status(400).json({ ok:false, error:'bad_id' });

    const [bk] = await db.query(
      `SELECT id, org_id, assigned_user_id, token_no, booking_datetime
         FROM bookings
        WHERE id = ?
        LIMIT 1`,
      [id]
    );
    if (!bk) return res.status(404).json({ ok:false, error:'not_found' });

    await db.query(`UPDATE bookings SET served_at = NOW(), status = 'served' WHERE id = ?`, [id]);

    // Update metrics snapshot (average etc.)
    await onServe(bk.org_id, bk.assigned_user_id || null);

    // Broadcast a live update
    await sendLive(bk.org_id, bk.assigned_user_id || null);

    res.json({ ok:true, served_at: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
