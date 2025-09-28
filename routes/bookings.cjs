// routes/bookings.cjs
const express = require('express');
const router = express.Router();

const { pool } = require('../lib/db');
const { requireAuth } = require('../lib/auth');
const { enforceOrgLimits } = require('../lib/limits.cjs');

// Helpers
function toDate(val) { return val ? new Date(val) : null; }

// Create booking
router.post('/bookings', requireAuth, enforceOrgLimits, async (req, res) => {
  try {
    const {
      org_id,
      customer_name, name,                    // accept either; persist to customer_name
      phone_number, phone,                    // accept either; persist to phone_number
      department,
      booking_date, booking_time,             // classic fields
      scheduled_at,                           // or a single datetime (optional)
      assigned_user_id
    } = req.body || {};

    if (!org_id)       return res.status(400).json({ ok:false, error:'org_id_required' });
    const custName  = customer_name || name || null;
    const custPhone = phone_number || phone || null;
    if (!custName)     return res.status(400).json({ ok:false, error:'customer_name_required' });
    if (!custPhone)    return res.status(400).json({ ok:false, error:'phone_required' });

    // Resolve booking_date/time from scheduled_at if provided
    let bDate = booking_date, bTime = booking_time;
    if (scheduled_at) {
      const dt = new Date(scheduled_at);
      bDate = dt.toISOString().slice(0,10);
      bTime = dt.toISOString().slice(11,19);
    }
    if (!bDate) return res.status(400).json({ ok:false, error:'booking_date_required' });

    // Next token for this org for *today*
    const [[maxRow]] = await pool.query(
      `SELECT COALESCE(MAX(token_number), 0) AS max_token
         FROM bookings
        WHERE org_id = ?
          AND DATE(booking_date) = DATE(?)`,
      [org_id, bDate]
    );
    const nextToken = Number(maxRow.max_token) + 1;

    const bookingNumber = `${bDate.replace(/-/g,'')}-${nextToken}-${org_id}`;

    const [ins] = await pool.query(
      `INSERT INTO bookings
         (org_id, booking_number, token_number, department, booking_date, booking_time, status,
          customer_name, phone_number, assigned_user_id, scheduled_at)
       VALUES
         (?,      ?,              ?,            ?,          ?,            ?,           'pending',
          ?,             ?,             ?,               ?)`,
      [
        org_id, bookingNumber, nextToken, department || 'General',
        bDate, bTime || null,
        custName, custPhone, assigned_user_id || null,
        scheduled_at ? toDate(scheduled_at) : null
      ]
    );

    const bookingId = ins.insertId;

    // Build status link (public)
    const statusLink = `https://status.easyque.org/status.html?org_id=${org_id}&booking_id=${bookingId}`;

    // Optional messaging deep links (manual option 1)
    const wa = `https://wa.me/${String(custPhone).replace(/\D/g,'')}?text=${encodeURIComponent(`Hi! Your EasyQue live status link:\n${statusLink}`)}`;
    const sms = `sms:${String(custPhone).replace(/\D/g,'')}?&body=${encodeURIComponent(`Hi! Your EasyQue live status link: ${statusLink}`)}`;

    res.json({
      ok: true,
      booking: {
        id: bookingId,
        org_id,
        booking_number: bookingNumber,
        token_number: nextToken,
        department: department || 'General',
        booking_date: bDate,
        booking_time: bTime || null,
        status: 'pending',
        customer_name: custName,
        phone_number: custPhone,
        assigned_user_id: assigned_user_id || null
      },
      statusLink,
      wa, sms
    });
  } catch (e) {
    console.error('POST /bookings error:', e);
    res.status(500).json({ ok:false, error:'create_booking_failed' });
  }
});

// Serve a booking (advance now-serving)
router.post('/bookings/:id/serve', requireAuth, async (req, res) => {
  try {
    const bookingId = Number(req.params.id);
    const [[b]] = await pool.query(
      `SELECT id, org_id, token_number
         FROM bookings WHERE id = ?`,
      [bookingId]
    );
    if (!b) return res.status(404).json({ ok:false, error:'booking_not_found' });

    // Update org-level now_serving_token
    await pool.query(
      `UPDATE organizations SET now_serving_token = ? WHERE id = ?`,
      [b.token_number, b.org_id]
    );

    // Mark booking as served (optional)
    await pool.query(`UPDATE bookings SET status='served', served_at=NOW() WHERE id=?`, [bookingId]);

    res.json({ ok:true, served_token: b.token_number, served_at: new Date().toISOString() });
  } catch (e) {
    console.error('POST /bookings/:id/serve error:', e);
    res.status(500).json({ ok:false, error:'serve_failed' });
  }
});

// List bookings (today)
router.get('/bookings', requireAuth, async (req, res) => {
  try {
    const org_id = Number(req.query.org_id);
    const dateOpt = req.query.date || 'today';
    if (!org_id) return res.status(400).json({ ok:false, error:'org_id_required' });

    const dateCond = dateOpt === 'today' ? 'DATE(b.booking_date) = CURRENT_DATE()' : '1=1';

    const [rows] = await pool.query(
      `SELECT b.id, b.org_id, b.booking_number, b.token_number,
              b.department, b.booking_date, b.booking_time, b.status,
              b.customer_name, b.phone_number,
              b.assigned_user_id
         FROM bookings b
        WHERE b.org_id = ? AND ${dateCond}
        ORDER BY b.token_number ASC`,
      [org_id]
    );

    res.json({ ok:true, bookings: rows });
  } catch (e) {
    console.error('GET /bookings error:', e);
    res.status(500).json({ ok:false, error:'list_failed' });
  }
});

module.exports = router;
