// routes/orgs.js
// Org CRUD bits: banner upload + google_review_url + set limits

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../services/db');

const upload = multer({ dest: path.join(__dirname, '..', 'uploads') });

// GET org by id
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const [[org]] = await db.query(`SELECT * FROM organizations WHERE id = ?`, [id]);
    if (!org) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, org });
  } catch (e) { next(e); }
});

// Upload banner + set google_review_url
router.post('/:id/banner', upload.single('banner'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { google_review_url } = req.body || {};
    let url = null;
    if (req.file) {
      const ext = path.extname(req.file.originalname || '') || '.jpg';
      const final = path.join(req.file.destination, `${req.file.filename}${ext}`);
      fs.renameSync(req.file.path, final);
      url = `/uploads/${path.basename(final)}`;
      await db.query(`UPDATE organizations SET org_banner_url = ? WHERE id = ?`, [url, id]);
    }
    if (google_review_url) {
      await db.query(`UPDATE organizations SET google_review_url = ? WHERE id = ?`, [google_review_url, id]);
    }
    res.json({ ok: true, url });
  } catch (e) { next(e); }
});

// Set org limits and plan mode (semi/full) + users_count + expected_bookings_per_day
router.post('/:id/limits', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { plan_mode, users_count, expected_bookings_per_day } = req.body || {};
    const monthly = expected_bookings_per_day ? Number(expected_bookings_per_day) * 30 : null;
    await db.query(
      `UPDATE organizations
       SET plan_mode = COALESCE(?, plan_mode),
           users_count = COALESCE(?, users_count),
           expected_bookings_per_day = COALESCE(?, expected_bookings_per_day),
           monthly_expected_bookings = COALESCE(?, monthly_expected_bookings)
       WHERE id = ?`,
      [plan_mode || null, users_count || null, expected_bookings_per_day || null, monthly, id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Break controls (per assignee)
router.post('/:id/break/start', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { user_id, minutes = 15 } = req.body || {};
    if (!user_id) return res.status(400).json({ ok: false, error: 'user_id required' });

    // Store in assigned_live_metrics (org_id, assigned_user_id, booking_date=today)
    const today = new Date();
    const yyyy = today.getFullYear(), mm = String(today.getMonth()+1).padStart(2,'0'), dd = String(today.getDate()).padStart(2,'0');
    const booking_date = `${yyyy}-${mm}-${dd}`;
    const until = new Date(Date.now() + Number(minutes)*60000);

    await db.query(
      `INSERT INTO assigned_live_metrics
       (org_id, assigned_user_id, booking_date, break_started_at, break_until, updated_at)
       VALUES (?,?,?,?,?, NOW())
       ON DUPLICATE KEY UPDATE break_started_at=VALUES(break_started_at), break_until=VALUES(break_until), updated_at=NOW()`,
      [id, user_id, booking_date, new Date(), until]
    );
    res.json({ ok: true, break_until: until });
  } catch (e) { next(e); }
});

router.post('/:id/break/end', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { user_id } = req.body || {};
    if (!user_id) return res.status(400).json({ ok: false, error: 'user_id required' });

    const today = new Date();
    const yyyy = today.getFullYear(), mm = String(today.getMonth()+1).padStart(2,'0'), dd = String(today.getDate()).padStart(2,'0');
    const booking_date = `${yyyy}-${mm}-${dd}`;

    await db.query(
      `UPDATE assigned_live_metrics
       SET break_until = NULL, break_started_at = NULL, updated_at = NOW()
       WHERE org_id = ? AND assigned_user_id = ? AND booking_date = ?`,
      [id, user_id, booking_date]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
