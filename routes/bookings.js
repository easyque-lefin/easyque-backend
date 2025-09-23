// routes/bookings.js
const express = require('express');
const db = require('../db');
const crypto = require('crypto');

const router = express.Router();

/**
 * GET /bookings?org_id=123
 * Returns JSON: { ok:true, bookings: [ ... ] }
 */
router.get('/', async (req, res) => {
  try {
    const orgId = req.query.org_id || req.query.org || null;
    if (!orgId) return res.status(400).json({ ok: false, error: 'org_id is required' });

    const sql = `SELECT id, token, org_id, department_id, assigned_user_id,
                        name AS customer_name,
                        phone AS customer_phone,
                        booking_date, status, created_at
                 FROM bookings
                 WHERE org_id = ?
                 ORDER BY id DESC
                 LIMIT 1000`;
    const rows = await db.query(sql, [orgId]);
    return res.json({ ok: true, bookings: Array.isArray(rows) ? rows : [] });
  } catch (err) {
    console.error('GET /bookings error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

/**
 * POST /bookings
 * Creates a booking (demo / quick create)
 * body: { org_id, department_id, assigned_user_id, name, phone, booking_date }
 */
router.post('/', async (req, res) => {
  try {
    const { org_id, department_id, assigned_user_id, name, phone, booking_date } = req.body || {};
    if (!org_id || !name || !phone) return res.status(400).json({ ok: false, error: 'org_id, name and phone are required' });

    // simple token generator
    const token = 'BKG' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);

    const sql = `INSERT INTO bookings
      (org_id, department_id, assigned_user_id, token, name, phone, booking_date, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'created', NOW(), NOW())`;
    const params = [org_id, department_id || null, assigned_user_id || null, token, name, phone, booking_date || null];

    const r = await db.query(sql, params);
    const insertId = (r && r.insertId) ? r.insertId : (Array.isArray(r) && r[0] && r[0].insertId ? r[0].insertId : null);

    const row = await db.query('SELECT id, token, name AS customer_name, phone AS customer_phone, booking_date, status FROM bookings WHERE id = ? LIMIT 1', [insertId]);
    return res.status(201).json({ ok: true, booking: Array.isArray(row) ? row[0] : row });
  } catch (err) {
    console.error('POST /bookings error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

/**
 * GET /bookings/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ ok: false, error: 'invalid id' });
    const rows = await db.query('SELECT id, token, name AS customer_name, phone AS customer_phone, booking_date, status FROM bookings WHERE id = ? LIMIT 1', [id]);
    const booking = Array.isArray(rows) ? rows[0] : rows;
    if (!booking) return res.status(404).json({ ok: false, error: 'not found' });
    return res.json({ ok: true, booking });
  } catch (err) {
    console.error('GET /bookings/:id error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

module.exports = router;
