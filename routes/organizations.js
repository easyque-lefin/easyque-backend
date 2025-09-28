// routes/organizations.js
// Organization settings: limits (trial/paid + caps), banner (url or upload), map.
//
// CommonJS style. Uses services/db and middleware/auth (requireAuth).
// Mounted at /organizations in index.js.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const db = require('../services/db');
const { requireAuth } = require('../middleware/auth');

const upload = multer({ dest: path.join(__dirname, '..', 'uploads') });

/* ----------------------------------------
 * GET /organizations/:id
 * Basic org details
 * -------------------------------------- */
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const [rows] = await db.query(
      `SELECT id, name, banner_url, org_banner_url, google_map_url,
              lat, lng, now_serving_token,
              plan_mode, trial_starts_at, trial_ends_at,
              messaging_option, users_limit, daily_booking_limit, monthly_booking_limit,
              expected_bookings_per_day
         FROM organizations WHERE id = ?`, [id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'org_not_found' });
    res.json({ ok: true, org: rows[0] });
  } catch (e) { next(e); }
});

/* ----------------------------------------
 * GET /organizations/:id/limits
 * Read limits and plan info
 * -------------------------------------- */
router.get('/:id/limits', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const [rows] = await db.query(
      `SELECT id, name,
              plan_mode, trial_starts_at, trial_ends_at,
              messaging_option,
              users_limit, daily_booking_limit, monthly_booking_limit,
              expected_bookings_per_day
         FROM organizations WHERE id = ?`, [id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'org_not_found' });
    res.json({ ok: true, limits: rows[0] });
  } catch (e) { next(e); }
});

/* ----------------------------------------
 * POST /organizations/:id/limits
 * Body:
 * {
 *   plan_mode: 'trial' | 'paid',
 *   trial_days?: number (default 7),
 *   messaging_option?: 'option1' | 'option2',
 *   users_limit?: number,
 *   daily_booking_limit?: number,
 *   monthly_booking_limit?: number,
 *   expected_bookings_per_day?: number
 * }
 * -------------------------------------- */
router.post('/:id/limits', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      plan_mode,
      trial_days = 7,
      messaging_option,
      users_limit,
      daily_booking_limit,
      monthly_booking_limit,
      expected_bookings_per_day
    } = req.body || {};

    if (!plan_mode || !['trial', 'paid'].includes(plan_mode)) {
      return res.status(400).json({ ok: false, error: 'invalid_plan_mode' });
    }
    if (messaging_option && !['option1', 'option2'].includes(messaging_option)) {
      return res.status(400).json({ ok: false, error: 'invalid_messaging_option' });
    }

    // If trial, compute trial window
    let trialStarts = null, trialEnds = null;
    if (plan_mode === 'trial') {
      const [nowRows] = await db.query('SELECT NOW() AS now');
      const now = new Date(nowRows[0].now);
      trialStarts = now;
      trialEnds = new Date(now.getTime() + Number(trial_days || 7) * 86400000);
    }

    const fields = ['plan_mode = ?'];
    const vals = [plan_mode];

    if (plan_mode === 'trial') {
      fields.push('trial_starts_at = ?', 'trial_ends_at = ?');
      vals.push(trialStarts, trialEnds);
    } else {
      fields.push('trial_starts_at = NULL', 'trial_ends_at = NULL');
    }

    if (messaging_option)              { fields.push('messaging_option = ?');             vals.push(messaging_option); }
    if (users_limit != null)           { fields.push('users_limit = ?');                  vals.push(Number(users_limit)); }
    if (daily_booking_limit != null)   { fields.push('daily_booking_limit = ?');          vals.push(Number(daily_booking_limit)); }
    if (monthly_booking_limit != null) { fields.push('monthly_booking_limit = ?');        vals.push(Number(monthly_booking_limit)); }
    if (expected_bookings_per_day != null) { fields.push('expected_bookings_per_day = ?'); vals.push(Number(expected_bookings_per_day)); }

    vals.push(id);

    const sql = `UPDATE organizations SET ${fields.join(', ')} WHERE id = ?`;
    await db.query(sql, vals);

    const [rows] = await db.query(
      `SELECT id, name,
              plan_mode, trial_starts_at, trial_ends_at,
              messaging_option,
              users_limit, daily_booking_limit, monthly_booking_limit,
              expected_bookings_per_day
         FROM organizations WHERE id = ?`, [id]
    );
    res.json({ ok: true, limits: rows[0] });
  } catch (e) { next(e); }
});

/* ----------------------------------------
 * PUT /organizations/:id/banner-url
 * Body: { org_banner_url?, banner_url?, google_map_url?, lat?, lng? }
 * (Simple URL update, no file upload)
 * -------------------------------------- */
router.put('/:id/banner-url', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { org_banner_url, banner_url, google_map_url, lat, lng } = req.body || {};
    await db.query(
      `UPDATE organizations
          SET org_banner_url = COALESCE(?, org_banner_url),
              banner_url     = COALESCE(?, banner_url),
              google_map_url = COALESCE(?, google_map_url),
              lat            = COALESCE(?, lat),
              lng            = COALESCE(?, lng)
        WHERE id = ?`,
      [org_banner_url || null, banner_url || null, google_map_url || null, lat || null, lng || null, id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ----------------------------------------
 * PUT /organizations/:id/banner
 * Upload a banner image file (form-data: banner)
 * -------------------------------------- */
router.put('/:id/banner', requireAuth, upload.single('banner'), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ ok: false, error: 'file_required' });

    const rel = `/uploads/${req.file.filename}`;
    const url =
      process.env.APP_PUBLIC_BASE_URL
        ? `${process.env.APP_PUBLIC_BASE_URL}${rel}`
        : rel;

    await db.query(`UPDATE organizations SET org_banner_url = ? WHERE id = ?`, [url, id]);
    res.json({ ok: true, url });
  } catch (e) { next(e); }
});

/* ----------------------------------------
 * POST /organizations/:id/map
 * Body: { google_map_url, lat?, lng? }
 * -------------------------------------- */
router.post('/:id/map', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { google_map_url, lat, lng } = req.body || {};
    await db.query(
      `UPDATE organizations
          SET google_map_url = COALESCE(?, google_map_url),
              lat            = COALESCE(?, lat),
              lng            = COALESCE(?, lng)
        WHERE id = ?`,
      [google_map_url || null, lat || null, lng || null, id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
