// routes/bookings.js
// Full drop-in router for bookings (MySQL-friendly and defensive)
const express = require('express');
const db = require('../db');

const router = express.Router();

/**
 * Helper: normalize a booking row (map several possible column names)
 */
function normalizeBookingRow(row) {
  if (!row) return null;
  return {
    id: row.id || row.booking_id || null,
    token: row.token || row.booking_token || null,
    org_id: row.org_id || row.organization_id || null,
    department_id: row.department_id || row.dept_id || null,
    assigned_user_id: row.assigned_user_id || row.assigned_id || null,
    customer_name: row.customer_name || row.name || row.full_name || null,
    customer_phone: row.customer_phone || row.phone || row.mobile || null,
    booking_date: row.booking_date || row.date || null,
    status: row.status || null,
    created_at: row.created_at || row.created || null,
    raw: row // keep raw DB row for debugging if needed
  };
}

/**
 * GET /bookings?org_id=...
 * Returns { ok:true, bookings: [...] }
 */
router.get('/', async (req, res) => {
  try {
    const orgId = req.query.org_id || req.query.org || null;
    if (!orgId) return res.status(400).json({ ok: false, error: 'org_id is required' });

    // Defensive: select all columns so we don't get "Unknown column" errors if schema differs
    const sql = `SELECT * FROM bookings WHERE org_id = ? ORDER BY id DESC LIMIT 1000`;
    const rows = await db.query(sql, [orgId]);

    // rows could be an array or other shape depending on db wrapper
    const arr = Array.isArray(rows) ? rows : (rows && rows.length ? rows : []);
    const bookings = arr.map(normalizeBookingRow);

    return res.json({ ok: true, bookings });
  } catch (err) {
    console.error('GET /bookings error:', err && err.stack ? err.stack : err);
    // Include sqlMessage/details for easier debugging in development
    return res.status(500).json({ ok: false, error: 'server error', details: err && (err.sqlMessage || err.message || String(err)) });
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

    // generate a token if the schema supports it later
    const token = 'BKG' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);

    // Try to insert into the most common schema. If the column doesn't exist, MySQL will error,
    // and we'll return details in the response to guide the migration.
    const sql = `INSERT INTO bookings
      (org_id, department_id, assigned_user_id, token, name, phone, booking_date, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'created', NOW(), NOW())`;
    const params = [org_id, department_id || null, assigned_user_id || null, token, name, phone, booking_date || null];

    const r = await db.query(sql, params);
    // db.query may return { insertId } or [result]
    const insertId = (r && r.insertId) ? r.insertId : (Array.isArray(r) && r[0] && r[0].insertId ? r[0].insertId : null);

    if (!insertId) {
      // fallback: try to guess inserted id from other return shapes
      // but if we can't, return success message and let client reload by GET
      return res.status(201).json({ ok: true, booking: { id: null, info: 'inserted but insertId unavailable. Refresh bookings list.' } });
    }

    const rows = await db.query('SELECT * FROM bookings WHERE id = ? LIMIT 1', [insertId]);
    const row = Array.isArray(rows) ? rows[0] : rows;
    return res.status(201).json({ ok: true, booking: normalizeBookingRow(row) });
  } catch (err) {
    console.error('POST /bookings error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'server error', details: err && (err.sqlMessage || err.message || String(err)) });
  }
});

/**
 * GET /bookings/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ ok: false, error: 'invalid id' });
    const rows = await db.query('SELECT * FROM bookings WHERE id = ? LIMIT 1', [id]);
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row) return res.status(404).json({ ok: false, error: 'not found' });
    return res.json({ ok: true, booking: normalizeBookingRow(row) });
  } catch (err) {
    console.error('GET /bookings/:id error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'server error', details: err && (err.sqlMessage || err.message || String(err)) });
  }
});

module.exports = router;

