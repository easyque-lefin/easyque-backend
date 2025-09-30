// routes/users.js — FULL FILE (driver-agnostic DB calls)
// EasyQue Users API
//
// Endpoints (matching your Postman collection):
//   GET    /users                 -> List users in org (?org_id=)
//   POST   /users                 -> Create user (receptionist | assigned_user | admin | organization_admin)
//   PATCH  /users/me              -> Edit my profile (name, phone)
//   POST   /users/me/photo        -> Upload my profile photo (multipart/form-data, key: "photo")
//
// Notes:
// - Works whether ../db.query returns [rows, fields] (mysql2) OR just rows (custom helper).
// - Hashes passwords with bcryptjs (install: npm i bcryptjs).
// - Expects users table: id, org_id, name, email, role, password_hash, is_active, profile_photo_url, created_at, updated_at
// - If role ENUM causes errors, change DB column to VARCHAR(32).
// - Make sure index.js has: app.use(express.json()); and app.use('/users', require('./routes/users'));
//
// Dependencies used here: express, bcryptjs, multer, path, fs.

const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../db');

const router = express.Router();

/* --------------------------- small DB helpers --------------------------- */
/** Normalize whatever ../db.query returns into { rows, fields? } */
async function dbQuery(sql, params) {
  const res = await db.query(sql, params);
  // mysql2/promise => [rows, fields]; custom wrapper => rows
  if (Array.isArray(res)) {
    if (Array.isArray(res[0]) || typeof res[0] === 'object') {
      return { rows: res[0], fields: res[1] };
    }
  }
  // if it's a rows array already
  return { rows: res, fields: undefined };
}

/** Execute INSERT/UPDATE/DELETE and return the raw result safely */
async function dbExec(sql, params) {
  const res = await db.query(sql, params);
  // mysql2 returns [result]; custom may return result directly
  if (Array.isArray(res)) return res[0] ?? res;
  return res;
}

/* ------------------------------ utilities ------------------------------ */

function apiError(res, status, details, code = 'bad_request') {
  return res.status(status).json({ ok: false, error: code, details });
}
const sanitizeEmail = v => String(v || '').trim().toLowerCase();
const sanitizeText  = v => String(v || '').trim();

const ROLE_MAP = {
  admin: 'admin',
  organization_admin: 'organization_admin',
  receptionist: 'receptionist',
  assigned_user: 'assigned_user',
};

/* --------------------------- uploads (multer) --------------------------- */

const uploadDir = path.join(process.cwd(), 'uploads', 'profiles');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const userId = (req.user && req.user.id) || 'anon';
    const ext = path.extname(file.originalname || '.jpg') || '.jpg';
    cb(null, `user_${userId}_${Date.now()}${ext}`);
  },
});
const upload = multer({ storage });

/* --------------------------------- SQL --------------------------------- */

async function getUsersByOrg(orgId) {
  const { rows } = await dbQuery(
    `SELECT id, org_id, name, email, role, is_active, profile_photo_url, created_at, updated_at
     FROM users
     WHERE org_id = ?
     ORDER BY id DESC`,
    [orgId]
  );
  return rows;
}

async function emailExists(email) {
  const { rows } = await dbQuery(
    `SELECT id FROM users WHERE email = ? LIMIT 1`,
    [email]
  );
  return Array.isArray(rows) && rows.length > 0;
}

async function insertUser({ org_id, name, email, role, password }) {
  const password_hash = await bcrypt.hash(password, 10);
  const result = await dbExec(
    `INSERT INTO users
       (org_id, name, email, role, password_hash, is_active, created_at, updated_at)
     VALUES
       (?, ?, ?, ?, ?, 1, NOW(), NOW())`,
    [org_id, name, email, role, password_hash]
  );

  // mysql2 result has insertId; some wrappers put it as result.insertId too
  return result && (result.insertId || result.lastInsertId || null);
}

async function updateMyProfile(userId, patch) {
  const fields = [];
  const params = [];
  const allow = {
    name: 'name',
    phone: 'phone', // exists in your schema per screenshot
  };
  Object.keys(allow).forEach(k => {
    if (patch[k] !== undefined) {
      fields.push(`${allow[k]} = ?`);
      params.push(sanitizeText(patch[k]));
    }
  });
  if (!fields.length) return 0;

  params.push(userId);
  const result = await dbExec(
    `UPDATE users SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`,
    params
  );
  return (result && (result.affectedRows || result.rowCount)) || 0;
}

