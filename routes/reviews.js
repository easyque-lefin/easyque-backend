const express = require('express');
const router = express.Router();

// expects you have a DB helper similar to db.query(sql, params)
const db = require('../db'); // adjust if your helper lives elsewhere
const { requireAuth } = require('../middleware/auth'); // your JWT middleware

// UTIL: ensure integer or null
const toInt = (v) => (v === undefined || v === null || v === '' ? null : parseInt(v, 10));

/**
 * POST /reviews/create
 * Body: { org_id, booking_id, rating, review, assigned_user_id? }
 * - Stores review internally always
 * - If rating >= 4 and org.google_review_url exists, returns it for the client to open
 */
router.post('/create', requireAuth, async (req, res, next) => {
  try {
    const org_id = toInt(req.body.org_id);
    const booking_id = toInt(req.body.booking_id);
    const assigned_user_id = toInt(req.body.assigned_user_id);
    const rating = toInt(req.body.rating);
    const review = (req.body.review || '').toString().trim();

    if (!org_id || !rating || rating < 1 || rating > 5) {
      return res.status(400).json({ ok: false, error: 'org_id and rating(1-5) required' });
    }

    // Insert internal review
    await db.query(
      `INSERT INTO reviews (org_id, booking_id, assigned_user_id, rating, review, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [org_id, booking_id, assigned_user_id, rating, review]
    );

    // If 4+ stars, fetch org.google_review_url to help client redirect
    let google_review_url = null;
    if (rating >= 4) {
      const [rows] = await db.query(
        `SELECT google_review_url FROM organizations WHERE id = ? LIMIT 1`,
        [org_id]
      );
      if (rows && rows[0] && rows[0].google_review_url) {
        google_review_url = rows[0].google_review_url;
      }
    }

    return res.json({
      ok: true,
      stored: true,
      // client should open this URL for the user (cannot auto-submit to Google)
      google_review_url: google_review_url || null
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /reviews
 * Query: org_id (required), assigned_user_id? (optional), limit?, offset?
 */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const org_id = toInt(req.query.org_id);
    const assigned_user_id = toInt(req.query.assigned_user_id);
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);

    if (!org_id) {
      return res.status(400).json({ ok: false, error: 'org_id required' });
    }

    const params = [org_id];
    let where = `WHERE r.org_id = ?`;

    if (assigned_user_id) {
      where += ` AND (r.assigned_user_id = ? OR r.assigned_user_id IS NULL)`;
      params.push(assigned_user_id);
    }

    params.push(limit, offset);

    const [rows] = await db.query(
      `SELECT r.id, r.org_id, r.booking_id, r.assigned_user_id, r.rating, r.review, r.created_at
       FROM reviews r
       ${where}
       ORDER BY r.created_at DESC
       LIMIT ? OFFSET ?`,
      params
    );

    return res.json({ ok: true, reviews: rows });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /reviews/summary
 * Query: org_id (required), assigned_user_id? (optional)
 * Returns: count, average, and per-star breakdown
 */
router.get('/summary', requireAuth, async (req, res, next) => {
  try {
    const org_id = toInt(req.query.org_id);
    const assigned_user_id = toInt(req.query.assigned_user_id);

    if (!org_id) {
      return res.status(400).json({ ok: false, error: 'org_id required' });
    }

    let where = `WHERE org_id = ?`;
    const params = [org_id];

    if (assigned_user_id) {
      where += ` AND (assigned_user_id = ? OR assigned_user_id IS NULL)`;
      params.push(assigned_user_id);
    }

    const [[sumRow]] = await db.query(
      `SELECT COUNT(*) AS cnt, AVG(rating) AS avg_rating FROM reviews ${where}`,
      params
    );

    const [breakdownRows] = await db.query(
      `SELECT rating, COUNT(*) AS c FROM reviews ${where} GROUP BY rating`,
      params
    );

    const breakdown = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
    for (const r of breakdownRows) {
      breakdown[String(r.rating)] = Number(r.c);
    }

    return res.json({
      ok: true,
      org_id,
      assigned_user_id: assigned_user_id || null,
      count: Number(sumRow?.cnt || 0),
      avg_rating: sumRow?.avg_rating ? Number(sumRow.avg_rating) : 0,
      breakdown
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;


