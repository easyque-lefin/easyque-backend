// routes/admin.js
// Admin-only routes for fee settings (MySQL friendly)
// - GET /admin/fees
// - PUT /admin/fees

const express = require('express');
const db = require('../db');

let requireAuth, requireRole;
try {
  const authMw = require('../middleware/auth');
  requireAuth = authMw.requireAuth;
  requireRole = authMw.requireRole;
} catch (e) {
  // fallback middleware if your middleware isn't available
  const jwt = require('jsonwebtoken');
  requireAuth = (req, res, next) => {
    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ ok: false, error: 'missing token' });
    const token = m[1];
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
      req.user = decoded;
      return next();
    } catch (err) {
      return res.status(401).json({ ok: false, error: 'invalid token' });
    }
  };
  requireRole = role => (req, res, next) => {
    if (!req.user || (req.user.role || '') !== role) return res.status(403).json({ ok: false, error: 'forbidden' });
    return next();
  };
}

const router = express.Router();

router.get('/fees', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const rows = await db.query('SELECT key_name, value_decimal, value_text FROM fee_settings');
    const map = {};
    if (Array.isArray(rows)) {
      rows.forEach(r => {
        map[r.key_name] = {
          value_decimal: r.value_decimal !== null ? parseFloat(r.value_decimal) : null,
          value_text: r.value_text || null
        };
      });
    }
    return res.json({ ok: true, fees: map });
  } catch (err) {
    console.error('GET /admin/fees error', err && err.message);
    return res.status(500).json({ ok: false, error: 'server error', details: err && err.message });
  }
});

router.put('/fees', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (!key) return res.status(400).json({ ok: false, error: 'key is required' });
    const numericValue = Number(value);
    const isNumeric = !isNaN(numericValue) && value !== null && value !== '';
    if (isNumeric) {
      const sql = `INSERT INTO fee_settings (key_name, value_decimal, value_text, updated_at)
                   VALUES (?, ?, NULL, NOW())
                   ON DUPLICATE KEY UPDATE value_decimal = VALUES(value_decimal), value_text = NULL, updated_at = NOW()`;
      await db.query(sql, [key, numericValue]);
    } else {
      const sql = `INSERT INTO fee_settings (key_name, value_decimal, value_text, updated_at)
                   VALUES (?, NULL, ?, NOW())
                   ON DUPLICATE KEY UPDATE value_text = VALUES(value_text), value_decimal = NULL, updated_at = NOW()`;
      await db.query(sql, [key, String(value || '')]);
    }
    return res.json({ ok: true, msg: 'fee saved' });
  } catch (err) {
    console.error('PUT /admin/fees error', err && err.message);
    return res.status(500).json({ ok: false, error: 'server error', details: err && err.message });
  }
});

module.exports = router;