async function setMyPhoto(userId, relativeUrl) {
  const result = await dbExec(
    `UPDATE users SET profile_photo_url = ?, updated_at = NOW() WHERE id = ?`,
    [relativeUrl, userId]
  );
  return (result && (result.affectedRows || result.rowCount)) || 0;
}

/* -------------------------------- routes -------------------------------- */

/**
 * GET /users?org_id=...
 */
router.get('/', async (req, res) => {
  try {
    const org_id = parseInt(req.query.org_id, 10);
    if (!org_id) return apiError(res, 400, 'org_id is required');

    const users = await getUsersByOrg(org_id);
    return res.json({ ok: true, count: users.length, users });
  } catch (err) {
    console.error('GET /users error:', err);
    return apiError(res, 500, err.sqlMessage || err.message, 'server_error');
  }
});

/**
 * POST /users
 * Body: { org_id, name, email, role, password }
 */
router.post('/', async (req, res) => {
  try {
    const org_id  = parseInt(req.body.org_id, 10);
    const name    = sanitizeText(req.body.name);
    const email   = sanitizeEmail(req.body.email);
    const roleIn  = sanitizeText(req.body.role);
    const password= sanitizeText(req.body.password);

    if (!org_id || !name || !email || !roleIn || !password) {
      return apiError(res, 400, 'org_id, name, email, role, password are required');
    }

    const role = ROLE_MAP[roleIn] || roleIn;

    // basic email check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return apiError(res, 400, 'email is invalid');
    }

    // friendly unique check (DB unique index will still enforce)
    try {
      if (await emailExists(email)) {
        return apiError(res, 409, 'email already exists', 'conflict');
      }
    } catch (_e) { /* ignore soft check failures */ }

    const newId = await insertUser({ org_id, name, email, role, password });
    return res.status(201).json({ ok: true, id: newId });
  } catch (err) {
    // Normalize duplicate key to 409
    if (err && (err.code === 'ER_DUP_ENTRY' || /duplicate/i.test(err.message))) {
      return apiError(res, 409, 'email already exists', 'conflict');
    }
    console.error('POST /users error:', err);
    return apiError(res, 500, err.sqlMessage || err.message, 'server_error');
  }
});

/**
 * PATCH /users/me
 * Body: { name?, phone? }
 * If you don't have auth wired, pass ?user_id= for testing.
 */
router.patch('/me', async (req, res) => {
  try {
    const userId = (req.user && req.user.id) || parseInt(req.query.user_id, 10);
    if (!userId) {
      return apiError(res, 401, 'user not authenticated (missing user_id)', 'unauthorized');
    }
    const updated = await updateMyProfile(userId, req.body || {});
    return res.json({ ok: true, updated });
  } catch (err) {
    console.error('PATCH /users/me error:', err);
    return apiError(res, 500, err.sqlMessage || err.message, 'server_error');
  }
});

/**
 * POST /users/me/photo
 * Form-Data: photo (file)
 */
router.post('/me/photo', upload.single('photo'), async (req, res) => {
  try {
    const userId = (req.user && req.user.id) || parseInt(req.query.user_id, 10);
    if (!userId) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return apiError(res, 401, 'user not authenticated (missing user_id)', 'unauthorized');
    }
    if (!req.file) return apiError(res, 400, 'photo file is required (key: photo)');

    const relativeUrl = `/uploads/profiles/${path.basename(req.file.path)}`;
    try {
      await setMyPhoto(userId, relativeUrl);
    } catch (e) {
      // If column doesn't exist, we still return the URL.
      console.warn('profile_photo_url update skipped:', e.sqlMessage || e.message);
    }
    return res.status(201).json({ ok: true, url: relativeUrl });
  } catch (err) {
    console.error('POST /users/me/photo error:', err);
    return apiError(res, 500, err.sqlMessage || err.message, 'server_error');
  }
});

module.exports = router;


