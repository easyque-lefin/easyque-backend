const express = require('express');
const router = express.Router();
const db = require('../db');
const { onServe } = require('../services/metrics');
const { sendLive } = require('../services/liveBus');

// Create booking (kept simple; use your existing validation)
router.post('/', async (req, res, next) => {
  try {
    const { org_id, user_name, user_phone, booking_date, assigned_user_id = null } = req.body;
    if (!org_id || !user_name || !booking_date) {
      return res.status(400).json({ ok:false, error:'missing_fields' });
    }

    // Next token for that scope (org OR org+assigned user) on that date
    const [maxRow] = await db.query(
      `SELECT MAX(token_no) AS maxToken
         FROM bookings
        WHERE org_id = ?
          AND (${assigned_user_id ? 'assigned_user_id = ?' : '1=1'})
          AND booking_date = ?`,
      assigned_user_id ? [org_id, assigned_user_id, booking_date] : [org_id, booking_date]
    );
    const nextToken = (maxRow[0].maxToken || 0) + 1;

    // create code + link
    const queue_code = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    const base = (process.env.LIVE_BASE_URL || '').replace(/\/+$/, '');
    const status_link = base ? `${base}/status/${queue_code}` : `/status/${queue_code}`;

    const [ins] = await db.query(
      `INSERT INTO bookings
         (org_id, user_name, user_phone, booking_date, token_no, queue_code, status_link, assigned_user_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,NOW())`,
      [org_id, user_name, user_phone || null, booking_date, nextToken, queue_code, status_link, assigned_user_id]
    );

    res.json({
      ok: true,
      booking: {
        id: ins.insertId,
        org_id,
        token_no: nextToken,
        queue_code,
        status_link
      }
    });
  } catch (e) { next(e); }
});

// Serve by booking id
router.post('/:id/serve', async (req, res, next) => {
  try {
    const bookingId = parseInt(req.params.id, 10);
    const [rows] = await db.query(
      `SELECT id, org_id, token_no, assigned_user_id FROM bookings WHERE id = ?`,
      [bookingId]
    );
    if (!rows.length) return res.status(404).json({ ok:false, error:'not_found' });
    const bk = rows[0];

    // mark served_at now
    const now = new Date();
    await db.query(`UPDATE bookings SET served_at = ? WHERE id = ?`, [now, bookingId]);

    // update metrics (org or org+assigned user)
    const resu = await onServe({
      orgId: bk.org_id,
      assignedUserId: bk.assigned_user_id || null,
      bookingTokenNo: bk.token_no
    });

    // broadcast live
    await sendLive(bk.org_id, bk.assigned_user_id || null);

    res.json({ ok:true, served_at: now, ...resu });
  } catch (e) { next(e); }
});

module.exports = router;

