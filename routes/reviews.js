// routes/reviews.js — POST + GET internal reviews

const express = require('express');
const router = express.Router();
const db = require('../services/db');

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

// POST /reviews
// body: { org_id, rating(1-5), review?, booking_id?, assigned_user_id? }
router.post('/', async (req, res, next) => {
  try {
    const { org_id, rating, review, booking_id, assigned_user_id } = req.body || {};
    if (!org_id) return res.status(400).json({ ok: false, error: 'org_id required' });
    let r = Number(rating);
    if (!Number.isFinite(r)) return res.status(400).json({ ok: false, error: 'rating invalid' });
    r = clamp(Math.round(r), 1, 5);

    const [result] = await db.query(
      `INSERT INTO reviews (org_id, booking_id, assigned_user_id, rating, review, created_at)
       VALUES (?,?,?,?,?, NOW())`,
      [org_id, booking_id || null, assigned_user_id || null, r, review || null]
    );
    res.json({ ok: true, id: result.insertId });
  } catch (e) { next(e); }
});

// GET /reviews?org_id=&assigned_user_id=&min=&max=&from=&to=
router.get('/', async (req, res, next) => {
  try {
    const { org_id, assigned_user_id, min, max, from, to } = req.query;
    const q = [];
    const p = [];
    if (org_id) { q.push('org_id = ?'); p.push(org_id); }
    if (assigned_user_id) { q.push('assigned_user_id = ?'); p.push(assigned_user_id); }
    if (min) { q.push('rating >= ?'); p.push(Number(min)); }
    if (max) { q.push('rating <= ?'); p.push(Number(max)); }
    if (from) { q.push('created_at >= ?'); p.push(from); }
    if (to) { q.push('created_at <= ?'); p.push(to); }

    const where = q.length ? `WHERE ${q.join(' AND ')}` : '';
    const [rows] = await db.query(
      `SELECT id, org_id, booking_id, assigned_user_id, rating, review, created_at
       FROM reviews ${where} ORDER BY created_at DESC LIMIT 500`, p);
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

module.exports = router;

