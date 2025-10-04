// routes/organizations.js
const express = require('express');
const dayjs = require('dayjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const db = require('../services/db');
const { requireAuth } = require('../middleware/auth');
// NOTE: using your existing guard for now; we'll upgrade it in middleware next
const { requireAnyRole, ensureOrgAccessParam } = require('../middleware/roles');

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
  try {
    const [rows] = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ?`,
      [table]
    );
    return new Set(rows.map(r => String(r.column_name)));
  } catch {
    return new Set();
  }
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

/* ---------- slug helpers ---------- */
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
   CREATE / LIST / "MY ORG"
   ========================================================= */

/**
 * POST /organizations
 * Create a new organization (admin / organization_admin)
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
        ['slug', 'slug', v => String(v)]
      ];
      const { fields, allowed } = await pickAllowedFields(table, body, payloadMap);

      // required
      fields.name = String(body.name);

      // Stamp creator if column exists
      if (allowed.has('created_by') && req.user?.id) {
        fields.created_by = req.user.id;
      }

      // Optional timestamps
      if (allowed.has('created_at')) fields.created_at = dayjs().format('YYYY-MM-DD HH:mm:ss');
      if (allowed.has('updated_at')) fields.updated_at = dayjs().format('YYYY-MM-DD HH:mm:ss');

      // Generate/normalize slug if column exists
      if (allowed.has('slug')) {
        const base = fields.slug && String(fields.slug).trim().length > 0
          ? fields.slug
          : fields.name || body.name || 'org';
        fields.slug = await ensureUniqueSlug(base);
      }

      const [r] = await db.query(`INSERT INTO ${table} SET ?`, [fields]);

      // Link creator to org via user_orgs if table exists
      const userId = req.user && req.user.id;
      const uoCols = await getCols('user_orgs');
      if (userId && uoCols.size) {
        const rel = {};
        if (uoCols.has('user_id')) rel.user_id = userId;
        if (uoCols.has('org_id')) rel.org_id = r.insertId;
        if (uoCols.has('role')) rel.role = 'organization_admin';
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
 * Admin list
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
 * Prefer user_orgs → created_by → fallback global latest
 */
router.get(
  '/me',
  requireAuth,
  async (req, res, next) => {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

      // 1) user_orgs mapping (if exists)
      const uoCols = await getCols('user_orgs');
      if (uoCols.size && uoCols.has('user_id') && uoCols.has('org_id')) {
        const [rows] = await db.query(
          `SELECT o.id, o.name, o.slug, o.location, o.services, o.photo, o.banner_url, o.map_url,
                  o.created_at, o.updated_at
           FROM organizations o
           JOIN user_orgs uo ON uo.org_id = o.id
           WHERE uo.user_id = ?
           ORDER BY o.id DESC`,
          [userId]
        );
        return res.json({ ok: true, organizations: rows });
      }

      // 2) created_by (if the column exists)
      const orgCols = await getCols('organizations');
      if (orgCols.has('created_by')) {
        const [rows] = await db.query(
          `SELECT id, name, slug, location, services, photo, banner_url, map_url,
                  created_at, updated_at
           FROM organizations
           WHERE created_by = ?
           ORDER BY id DESC`,
          [userId]
        );
        return res.json({ ok: true, organizations: rows });
      }

      // 3) fallback: global latest (legacy)
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
   FETCH / UPDATE
   ========================================================= */

/**
 * GET /organizations/:id
 */
router.get(
  '/:id',
  requireAuth,
  ensureOrgAccessParam('id'),
  async (req, res, next) => {
    try {
      const org_id = num(req.params.id);
      const [rows] = await db.query(
        `SELECT id, name, slug, location, services, photo, banner_url, map_url,
                created_at, updated_at, created_by
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
  }
);

/**
 * PATCH /organizations/:id
 */
router.patch(
  '/:id',
  requireAuth,
  requireAnyRole('admin', 'organization_admin'),
  ensureOrgAccessParam('id'),
  async (req, res, next) => {
    try {
      const org_id = Number(req.params.id);
      const body = req.body || {};

      const allowed = await getCols('organizations');
      const fields = {};

      // Accept exact column keys
      for (const k of Object.keys(body)) {
        if (allowed.has(k)) fields[k] = body[k];
      }

      // Accept a few aliases the client may send
      if (body.service != null && allowed.has('services')) {
        fields.services = String(body.service);
      }
      if (body.google_map_url != null && allowed.has('map_url')) {
        fields.map_url = String(body.google_map_url);
      }
      if (body.mapUrl != null && allowed.has('map_url')) {
        fields.map_url = String(body.mapUrl);
      }

      // Drop nulls / empty strings
      for (const k of Object.keys(fields)) {
        const v = fields[k];
        if (v == null) delete fields[k];
        else if (typeof v === 'string' && v.trim().length === 0) delete fields[k];
      }

      if (!Object.keys(fields).length) {
        return res.json({ ok: true, updated: {}, note: 'no_valid_fields' });
      }

      if (allowed.has('updated_at')) {
        fields.updated_at = dayjs().format('YYYY-MM-DD HH:mm:ss');
      }

      await db.query(`UPDATE organizations SET ? WHERE id=?`, [fields, org_id]);
      res.json({ ok: true, updated: fields });
    } catch (err) {
      next(err);
    }
  }
);

