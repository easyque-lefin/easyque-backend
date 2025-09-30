// routes/organizations.js
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

/* ---------- utils ---------- */
async function getCols(table) {
  const [rows] = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [table]
  );
  return new Set(rows.map(r => String(r.column_name)));
}
const num = (x, d = 0) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
};
const toBool = (v, d = false) =>
  typeof v === 'boolean'
    ? v
    : v == null
    ? d
    : String(v) === '1' || /^true$/i.test(String(v));

/* =========================================================
   ORGANIZATION ROUTES
   ========================================================= */

/**
 * GET /organizations/:id
 * Fetch a single organization
 */
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const org_id = num(req.params.id);
    const [rows] = await db.query(
      `SELECT id, name, slug, location, services, photo, banner_url, map_url,
              created_at, updated_at
       FROM organizations
       WHERE id = ?`,
      [org_id]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'not_found' });
    }

    res.json({ ok: true, org: rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /organizations/:id
 * Update organization fields
 */
router.patch(
  '/:id',
  requireAuth,
  requireAnyRole('admin', 'organization_admin'),
  async (req, res, next) => {
    try {
      const org_id = num(req.params.id);
      const body = req.body || {};

      const allowed = await getCols('organizations');
      const fields = {};
      for (const k of Object.keys(body)) {
        if (allowed.has(k)) fields[k] = body[k];
      }

      if (!Object.keys(fields).length) {
        return res.status(400).json({ ok: false, error: 'no_valid_fields' });
      }

      await db.query(`UPDATE organizations SET ? WHERE id=?`, [fields, org_id]);
      res.json({ ok: true, updated: fields });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /organizations/:id/banner
 * Upload banner image
 */
router.post(
  '/:id/banner',
  requireAuth,
  requireAnyRole('admin', 'organization_admin'),
  upload.single('banner'),
  async (req, res, next) => {
    try {
      const org_id = num(req.params.id);
      if (!req.file) {
        return res.status(400).json({ ok: false, error: 'no_file' });
      }
      const banner_url = `/uploads/${req.file.filename}`;
      await db.query(`UPDATE organizations SET banner_url=? WHERE id=?`, [
        banner_url,
        org_id
      ]);
      res.json({ ok: true, banner_url });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /organizations/:id/photo
 * Upload profile photo
 */
router.post(
  '/:id/photo',
  requireAuth,
  requireAnyRole('admin', 'organization_admin'),
  upload.single('photo'),
  async (req, res, next) => {
    try {
      const org_id = num(req.params.id);
      if (!req.file) {
        return res.status(400).json({ ok: false, error: 'no_file' });
      }
      const photo = `/uploads/${req.file.filename}`;
      await db.query(`UPDATE organizations SET photo=? WHERE id=?`, [
        photo,
        org_id
      ]);
      res.json({ ok: true, photo });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /organizations/:id/links
 * Fetch organization links
 */
router.get('/:id/links', requireAuth, async (req, res, next) => {
  try {
    const org_id = num(req.params.id);
    const [rows] = await db.query(
      `SELECT id, org_id, type, url FROM org_links WHERE org_id=?`,
      [org_id]
    );
    res.json({ ok: true, links: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /organizations/:id/links
 * Add an organization link
 */
router.post(
  '/:id/links',
  requireAuth,
  requireAnyRole('admin', 'organization_admin'),
  async (req, res, next) => {
    try {
      const org_id = num(req.params.id);
      const { type, url } = req.body || {};
      if (!type || !url) {
        return res
          .status(400)
          .json({ ok: false, error: 'missing_type_or_url' });
      }

      const [r] = await db.query(
        `INSERT INTO org_links (org_id, type, url) VALUES (?, ?, ?)`,
        [org_id, type, url]
      );
      res.status(201).json({ ok: true, id: r.insertId, type, url });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /organizations/:id/limits
 * Fetch limits
 */
router.get('/:id/limits', requireAuth, async (req, res, next) => {
  try {
    const org_id = num(req.params.id);
    const [rows] = await db.query(
      `SELECT id, org_id, max_tokens, max_users FROM org_limits WHERE org_id=?`,
      [org_id]
    );
    res.json({ ok: true, limits: rows });
  } catch (err) {
    next(err);
  }
});

/* =========================================================
   ORG ITEMS ROUTES
   ========================================================= */

/**
 * POST /organizations/:org_id/items
 */
router.post(
  '/:org_id/items',
  requireAuth,
  requireAnyRole('admin', 'organization_admin'),
  async (req, res, next) => {
    try {
      const org_id = num(req.params.org_id);
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
        [org_id, String(name), String(description), toBool(is_active) ? 1 : 0]
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

/**
 * GET /organizations/:org_id/items
 */
router.get(
  '/:org_id/items',
  requireAuth,
  requireAnyRole(
    'admin',
    'organization_admin',
    'receptionist',
    'assigned_user'
  ),
  async (req, res, next) => {
    try {
      const org_id = num(req.params.org_id);
      const [rows] = await db.query(
        `SELECT id, org_id, name, description, is_active, created_at, updated_at
         FROM org_items
         WHERE org_id = ?
         ORDER BY created_at ASC`,
        [org_id]
      );
      res.json({ ok: true, items: rows });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /organizations/:org_id/items/:item_id
 */
router.delete(
  '/:org_id/items/:item_id',
  requireAuth,
  requireAnyRole('admin', 'organization_admin'),
  async (req, res, next) => {
    try {
      const org_id = num(req.params.org_id);
      const item_id = num(req.params.item_id);

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


