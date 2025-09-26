const express = require('express');
const router = express.Router();
const db = require('../db');

// POST /reviews { org_id, booking_id, assigned_user_id, rating, review }
router.post('/', async (req, res, next) => {
  try {
    const { org_id, booking_id, assigned_user_id, rating, review } = req.body || {};
    const r = Number(rating);
    if (!org_id || !r || r < 1 || r > 5) return res.status(400).json({ ok:false, error:'invalid_input' });

    const result = await db.query(
      `INSERT INTO reviews (org_id, booking_id, assigned_user_id, rating, review)
       VALUES (?, ?, ?, ?, ?)`,
      [org_id, booking_id || null, assigned_user_id || null, r, review || null]
    );
    res.json({ ok:true, id: result.insertId });
  } catch (err) { next(err); }
});

// GET /reviews?org_id=...&min=...&max=...&assigned_user_id=...&from=...&to=...
router.get('/', async (req, res, next) => {
  try {
    const org_id = parseInt(req.query.org_id, 10);
    if (!org_id) return res.status(400).json({ ok:false, error:'missing_org' });

    const min = req.query.min ? parseInt(req.query.min, 10) : 1;
    const max = req.query.max ? parseInt(req.query.max, 10) : 5;
    const assigned = req.query.assigned_user_id ? parseInt(req.query.assigned_user_id, 10) : null;
    const from = req.query.from ? new Date(req.query.from) : null;
    const to   = req.query.to   ? new Date(req.query.to)   : null;

    const where = ['org_id = ?','rating BETWEEN ? AND ?'];
    const args  = [org_id, min, max];
    if (assigned) { where.push('assigned_user_id = ?'); args.push(assigned); }
    if (from)     { where.push('created_at >= ?'); args.push(from); }
    if (to)       { where.push('created_at <= ?'); args.push(to); }

    const rows = await db.query(
      `SELECT id, booking_id, assigned_user_id, rating, review, created_at
         FROM reviews WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 1000`, args
    );
    res.json({ ok:true, items: rows });
  } catch (err) { next(err); }
});

module.exports = router;
