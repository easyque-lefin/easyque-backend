// routes/users.js — full file
// End-to-end Users router for EasyQue
//
// Endpoints implemented (matching your Postman collection):
//   GET    /users                 -> List Users in Org (requires ?org_id=)
//   POST   /users                 -> Create User (receptionist / assigned_user / admin / organization_admin)
//   PATCH  /users/me              -> Edit My Profile (name, phone, etc.)
//   POST   /users/me/photo        -> Upload My Profile Photo (multipart/form-data file: "photo")
//
// Safe defaults:
// - Validates required fields
// - Hashes password with bcrypt
// - Normalizes role labels used by Postman collection
// - Never exposes password hashes
//
// Assumes:
// - ../db exports a mysql2/promise pool wrapper: db.query(sql, params)
// - /uploads is served statically in index.js
// - MySQL in STRICT mode

const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');

const router = express.Router();

/* -------------------------- helpers & config -------------------------- */

function apiError(res, status, details, code = 'bad_request') {
  return res.status(status).json({ ok: false, error: code, details });
}

function sanitizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function sanitizeText(v) {
  return String(v || '').trim();
}

// Map incoming roles from Postman to DB-safe labels
const ROLE_MAP = {
  admin: 'admin',
  organization_admin: 'organization_admin',
  receptionist: 'receptionist',
  assigned_user: 'assigned_user',
};

// Multer storage for profile photos
const uploadDir = path.join(process.cwd(), 'uploads', 'profiles');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    // userId may be injected by auth middleware; if not, we fallback to timestamp
    const userId = (req.user && req.user.id) || 'anon';
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `user_${userId}_${Date.now()}${ext}`);
  },
});
const upload = multer({ storage });

/* ------------------------------ QUERIES ------------------------------- */

async function getUsersByOrg(orgId) {
  // Don’t return password hashes
  const [rows] = await db.query(
    `SELECT id, org_id, name, email, role, is_active, profile_photo_url, created_at, updated_at
     FROM users
     WHERE org_id = ?
     ORDER BY id DESC`,
    [orgId]
  );
  return rows;
}

async function insertUser({ org_id, name, email, role, password }) {
  const password_hash = await bcrypt.hash(password, 10);

  // Attempt to include optional columns gracefully
  // Some databases might not have profile_photo_url; we don't touch it here.
  const [result] = await db.query(
    `INSERT INTO users (org_id, name, email, role, password_hash, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, NOW(), NOW())`,
    [org_id, name, email, role, password_hash]
  );

  return result.insertId;
}

async function updateMyProfile(userId, patch) {
  const fields = [];
  const params = [];

  // allowlist of editable fields
  const editable = {
    name: 'name',
    phone: 'phone', // only if column exists in your schema
    // add other safe fields as needed
  };

  Object.keys(editable).forEach((key) => {
    if (patch[key] !== undefined) {
      fields.push(`${editable[key]} = ?`);
      params.push(sanitizeText(patch[key]));
    }
  });

  if (fields.length === 0) return 0;

  params.push(userId);

  const [result] = await db.query(
    `UPDATE users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`,
    params
  );
  return result.affectedRows || 0;
}

async function setMyPhoto(userId, relativeUrl) {
  // If profile_photo_url doesn’t exist in your schema, this will error;
  // we catch it in the route and just return the path without DB update.
  const [result] = await db.query(
    `UPDATE users SET profile_photo_url = ?, updated_at = NOW() WHERE id = ?`,
    [relativeUrl, userId]
  );
  return result.affectedRows || 0;
}

/* ------------------------------- ROUTES ------------------------------- */

/**
 * GET /users
 * List users in an organization
 * Query: org_id=number (required)
 */
router.get('/', async (req, res) => {
  try {
    const org_id = parseInt(req.query.org_id, 10);
    if (!org_id) {
      return apiError(res, 400, 'org_id is required');
    }
    const users = await getUsersByOrg(org_id);
    return res.json({ ok: true, count: users.length, users });
  } catch (err) {
    console.error('GET /users error:', err);
    return apiError(res, 500, err.sqlMessage || err.message, 'server_error');
  }
});

/**
 * POST /users
 * Create user (supports receptionist / assigned_user / admin / organization_admin)
 * Body: { org_id, name, email, role, password }
 */
router.post('/', async (req, res) => {
  try {
    const org_id = parseInt(req.body.org_id, 10);
    const name = sanitizeText(req.body.name);
    const email = sanitizeEmail(req.body.email);
    const roleIn = sanitizeText(req.body.role);
    const password = sanitizeText(req.body.password);

    if (!org_id || !name || !email || !roleIn || !password) {
      return apiError(res, 400, 'org_id, name, email, role, password are required');
    }

    const role = ROLE_MAP[roleIn] || roleIn;

    // Basic email sanity
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return apiError(res, 400, 'email is invalid');
    }

    // Optional: unique email check (if unique key exists this is redundant but helps with friendly error)
    try {
      const [existing] = await db.query(
        `SELECT id FROM users WHERE email = ? LIMIT 1`,
        [email]
      );
      if (existing.length) {
        return apiError(res, 409, 'email already exists', 'conflict');
      }
    } catch (_e) {
      // ignore if table/column differs; unique index will still protect if present
    }

    const newId = await insertUser({ org_id, name, email, role, password });
    return res.status(201).json({ ok: true, id: newId });
  } catch (err) {
    console.error('POST /users error:', err);
    return apiError(res, 500, err.sqlMessage || err.message, 'server_error');
  }
});

/**
 * PATCH /users/me
 * Update current user's profile
 * Body: any of { name, phone } (extend allowlist in updateMyProfile)
 *
 * Note: This route expects req.user.id to be set by your auth middleware.
 * If you don’t have middleware wired yet, you can pass ?user_id= in query for testing.
 */
router.patch('/me', async (req, res) => {
  try {
    const userId =
      (req.user && req.user.id) || parseInt(req.query.user_id, 10);

    if (!userId) {
      return apiError(res, 401, 'user not authenticated (missing user_id)', 'unauthorized');
    }

    const affected = await updateMyProfile(userId, req.body || {});
    return res.json({ ok: true, updated: affected });
  } catch (err) {
    console.error('PATCH /users/me error:', err);
    return apiError(res, 500, err.sqlMessage || err.message, 'server_error');
  }
});

/**
 * POST /users/me/photo
 * Upload profile photo
 * Form-Data: photo (file)
 *
 * Note: Expects req.user.id; for testing you may pass ?user_id=.
 */
router.post('/me/photo', upload.single('photo'), async (req, res) => {
  try {
    const userId =
      (req.user && req.user.id) || parseInt(req.query.user_id, 10);
    if (!userId) {
      // cleanup uploaded file if any
      if (req.file) fs.unlink(req.file.path, () => {});
      return apiError(res, 401, 'user not authenticated (missing user_id)', 'unauthorized');
    }

    if (!req.file) {
      return apiError(res, 400, 'photo file is required (multipart/form-data key: photo)');
    }

    // Public URL relative to /uploads (ensure index.js serves /uploads)
    const relativeUrl = `/uploads/profiles/${path.basename(req.file.path)}`;

    // Try to save; if column not present, just return the path
    try {
      await setMyPhoto(userId, relativeUrl);
    } catch (e) {
      console.warn('profile_photo_url update skipped:', e.sqlMessage || e.message);
    }

    return res.status(201).json({ ok: true, url: relativeUrl });
  } catch (err) {
    console.error('POST /users/me/photo error:', err);
    return apiError(res, 500, err.sqlMessage || err.message, 'server_error');
  }
});

module.exports = router;

