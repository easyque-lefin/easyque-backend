// routes/organizations.js — with Org Items support

const express = require('express');
const dayjs = require('dayjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const db = require('../services/db');
const { requireAuth } = require('../middleware/auth');
const { requireAnyRole } = require('../middleware/roles');

const router = express.Router();

/* ---------- uploads setup ---------- */
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `org_${Date.now()}${ext || '.bin'}`);
  }
});
const upload = multer({ storage });

async function getCols(table) {
  const [rows] = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [table]
  );
  return new Set(rows.map(r => String(r.column_name)));
}
function num(x, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }

/* ---------- Existing org routes (get org, patch org, uploads, links, limits) ----------
   KEEP everything you already had here. I am not touching those parts.
   Just append the Org Items block below.
--------------------------------------------------------------------------- */

/* ---------- ORG ITEMS (services) ---------- */

// Create one org item
router.post('/:org_id/items',
  requireAuth,
  requireAnyRole('admin', 'organization_admin'),
  async (req, res, next) => {
    try {
      const org_id = Number(req.params.org_id);
      const { name, description = '', is_active = true } = req.body || {};

      if (!org_id || !name) {
        return res.status(400).json({
          ok: false,
          error: 'missing_field',
          fields: { org_id: !!org_id, name: !!name }
        });
      }

      const [result] = await db.query(
        `INSERT INTO org_items (org_id, name, description, is_active)
         VALUES (?, ?, ?, ?)`,
        [org_id, String(name), String(description), is_active ? 1 : 0]
      );

      return res.status(201).json({
        ok: true,
        item: {
          id: result.insertId,
          org_id,
          name,
          description,
          is_active: !!is_active
        }
      });
    } catch (err) {
      next(err);
    }
  }
);

// List items
router.get('/:org_id/items',
  requireAuth,
  requireAnyRole('admin', 'organization_admin', 'receptionist', 'assigned_user'),
  async (req, res, next) => {
    try {
      const org_id = Number(req.params.org_id);
      const [rows] = await db.query(
        `SELECT id, org_id, name, description, is_active, created_at, updated_at
         FROM org_items
         WHERE org_id = ?
         ORDER BY created_at ASC`,
        [org_id]
      );
      res.json({ ok: true, rows });
    } catch (err) {
      next(err);
    }
  }
);

// Delete one item
router.delete('/:org_id/items/:item_id',
  requireAuth,
  requireAnyRole('admin', 'organization_admin'),
  async (req, res, next) => {
    try {
      const org_id = Number(req.params.org_id);
      const item_id = Number(req.params.item_id);

      const [r] = await db.query(
        `DELETE FROM org_items WHERE id=? AND org_id=?`,
        [item_id, org_id]
      );

      res.json({ ok: true, deleted: r.affectedRows });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
module.exports.default = router;

