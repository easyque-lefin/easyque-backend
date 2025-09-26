// routes/bookings.js
// Create/list bookings with token per org × assignee × booking day + confirmation links

const express = require('express');
const router = express.Router();
const db = require('../services/db');
const { bookingLimitsGuard } = require('../middleware/limits');
const { buildStatusLink, sendBookingConfirmation } = require('../services/messaging');

// Return YYYY-MM-DD for IST by adjusting +5:30 offset approximately (server TZ agnostic)
function istDateString(date = new Date()) {
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  const ist = new Date(utc + 19800000); // +5.5h
  const yyyy = ist.getFullYear();
  const mm = String(ist.getMonth()+1).padStart(2,'0');
  const dd = String(ist.getDate()).padStart(2,'0');
  return `${yyyy}-${mm}-${dd}`;
}

// List (basic)
router.get('/', async (req, res, next) => {
  try {
    const { org_id } = req.query;
    if (!org_id) return res.json({ ok: true, rows: [] });
    const [rows] = await db.query(
      `SELECT id, org_id, assigned_user_id, token_number, status, customer_name, customer_phone, booking_date, created_at
       FROM bookings
       WHERE org_id = ?
       ORDER BY id DESC LIMIT 500`,
      [org_id]
    );
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

// Create (with token per org×assignee×date) + send manual links
router.post('/', bookingLimitsGuard, async (req, res, next) => {
  try {
    const {
      org_id,
      customer_name,
      customer_phone,
      alternate_phone,
      email,
      place,
      department_id,
      assigned_user_id,
      when,                 // optional ISO
      query_issue,
      send_payment_link,    // optional
      payment_link          // optional
    } = req.body || {};

    if (!org_id) return res.status(400).json({ ok: false, error: 'org_id required' });
    if (!customer_phone) return res.status(400).json({ ok: false, error: 'customer_phone required' });

    // Determine booking_date (YYYY-MM-DD IST)
    let booking_date = istDateString(when ? new Date(when) : new Date());

    // Compute next token per (org, assignee, booking_date)
    const [maxRows] = await db.query(
      `SELECT COALESCE(MAX(token_number),0) AS maxToken
       FROM bookings WHERE org_id = ? AND assigned_user_id = ? AND booking_date = ?`,
      [org_id, assigned_user_id || 0, booking_date]
    );
    const nextToken = Number(maxRows[0]?.maxToken || 0) + 1;

    // Insert booking
    const [ins] = await db.query(
      `INSERT INTO bookings
         (org_id, customer_name, customer_phone, alternate_phone, email, place,
          department_id, assigned_user_id, booking_date,
          scheduled_at, token_number, status, query_issue, created_at)
       VALUES (?,?,?,?,?,?,?,?,?, ?, ?, 'pending', ?, NOW())`,
      [
        org_id, customer_name || null, customer_phone, alternate_phone || null, email || null, place || null,
        department_id || null, assigned_user_id || 0, booking_date,
        when ? new Date(when) : null, nextToken, query_issue || null
      ]
    );
    const booking_id = ins.insertId;

    // Get org name for message
    const [[org]] = await db.query(`SELECT name FROM organizations WHERE id = ?`, [org_id]);
    const orgName = org?.name || 'EasyQue';

    // Build status link and manual messaging links
    const statusLink = buildStatusLink({ org_id, booking_id });
    const links = await sendBookingConfirmation({
      toPhone: customer_phone,
      orgName,
      statusLink
    });

    res.json({
      ok: true,
      booking: {
        id: booking_id,
        org_id, token_number: nextToken, booking_date,
        status: 'pending'
      },
      statusLink,
      messaging: links
    });
  } catch (e) { next(e); }
});

module.exports = router;
