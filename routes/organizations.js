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

/**
 * Safely builds an object of fields => values that match existing columns.
 * `payloadMap` is an array of [payloadKey, columnName, transformFn?]
 */
async function pickAllowedFields(table, body, payloadMap) {
  const allowed = await getCols(table);
  const fields = {};
  for (const [payloadKey, colName, transform] of payloadMap) {
    if (body[payloadKey] == null) continue;
    if (!allowed.has(colName)) continue;
    fields[colName] = transform ? transform(body[payloadKey]) : body[payloadKey];
  }
  return { fields, allowed };
}

/* ---------- NEW: slug helpers (auto-generate & ensure unique) ---------- */
function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .substring(0, 100);
}

async function ensureUniqueSlug(base, excludeOrgId = null) {
  const baseClean = slugify(base) || 'org';
  let candidate = baseClean;
  let i = 1;

  while (true) {
    let sql = 'SELECT id FROM organizations WHERE slug = ?';
    const params = [candidate];
    if (excludeOrgId) {
      sql += ' AND id <> ?';
      params.push(excludeOrgId);
    }
    const [rows] = await db.query(sql, params);
    if (!rows.length) return candidate;
    i += 1;
    candidate = `${baseClean}-${i}`;
    if (candidate.length > 100) candidate = candidate.slice(0, 100);
  }
}

/* =========================================================
   NEW: CREATE / LIST / "MY ORG"
   ========================================================= */

/**
 * POST /organizations
 * Create a new organization (admin / organization_admin)
 * Body accepts commonly used keys; only columns that exist are inserted.
 *
 * Typical accepted payload:
 * {
 *   "name": "My Org",
 *   "address": "123 Street",  -> maps to 'location' if that column exists
 *   "location": "123 Street", -> direct pass if column exists
 *   "services": "OP, Lab",
 *   "service": "OP",          -> maps to 'services' if that column exists
 *   "lat": 12.34,
 *   "lng": 56.78,
 *   "map_url": "https://maps.google.com/?..."
 * }
 */
router.post(
  '/',
  requireAuth,
  requireAnyRole('admin', 'organization_admin'),
  async (req, res, next) => {
    try {
      const body = req.body || {};
      if (!body.name || String(body.name).trim().length === 0) {
        return res.status(400).json({ ok: false, error: 'name_required' });
      }

      // Build a resilient insert object based on existing columns
      const table = 'organizations';
      const payloadMap = [
        ['name', 'name', v => String(v)],
        ['location', 'location', v => String(v)],
        ['address', 'location', v => String(v)],
        ['services', 'services', v => String(v)],
        ['service', 'services', v => String(v)],
        ['lat', 'lat', v => (v == null ? null : Number(v))],
        ['lng', 'lng', v => (v == null ? null : Number(v))],
        ['map_url', 'map_url', v => String(v)],
        // optional incoming slug, but we'll override with unique below if column exists
        ['slug', 'slug', v => String(v)]
      ];
      const { fields, allowed } = await pickAllowedFields(table, body, payloadMap);

      // Minimal required field (always set)
      fields.name = String(body.name);

      // Optional timestamps if present
      if (allowed.has('created_at')) fields.created_at = dayjs().format('YYYY-MM-DD HH:mm:ss');
      if (allowed.has('updated_at')) fields.updated_at = dayjs().format('YYYY-MM-DD HH:mm:ss');

      // Always generate slug if the column exists
      if (allowed.has('slug')) {
        const base = fields.slug && String(fields.slug).trim().length > 0
          ? fields.slug
          : fields.name || body.name || 'org';
        fields.slug = await ensureUniqueSlug(base);
      }

      // Insert
      const [r] = await db.query(`INSERT INTO ${table} SET ?`, [fields]);

      // Optionally map org to the creator
      const userId = req.user && req.user.id;
      if (userId && (await getCols('user_orgs')).size) {
        const cols = await getCols('user_orgs');
        const rel = {};
        if (cols.has('user_id')) rel.user_id = userId;
        if (cols.has('org_id')) rel.org_id = r.insertId;
        if (cols.has('role')) rel.role = 'organization_admin';
        if (Object.keys(rel).length >= 2) {
          await db.query(`INSERT INTO user_orgs SET ?`, [rel]);
        }
      }

      return res.status(201).json({ ok: true, id: r.insertId });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /organizations
 * List organizations (admin only).
 */
router.get(
  '/',
  requireAuth,
  requireAnyRole('admin'),
  async (_req, res, next) => {
    try {
      const [rows] = await db.query(
        `SELECT id, name, slug, location, services, photo, banner_url, map_url,
                created_at, updated_at
         FROM organizations
         ORDER BY created_at DESC`
      );
      res.json({ ok: true, organizations: rows });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /organizations/me
 * Fetch the organization(s) for the current user.
 */
router.get(
  '/me',
  requireAuth,
  async (req, res, next) => {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

      // First try user_orgs join if table exists
      const uoCols = await getCols('user_orgs');
      if (uoCols.size && uoCols.has('user_id') && uoCols.has('org_id')) {
        const [rows] = await db.query(
          `SELECT o.id, o.name, o.slug, o.location, o.services, o.photo, o.banner_url, o.map_url,
                  o.created_at, o.updated_at
           FROM organizations o
           JOIN user_orgs uo ON uo.org_id = o.id
           WHERE uo.user_id = ?`,
          [userId]
        );
        return res.json({ ok: true, organizations: rows });
      }

      // Fallback to single latest org
      const [rows] = await db.query(
        `SELECT id, name, slug, location, services, photo, banner_url, map_url,
                created_at, updated_at
         FROM organizations
         ORDER BY id DESC
         LIMIT 1`
      );
      return res.json({ ok: true, organizations: rows });
    } catch (err) {
      next(err);
    }
  }
);

/* =========================================================
   EXISTING: FETCH / UPDATE / UPLOADS / LINKS / LIMITS
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

      // Use the same safe mapper as POST
      const payloadMap = [
        ['name', 'name', v => String(v)],
        ['location', 'location', v => String(v)],
        ['services', 'services', v => String(v)],
        ['map_url', 'map_url', v => String(v)],
        ['slug', 'slug', v => String(v)]
      ];
      const { fields, allowed } = await pickAllowedFields('organizations', body, payloadMap);

      // Handle slug if column exists and slug provided
      if (allowed.has('slug') && Object.prototype.hasOwnProperty.call(fields, 'slug')) {
        const base = fields.slug && String(fields.slug).trim().length > 0
          ? fields.slug
          : (fields.name || body.name || '');
        fields.slug = await ensureUniqueSlug(base, org_id);
      }

      // Updated timestamp
      if (allowed.has('updated_at')) {
        fields.updated_at = dayjs().format('YYYY-MM-DD HH:mm:ss');
      }

      // If nothing valid to update, don't error; just acknowledge
      if (!Object.keys(fields).length) {
        return res.json({ ok: true, updated: {} });
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
 * Upload banner image (form-data: key = banner)
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
 * Upload profile photo (form-data: key = photo)
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
   ORG ITEMS ROUTES (existing)
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



