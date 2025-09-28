// routes/organizations.js
// Organizations router with ping + GET/POST :id/limits
// Accepts plan_mode = 'semi' | 'full' | 'trial'
// If 'trial' and trial_days provided, sets trial_starts_at/ends_at (only if columns exist)

const express = require('express');
const router = express.Router();
const db = require('../services/db');
const { requireAuth } = require('../middleware/auth');

// --- Proof router is mounted ---
router.get('/ping', (req, res) => {
  res.json({ ok: true, where: 'organizations', ts: new Date().toISOString() });
});

// --- GET /organizations/:id/limits ---
router.get('/:id/limits', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'invalid_org_id' });

    const [rows] = await db.query(`SELECT * FROM organizations WHERE id = ?`, [id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'org_not_found' });

    res.json({ ok: true, limits: rows[0] });
  } catch (err) { next(err); }
});

// --- POST /organizations/:id/limits ---
// Body can include:
//   plan_mode: 'semi'|'full'|'trial'
//   trial_days: number (used only when plan_mode='trial')
//   users_count / users_limit
//   map_url
//   messaging_option: 'option1'|'option2'
//   daily_booking_limit / monthly_booking_limit / expected_bookings_per_day
router.post('/:id/limits', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'invalid_org_id' });

    const body = req.body || {};

    // --- Validate plan_mode for your product ---
    const allowedModes = new Set(['semi', 'full', 'trial']);
    if (body.plan_mode && !allowedModes.has(String(body.plan_mode))) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_plan_mode (use "semi", "full" or "trial")'
      });
    }

    // --- Discover actual columns to stay compatible with your live DB ---
    const [colsRows] = await db.query(
      `SELECT COLUMN_NAME
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'organizations'`
    );
    const cols = new Set(colsRows.map(r => r.COLUMN_NAME));

    const sets = [];
    const vals = [];
    const nowSql = 'NOW()';

    const setIf = (col, val) => {
      if (cols.has(col) && typeof val !== 'undefined') {
        sets.push(`${col} = ?`);
        vals.push(val);
      }
    };
    const setNowIf = (col) => {
      if (cols.has(col)) {
        sets.push(`${col} = ${nowSql}`);
      }
    };
    const setNullIf = (col) => {
      if (cols.has(col)) {
        sets.push(`${col} = NULL`);
      }
    };

    // --- plan_mode + trial windows ---
    if (typeof body.plan_mode !== 'undefined') {
      setIf('plan_mode', body.plan_mode);
      if (body.plan_mode === 'trial') {
        // When entering trial, set trial_starts_at=NOW() and trial_ends_at=NOW()+trial_days
        const trialDays = Number(body.trial_days) || 7;
        if (cols.has('trial_starts_at')) setNowIf('trial_starts_at');
        if (cols.has('trial_ends_at'))  sets.push(`trial_ends_at = DATE_ADD(${nowSql}, INTERVAL ? DAY)`), vals.push(trialDays);
      } else {
        // when switching to paid, clear trial dates if columns exist
        if (cols.has('trial_starts_at')) setNullIf('trial_starts_at');
        if (cols.has('trial_ends_at'))  setNullIf('trial_ends_at');
      }
    }

    // --- messaging plan selection ---
    // (Only applied if column exists; otherwise ignored harmlessly)
    if (typeof body.messaging_option !== 'undefined') {
      setIf('messaging_option', body.messaging_option); // enum('option1','option2') if you add it
    }

    // --- common caps/fields ---
    // Your table uses users_count (not users_limit)
    if (typeof body.users_count !== 'undefined') setIf('users_count', body.users_count);
    if (typeof body.users_limit !== 'undefined') setIf('users_count', body.users_limit); // accept alias from UI

    if (typeof body.map_url !== 'undefined') setIf('map_url', body.map_url);

    // Optional caps (only if these columns exist)
    setIf('daily_booking_limit',        body.daily_booking_limit);
    setIf('monthly_booking_limit',      body.monthly_booking_limit);
    setIf('expected_bookings_per_day',  body.expected_bookings_per_day);

    if (!sets.length) {
      return res.status(400).json({ ok: false, error: 'no_updatable_fields_found_for_current_schema' });
    }

    vals.push(id);
    await db.query(`UPDATE organizations SET ${sets.join(', ')} WHERE id = ?`, vals);

    const [rows] = await db.query(`SELECT * FROM organizations WHERE id = ?`, [id]);
    res.json({ ok: true, limits: rows[0] || null });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.default = router;


