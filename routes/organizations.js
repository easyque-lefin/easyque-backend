// routes/organizations.js
const express = require('express');
const db = require('../db');
const router = express.Router();

/**
 * GET /organizations?q=...
 */
router.get('/', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    let rows;
    if (q) {
      const maybeId = Number(q);
      if (!Number.isNaN(maybeId) && String(maybeId) === q) {
        rows = await db.query('SELECT id, name, slug FROM organizations WHERE id = ? LIMIT 50', [maybeId]);
      } else {
        rows = await db.query('SELECT id, name, slug FROM organizations WHERE name LIKE ? LIMIT 200', [`%${q}%`]);
      }
    } else {
      rows = await db.query('SELECT id, name, slug FROM organizations ORDER BY id DESC LIMIT 200');
    }
    return res.json({ ok: true, organizations: Array.isArray(rows) ? rows : [] });
  } catch (err) {
    console.error('GET /organizations error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

/**
 * GET /organizations/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ ok: false, error: 'invalid id' });
    const rows = await db.query('SELECT id, name, slug, created_at FROM organizations WHERE id = ? LIMIT 1', [id]);
    const org = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (!org) return res.status(404).json({ ok: false, error: 'organization not found' });

    const deps = await db.query('SELECT id, name FROM departments WHERE org_id = ? ORDER BY id', [id]);
    const users = await db.query('SELECT id, name, email, role FROM users WHERE org_id = ? ORDER BY id', [id]);

    return res.json({ ok: true, org, departments: Array.isArray(deps) ? deps : [], users: Array.isArray(users) ? users : [] });
  } catch (err) {
    console.error('GET /organizations/:id error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

/**
 * POST /organizations  (create)
 * body: { name, slug }
 */
router.post('/', async (req, res) => {
  try {
    const { name, slug } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });

    const insert = await db.query('INSERT INTO organizations (name, slug, created_at, updated_at) VALUES (?, ?, NOW(), NOW())', [name, slug || null]);
    const id = insert && (insert.insertId || (Array.isArray(insert) && insert[0] && insert[0].insertId)) ? (insert.insertId || insert[0].insertId) : null;
    const rows = await db.query('SELECT id, name, slug FROM organizations WHERE id = ? LIMIT 1', [id]);
    return res.status(201).json({ ok: true, org: Array.isArray(rows) ? rows[0] : null });
  } catch (err) {
    console.error('POST /organizations error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

// routes/organizations.js  (example)
router.post('/:orgId/limits', async (req, res) => {
  const orgId = req.params.orgId;
  const {
    plan_mode,          // 'trial' | 'paid'
    trial_days,         // 7
    messaging_option,   // 'option1' | 'option2'
    users_limit,        // integer
    expected_bookings_per_day // integer
  } = req.body;

  // TODO: persist into organizations table or a new org_limits table
  // Example SQL (pseudo; adjust to your schema):
  // await db.query(`
  //   UPDATE organizations
  //   SET plan_mode=?, users_limit=?, expected_bookings_per_day=?, trial_ends_at = (CASE WHEN ?='trial' THEN DATE_ADD(NOW(), INTERVAL ? DAY) ELSE NULL END),
  //       messaging_option=?
  //   WHERE id=?`,
  //   [plan_mode, users_limit, expected_bookings_per_day, plan_mode, trial_days || 0, messaging_option, orgId]
  // );

  return res.json({ ok: true, org_id: Number(orgId) });
});


module.exports = router;
