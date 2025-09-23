// routes/admin.js
const express = require('express');
const db = require('../db');
const jwt = require('jsonwebtoken');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';

// Simple middleware to check JWT and role admin
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ ok: false, error: 'missing token' });
  try {
    const decoded = jwt.verify(m[1], JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'invalid token' });
  }
}
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || (req.user.role || '') !== role) return res.status(403).json({ ok: false, error: 'forbidden' });
    return next();
  };
}

/**
 * GET /admin/fees
 * Return a map { key: value } using fee_settings table
 */
router.get('/fees', async (req, res) => {
  try {
    const rows = await db.query('SELECT key_name, value_decimal, value_text FROM fee_settings');
    const map = {};
    if (Array.isArray(rows)) {
      rows.forEach(r => {
        // prefer numeric decimal if present, otherwise value_text
        if (r.value_decimal !== null && r.value_decimal !== undefined && r.value_decimal !== '') map[r.key_name] = Number(r.value_decimal);
        else map[r.key_name] = r.value_text !== undefined && r.value_text !== null ? r.value_text : null;
      });
    }
    return res.json({ ok: true, fees: map });
  } catch (err) {
    console.error('GET /admin/fees error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

/**
 * PUT /admin/fees { key, value }
 * Upsert into fee_settings. Protected (admin).
 */
router.put('/fees', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (!key) return res.status(400).json({ ok: false, error: 'key required' });

    // detect numeric
    const asNum = Number(value);
    const isNum = !Number.isNaN(asNum) && value !== '' && value !== null;

    // MySQL upsert: assumes fee_settings.key_name is PRIMARY KEY or UNIQUE
    const sql = `INSERT INTO fee_settings (key_name, value_decimal, value_text, updated_at)
                 VALUES (?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE value_decimal = VALUES(value_decimal), value_text = VALUES(value_text), updated_at = NOW()`;
    const params = [key, isNum ? asNum : null, isNum ? null : (value !== undefined && value !== null ? String(value) : null)];
    await db.query(sql, params);

    return res.json({ ok: true, saved: { key, value } });
  } catch (err) {
    console.error('PUT /admin/fees error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

module.exports = router;