/* =========================================================
   UPLOADS (photo / banner) + LINKS
   ========================================================= */

/**
 * POST /organizations/:id/banner
 * — merged with routes/orgs.js behavior:
 *   - uploads banner
 *   - also accepts { google_review_url } and updates it
 *   - if column org_banner_url exists, uses it; else banner_url
 */
router.post(
  '/:id/banner',
  requireAuth,
  requireAnyRole('admin', 'organization_admin'),
  ensureOrgAccessParam('id'),
  upload.single('banner'),
  async (req, res, next) => {
    try {
      const org_id = num(req.params.id);
      const { google_review_url } = req.body || {};

      const orgCols = await getCols('organizations');
      let url = null;

      if (req.file) {
        // multer already stored the file in /uploads with safe filename
        url = `/uploads/${req.file.filename}`;

        // Choose column name
        const bannerCol = orgCols.has('org_banner_url')
          ? 'org_banner_url'
          : (orgCols.has('banner_url') ? 'banner_url' : null);

        if (bannerCol) {
          await db.query(`UPDATE organizations SET ${bannerCol}=? WHERE id=?`, [url, org_id]);
        }
      }

      if (google_review_url && orgCols.has('google_review_url')) {
        await db.query(
          `UPDATE organizations SET google_review_url=? WHERE id=?`,
          [google_review_url, org_id]
        );
      }

      res.json({ ok: true, url });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /organizations/:id/photo
 */
router.post(
  '/:id/photo',
  requireAuth,
  requireAnyRole('admin', 'organization_admin'),
  ensureOrgAccessParam('id'),
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
 * (returns empty if org_links table doesn't exist)
 */
router.get(
  '/:id/links',
  requireAuth,
  ensureOrgAccessParam('id'),
  async (req, res, next) => {
    try {
      const org_id = num(req.params.id);
      const cols = await getCols('org_links');
      if (!cols.size) return res.json({ ok: true, links: [] });

      const [rows] = await db.query(
        `SELECT id, org_id, type, url FROM org_links WHERE org_id=?`,
        [org_id]
      );
      res.json({ ok: true, links: rows });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /organizations/:id/links
 */
router.post(
  '/:id/links',
  requireAuth,
  requireAnyRole('admin', 'organization_admin'),
  ensureOrgAccessParam('id'),
  async (req, res, next) => {
    try {
      const org_id = num(req.params.id);
      const { type, url } = req.body || {};
      const cols = await getCols('org_links');
      if (!cols.size) {
        return res.status(404).json({ ok: false, error: 'org_links_table_missing' });
      }
      if (!type || !url) {
        return res.status(400).json({ ok: false, error: 'missing_type_or_url' });
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

/* =========================================================
   LIMITS (GET existing) + merged LIMITS UPDATE from orgs.js
   ========================================================= */

/**
 * GET /organizations/:id/limits
 * (returns empty if org_limits table doesn't exist)
 */
router.get(
  '/:id/limits',
  requireAuth,
  ensureOrgAccessParam('id'),
  async (req, res, next) => {
    try {
      const org_id = num(req.params.id);
      const cols = await getCols('org_limits');
      if (!cols.size) return res.json({ ok: true, limits: [] });

      const [rows] = await db.query(
        `SELECT id, org_id, max_tokens, max_users FROM org_limits WHERE org_id=?`,
        [org_id]
      );
      res.json({ ok: true, limits: rows });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /organizations/:id/limits
 * (merged from routes/orgs.js)
 * Updates plan_mode, users_count, expected_bookings_per_day, monthly_expected_bookings
 * Only updates columns that exist
 */
router.post(
  '/:id/limits',
  requireAuth,
  requireAnyRole('admin', 'organization_admin'),
  ensureOrgAccessParam('id'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { plan_mode, users_count, expected_bookings_per_day } = req.body || {};
      const monthly = expected_bookings_per_day ? Number(expected_bookings_per_day) * 30 : null;

      const cols = await getCols('organizations');
      // Build a dynamic update only for columns that exist
      const sets = [];
      const params = [];
      if (cols.has('plan_mode')) { sets.push('plan_mode = COALESCE(?, plan_mode)'); params.push(plan_mode || null); }
      if (cols.has('users_count')) { sets.push('users_count = COALESCE(?, users_count)'); params.push(users_count || null); }
      if (cols.has('expected_bookings_per_day')) {
        sets.push('expected_bookings_per_day = COALESCE(?, expected_bookings_per_day)');
        params.push(expected_bookings_per_day || null);
      }
      if (cols.has('monthly_expected_bookings')) {
        sets.push('monthly_expected_bookings = COALESCE(?, monthly_expected_bookings)');
        params.push(monthly);
      }

      if (!sets.length) {
        return res.json({ ok: true, note: 'no_limit_columns_present' });
      }

      const sql = `UPDATE organizations SET ${sets.join(', ')} WHERE id = ?`;
      params.push(id);
      await db.query(sql, params);
      res.json({ ok: true });
    } catch (e) { next(e); }
  }
);

/* =========================================================
   BREAK CONTROLS (per assignee) — merged from routes/orgs.js
   ========================================================= */

router.post(
  '/:id/break/start',
  requireAuth,
  requireAnyRole('admin','organization_admin','receptionist','assigned_user'),
  ensureOrgAccessParam('id'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { user_id, minutes = 15 } = req.body || {};
      if (!user_id) return res.status(400).json({ ok: false, error: 'user_id required' });

      // booking_date = today (YYYY-MM-DD)
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth()+1).padStart(2,'0');
      const dd = String(today.getDate()).padStart(2,'0');
      const booking_date = `${yyyy}-${mm}-${dd}`;
      const until = new Date(Date.now() + Number(minutes) * 60000);

      await db.query(
        `INSERT INTO assigned_live_metrics
         (org_id, assigned_user_id, booking_date, break_started_at, break_until, updated_at)
         VALUES (?,?,?,?,?, NOW())
         ON DUPLICATE KEY UPDATE break_started_at=VALUES(break_started_at),
                                 break_until=VALUES(break_until),
                                 updated_at=NOW()`,
        [id, user_id, booking_date, new Date(), until]
      );
      res.json({ ok: true, break_until: until });
    } catch (e) { next(e); }
  }
);

router.post(
  '/:id/break/end',
  requireAuth,
  requireAnyRole('admin','organization_admin','receptionist','assigned_user'),
  ensureOrgAccessParam('id'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { user_id } = req.body || {};
      if (!user_id) return res.status(400).json({ ok: false, error: 'user_id required' });

      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth()+1).padStart(2,'0');
      const dd = String(today.getDate()).padStart(2,'0');
      const booking_date = `${yyyy}-${mm}-${dd}`;

      await db.query(
        `UPDATE assigned_live_metrics
         SET break_until = NULL, break_started_at = NULL, updated_at = NOW()
         WHERE org_id = ? AND assigned_user_id = ? AND booking_date = ?`,
        [id, user_id, booking_date]
      );
      res.json({ ok: true });
    } catch (e) { next(e); }
  }
);

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
  ensureOrgAccessParam('org_id'),
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
  requireAnyRole('admin','organization_admin','receptionist','assigned_user'),
  ensureOrgAccessParam('org_id'),
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
  ensureOrgAccessParam('org_id'),
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

/* -------------------- ORG USERS -------------------- */

// List users in an org
router.get(
  '/:org_id/users',
  requireAuth,
  requireAnyRole('admin','organization_admin','receptionist','assigned_user'),
  ensureOrgAccessParam('org_id'),
  async (req, res, next) => {
    try {
      const org_id = Number(req.params.org_id) || 0;
      const [rows] = await db.query(
        `SELECT id, org_id, name, email, dept, role, avg_service_seconds,
                created_at, updated_at
         FROM org_users WHERE org_id = ?
         ORDER BY created_at ASC`,
        [org_id]
      );
      res.json({ ok: true, users: rows });
    } catch (err) { next(err); }
  }
);

// Add one user to an org
router.post(
  '/:org_id/users',
  requireAuth,
  requireAnyRole('admin','organization_admin'),
  ensureOrgAccessParam('org_id'),
  async (req, res, next) => {
    try {
      const org_id = Number(req.params.org_id) || 0;
      const { name, email = '', dept = '', role } = req.body || {};
      if (!org_id || !name || !role) {
        return res.status(400).json({
          ok:false,
          error:'missing_field',
          fields:{ org_id: !!org_id, name: !!name, role: !!role }
        });
      }
      const [r] = await db.query(
        `INSERT INTO org_users (org_id, name, email, dept, role)
         VALUES (?,?,?,?,?)`,
        [org_id, String(name), String(email), String(dept), String(role)]
      );
      res.status(201).json({ ok:true, user:{ id:r.insertId, org_id, name, email, dept, role } });
    } catch (err) { next(err); }
  }
);

// Delete one user
router.delete(
  '/:org_id/users/:user_id',
  requireAuth,
  requireAnyRole('admin','organization_admin'),
  ensureOrgAccessParam('org_id'),
  async (req, res, next) => {
    try {
      const org_id  = Number(req.params.org_id)  || 0;
      const user_id = Number(req.params.user_id) || 0;
      const [r] = await db.query(`DELETE FROM org_users WHERE id=? AND org_id=?`, [user_id, org_id]);
      res.json({ ok:true, deleted: r.affectedRows });
    } catch (err) { next(err); }
  }
);

module.exports = router;
module.exports.default = router;

