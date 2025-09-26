// routes/orgs.js
// Full routes for Organizations: banner upload/URL, break toggles, and fetch.
// Keeps existing behavior and adds compatible endpoints used by scripts.

const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { sendLive } = require('../services/liveBus');

/* =========================================================
   helpers / setup
   ========================================================= */

const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

/**
 * Build a safe banner filename for an org, preserving extension when available.
 * If ext is missing from original file name, default to .png
 */
function bannerFilename(orgId, originalName) {
  const ext = path.extname(originalName || '') || '.png';
  return `org_${orgId}_banner${ext}`;
}

/**
 * Multer storage:
 *   - Works for routes that have :id OR body.org_id
 *   - Always writes into /uploads
 */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    // Prefer param :id; fallback to body.org_id
    const idStr = (req.params && req.params.id) || (req.body && req.body.org_id);
    const orgId = parseInt(idStr, 10);
    if (!orgId || Number.isNaN(orgId)) {
      // write a temp file name so multer can proceed; we’ll 400 later if missing.
      const tmpName = `org_unknown_${Date.now()}${path.extname(file.originalname || '.png')}`;
      return cb(null, tmpName);
    }
    cb(null, bannerFilename(orgId, file.originalname));
  }
});
const upload = multer({ storage });

/** Persist the public path into DB and return the row-ish details */
async function saveBannerPath(orgId, absFilePath) {
  // Stored path that front-end can fetch; index.js serves /uploads statically
  const relPath = `/uploads/${path.basename(absFilePath)}`;
  await db.query('UPDATE organizations SET banner_url = ? WHERE id = ?', [relPath, orgId]);
  return relPath;
}

/** Fetch one organization (minimal fields we care about now) */
async function getOrg(orgId) {
  const [rows] = await db.query(
    `SELECT id, name, banner_url, breaking_user_id, break_started_at, break_until
       FROM organizations
      WHERE id = ? LIMIT 1`,
    [orgId]
  );
  return rows && rows[0] ? rows[0] : null;
}

/* =========================================================
   GET /orgs/:id  — fetch organization (used by scripts/UI)
   ========================================================= */
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad_id' });
    const org = await getOrg(id);
    if (!org) return res.status(404).json({ ok: false, error: 'not_found', path: `/orgs/${id}` });
    res.json(org);
  } catch (err) {
    next(err);
  }
});

/* =========================================================
   Banner: multipart upload variants
   ========================================================= */

/**
 * POST /orgs/:id/banner
 *   - multipart/form-data, field name: "banner"
 *   - (kept exactly as you had, but hardened)
 */
router.post('/:id/banner', upload.single('banner'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'missing_file' });

    // If multer created a temp "unknown" name because it couldn’t read :id, rename properly
    const desired = path.join(uploadDir, bannerFilename(id, req.file.originalname));
    if (path.basename(req.file.path) !== path.basename(desired)) {
      fs.renameSync(req.file.path, desired);
      req.file.path = desired;
    }

    const relPath = await saveBannerPath(id, req.file.path);
    res.json({ ok: true, banner_url: relPath });

    // notify live clients
    sendLive(id, null);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /orgs/banner
 *   - multipart/form-data
 *   - body field "org_id" and file field "banner"
 *   - Useful when you don’t want :id in URL
 */
router.post('/banner', upload.single('banner'), async (req, res, next) => {
  try {
    const id = parseInt(req.body.org_id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'missing_org_id' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'missing_file' });

    const desired = path.join(uploadDir, bannerFilename(id, req.file.originalname));
    if (path.basename(req.file.path) !== path.basename(desired)) {
      fs.renameSync(req.file.path, desired);
      req.file.path = desired;
    }

    const relPath = await saveBannerPath(id, req.file.path);
    res.json({ ok: true, banner_url: relPath });
    sendLive(id, null);
  } catch (err) {
    next(err);
  }
});

/* =========================================================
   Banner: set by URL (JSON)
   ========================================================= */

/**
 * POST /orgs/:id/banner-url
 *   Body: { banner_url: "https://..." }  OR  { banner_url: "/uploads/..." }
 */
router.post('/:id/banner-url', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const url = (req.body && req.body.banner_url || '').trim();
    if (!id || !url) return res.status(400).json({ ok: false, error: 'missing_params' });

    await db.query('UPDATE organizations SET banner_url = ? WHERE id = ?', [url, id]);
    res.json({ ok: true, banner_url: url });
    sendLive(id, null);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /orgs/banner-url
 *   Body: { org_id: 1, banner_url: "https://..." }
 */
router.post('/banner-url', async (req, res, next) => {
  try {
    const id = parseInt(req.body && req.body.org_id, 10);
    const url = (req.body && req.body.banner_url || '').trim();
    if (!id || !url) return res.status(400).json({ ok: false, error: 'missing_params' });

    await db.query('UPDATE organizations SET banner_url = ? WHERE id = ?', [url, id]);
    res.json({ ok: true, banner_url: url });
    sendLive(id, null);
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /orgs/:id
 *   Accepts { banner_url } for compatibility with scripts
 *   (Can be extended with other mutable org fields later.)
 */
router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'bad_id' });

    const bannerUrl = req.body && req.body.banner_url;
    if (!bannerUrl) return res.status(400).json({ ok: false, error: 'nothing_to_update' });

    await db.query('UPDATE organizations SET banner_url = ? WHERE id = ?', [bannerUrl, id]);
    const org = await getOrg(id);
    res.json({ ok: true, organization: org });
    sendLive(id, null);
  } catch (err) {
    next(err);
  }
});

/* =========================================================
   Break toggle APIs (kept as-is, with minor hardening)
   ========================================================= */

router.post('/:id/break/start', async (req, res, next) => {
  try {
    const org_id = parseInt(req.params.id, 10);
    const user_id = parseInt(req.body.user_id, 10);
    const until   = req.body.until ? new Date(req.body.until) : null;
    const reason  = (req.body.reason || '').trim();

    if (!org_id || !user_id) {
      return res.status(400).json({ ok: false, error: 'missing_params' });
    }

    const now = new Date();
    await db.query(
      `UPDATE organizations
          SET breaking_user_id = ?, break_started_at = ?, break_until = ?
        WHERE id = ?`,
      [user_id, now, until, org_id]
    );
    await db.query(
      `INSERT INTO org_breaks (org_id, user_id, started_at, reason)
       VALUES (?, ?, ?, ?)`,
      [org_id, user_id, now, reason || null]
    );

    res.json({ ok: true, started_at: now, break_until: until || null });
    sendLive(org_id, user_id);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/break/end', async (req, res, next) => {
  try {
    const org_id = parseInt(req.params.id, 10);
    const user_id = parseInt(req.body.user_id, 10);
    if (!org_id || !user_id) {
      return res.status(400).json({ ok: false, error: 'missing_params' });
    }

    const now = new Date();
    await db.query(
      `UPDATE organizations
          SET breaking_user_id = NULL, break_started_at = NULL, break_until = NULL
        WHERE id = ? AND breaking_user_id = ?`,
      [org_id, user_id]
    );
    await db.query(
      `UPDATE org_breaks
          SET ended_at = ?
        WHERE org_id = ? AND user_id = ? AND ended_at IS NULL`,
      [now, org_id, user_id]
    );

    res.json({ ok: true, ended_at: now });
    sendLive(org_id, user_id);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

