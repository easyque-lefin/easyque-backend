// routes/organizations.js
const express = require('express');
const db = require('../db');
const router = express.Router();

/**
 * GET /organizations
 * Query params:
 *  - q : search string (matches id or name)
 *  - limit, offset optional (not required)
 *
 * Returns JSON array of organizations: { id, name, slug }
 */
router.get('/', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    let sql, params;
    if (q) {
      // if q looks like a number, search id exact and name partial
      const maybeId = Number(q);
      if (!Number.isNaN(maybeId) && String(maybeId) === q) {
        sql = 'SELECT id, name, slug FROM organizations WHERE id = ? LIMIT 50';
        params = [maybeId];
      } else {
        sql = 'SELECT id, name, slug FROM organizations WHERE name LIKE ? LIMIT 50';
        params = [`%${q}%`];
      }
    } else {
      sql = 'SELECT id, name, slug FROM organizations ORDER BY id DESC LIMIT 200';
      params = [];
    }
    const rows = await db.query(sql, params);
    return res.json({ ok: true, organizations: Array.isArray(rows) ? rows : [] });
  } catch (err) {
    console.error('GET /organizations error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'server error', details: err && err.message });
  }
});

/**
 * GET /organizations/:id
 * Returns one organization and optionally its departments and users
 */
router.get('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ ok: false, error: 'invalid id' });

    const rows = await db.query('SELECT id, name, slug, created_at FROM organizations WHERE id = ? LIMIT 1', [id]);
    const org = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (!org) return res.status(404).json({ ok: false, error: 'organization not found' });

    // optionally load departments and users
    const deps = await db.query('SELECT id, name FROM departments WHERE org_id = ? ORDER BY id', [id]);
    const users = await db.query('SELECT id, name, email, role FROM users WHERE org_id = ? ORDER BY id', [id]);

    return res.json({ ok: true, org, departments: Array.isArray(deps) ? deps : [], users: Array.isArray(users) ? users : [] });
  } catch (err) {
    console.error('GET /organizations/:id error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'server error', details: err && err.message });
  }
});

module.exports = router;
