// routes/bookings.js
// Full drop-in router for bookings with correct schema mapping
const express = require('express');
const db = require('../db');

const router = express.Router();

/**
 * Map DB row to API booking object
 */
function normalizeBookingRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    org_id: row.org_id,
    department: row.department,
    division: row.division,
    assigned_user_id: row.assigned_user_id,
    receptionist_id: row.receptionist_id,
    customer_name: row.user_name,
    customer_phone: row.user_phone,
    customer_alt_phone: row.user_alt_phone,
    customer_email: row.user_email,
    booking_date: row.booking_date,
    booking_time: row.booking_time,
    token: row.token_no || row.booking_number || null, // map to "token"
    status: row.status,
    prefer_video: row.prefer_video,
    notes: row.notes,
    notes_images: row.notes_images,
    queue_code: row.queue_code,
    created_at: row.created_at,
    updated_at: row.updated_at,
    served_at: row.served_at,
    served_by: row.served_by,
    booking_user_id: row.booking_user_id,
    reassigned_from: row.reassigned_from,
    reassigned_reason: row.reassigned_reason
  };
}

/**
 * GET /bookings?org_id=...
 */
router.get('/', async (req, res) => {
  try {
    const orgId = req.query.org_id;
    if (!orgId) return res.status(400).json({ ok: false, error: 'org_id is required' });

    const sql = `SELECT * FROM bookings WHERE org_id = ? ORDER BY id DESC LIMIT 100`;
    const rows = await db.query(sql, [orgId]);

    const arr = Array.isArray(rows) ? rows : [];
    const bookings = arr.map(normalizeBookingRow);

    return res.json({ ok: true, bookings });
  } catch (err) {
    console.error('GET /bookings error:', err);
    return res.status(500).json({
      ok: false,
      error: 'server error',
      details: err.sqlMessage || err.message
    });
  }
});

/**
 * POST /bookings
 */
router.post('/', async (req, res) => {
  try {
    const { org_id, department, division, assigned_user_id, user_name, user_phone, booking_date, booking_time } = req.body;

    if (!org_id || !user_name || !user_phone) {
      return res.status(400).json({ ok: false, error: 'org_id, user_name, and user_phone are required' });
    }

    // generate a booking_number
    const booking_number = 'BKG' + Date.now().toString(36).toUpperCase();

    const sql = `
      INSERT INTO bookings 
      (org_id, department, division, assigned_user_id, user_name, user_phone, booking_date, booking_time, booking_number, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', NOW(), NOW())
    `;
    const params = [org_id, department || null, division || null, assigned_user_id || null, user_name, user_phone, booking_date, booking_time || null, booking_number];

    const r = await db.query(sql, params);

    return res.status(201).json({ ok: true, booking: { id: r.insertId, token: booking_number, user_name, user_phone } });
  } catch (err) {
    console.error('POST /bookings error:', err);
    return res.status(500).json({
      ok: false,
      error: 'server error',
      details: err.sqlMessage || err.message
    });
  }
});

/**
 * GET /bookings/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const rows = await db.query('SELECT * FROM bookings WHERE id = ? LIMIT 1', [id]);

    if (!rows || rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'not found' });
    }

    return res.json({ ok: true, booking: normalizeBookingRow(rows[0]) });
  } catch (err) {
    console.error('GET /bookings/:id error:', err);
    return res.status(500).json({
      ok: false,
      error: 'server error',
      details: err.sqlMessage || err.message
    });
  }
});

module.exports = router;

