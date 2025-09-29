// routes/bookings_export.js — CSV export; uses token_number

const express = require('express');
const stringify = require('csv-stringify/sync').stringify;
const dayjs = require('dayjs');

const router = express.Router();
const db = require('../services/db');
const { requireAuth } = require('../middleware/auth');

router.get('/csv', requireAuth, async (req, res, next) => {
  try {
    const org_id = Number(req.query.org_id || 0);
    const from = (req.query.from || '').trim();
    const to = (req.query.to || '').trim();
    if (!org_id) return res.status(400).json({ ok:false, error:'org_id required' });

    const p = [org_id];
    let where = `WHERE org_id = ?`;
    if (from) { where += ` AND booking_date >= ?`; p.push(from); }
    if (to)   { where += ` AND booking_date <= ?`; p.push(to); }

    const [rows] = await db.query(
      `SELECT id, booking_date, user_name, user_phone, assigned_user_id,
              status, token_number, scheduled_at, created_at
         FROM bookings
        ${where}
        ORDER BY booking_date DESC, token_number ASC`,
      p
    );

    const csv = stringify(rows, { header: true });
    const file = `bookings_${org_id}_${dayjs().format('YYYYMMDD_HHmmss')}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    res.send(csv);
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.default = router;
