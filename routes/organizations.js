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
  filename:   (_, file, cb) => {
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

/* ---------- Existing routes kept (get org, patch org, uploads, links, limits) ---------- */
// ... [KEEP ALL YOUR EXISTING CODE HERE from current file] ...

/* ---------- NEW: Org Items ---------- */

// Add one or many items
router.post('/:id/items', requireAuth, requireAnyRole('admin','organization_admin'), async (req,res,next)=>{
  try {
    const org_id = num(req.params.id);
    let items = req.body.items || req.body.item_name;
    if (!items) return res.status(400).json({ ok:false, error:'item_required' });
    if (!Array.isArray(items)) items = [items];

    const values = items.map(it => [org_id, String(it)]);
    await db.query(`INSERT INTO org_items (org_id, item_name) VALUES ?`, [values]);

    res.json({ ok:true, added: items.length });
  }catch(e){ next(e); }
});

// List items
router.get('/:id/items', requireAuth, requireAnyRole('admin','organization_admin','receptionist','assigned_user'), async (req,res,next)=>{
  try {
    const org_id = num(req.params.id);
    const [rows] = await db.query(`SELECT * FROM org_items WHERE org_id=? ORDER BY created_at ASC`, [org_id]);
    res.json({ ok:true, rows });
  }catch(e){ next(e); }
});

// Delete item
router.delete('/:id/items/:item_id', requireAuth, requireAnyRole('admin','organization_admin'), async (req,res,next)=>{
  try {
    const org_id = num(req.params.id);
    const item_id = num(req.params.item_id);
    const [r] = await db.query(`DELETE FROM org_items WHERE id=? AND org_id=?`, [item_id, org_id]);
    res.json({ ok:true, deleted: r.affectedRows });
  }catch(e){ next(e); }
});


/* ------------------------------------------------------------------
 * ORG ITEMS (services) — mounted at /organizations/:org_id/items
 * Keep everything you already have above; just append this block.
 * -----------------------------------------------------------------*/

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

      // Insert
      const [result] = await db.query(
        'INSERT INTO org_items (org_id, name, description, is_active) VALUES (?, ?, ?, ?)',
        [org_id, String(name), String(description), is_active ? 1 : 0]
      );

      const id = result.insertId;

      // Return the created record
      return res.status(201).json({
        ok: true,
        item: { id, org_id, name, description, is_active: !!is_active }
      });
    } catch (err) {
      next(err);
    }
  }
);

// List all items for an org
router.get('/:org_id/items',
  requireAuth,
  requireAnyRole('admin', 'organization_admin', 'receptionist', 'assigned_user'),
  async (req, res, next) => {
    try {
      const org_id = Number(req.params.org_id);
      const [rows] = await db.query(
        'SELECT id, org_id, name, description, is_active, created_at, updated_at FROM org_items WHERE org_id = ? ORDER BY created_at ASC',
        [org_id]
      );
      res.json({ ok: true, rows });
    } catch (err) {
      next(err);
    }
  }
);

// Delete a specific item
router.delete('/:org_id/items/:item_id',
  requireAuth,
  requireAnyRole('admin', 'organization_admin'),
  async (req, res, next) => {
    try {
      const org_id = Number(req.params.org_id);
      const item_id = Number(req.params.item_id);

      const [r] = await db.query(
        'DELETE FROM org_items WHERE id = ? AND org_id = ?',
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

