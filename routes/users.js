const express = require('express');
const router = express.Router();
const db = require('../db');

// list users in org
router.get('/', async (req, res, next) => {
  try {
    const org_id = parseInt(req.query.org_id, 10);
    if (!org_id) return res.status(400).json({ ok: false, error: 'missing_org_id' });
    const rows = await db.query(
      `SELECT id, org_id, name, role, is_active FROM users WHERE org_id = ? ORDER BY name`,
      [org_id]
    );
    res.json({ ok: true, items: rows });
  } catch (err) { next(err); }
});

// create user (doctor/admin/receptionist)
router.post('/', async (req, res, next) => {
  try {
    const org_id = parseInt(req.body.org_id, 10);
    const name = (req.body.name || '').trim();
    const role = (req.body.role || 'doctor').trim(); // doctor|admin|receptionist
    if (!org_id || !name) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const result = await db.query(
      `INSERT INTO users (org_id, name, role, is_active, created_at) VALUES (?, ?, ?, 1, NOW())`,
      [org_id, name, role]
    );
    res.json({ ok: true, id: result.insertId });
  } catch (err) { next(err); }
});

module.exports = router;
