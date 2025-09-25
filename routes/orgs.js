// routes/orgs.js
// Organization management: create org, get org details, upload banner, manage org's users (basic)

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const config = require('../config');

const router = express.Router();

// Setup multer for banner uploads
const uploadDir = path.join(__dirname, '..', 'uploads', 'org_banners');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function(req, file, cb) {
    const ext = path.extname(file.originalname);
    const name = `org_${req.params.id || 'unknown'}_${Date.now()}${ext}`;
    cb(null, name);
  }
});
const upload = multer({ storage });

// Create organization
// POST /orgs
// body: { name, admin_name, admin_email, admin_phone, address, timezone }
router.post('/', async (req, res) => {
  try {
    const { name, admin_name, admin_email, admin_phone, address, timezone } = req.body || {};
    if (!name) return res.status(400).json({ ok:false, error:'name_required' });

    const r = await db.query('INSERT INTO organizations (name, address, timezone, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())', [name, address || null, timezone || null]);
    const orgId = r.insertId;

    // create initial org admin user in users table (if present)
    try {
      if (admin_name || admin_email || admin_phone) {
        await db.query('INSERT INTO users (org_id, name, email, phone, role, is_active, created_at) VALUES (?, ?, ?, ?, "org_admin", 1, NOW())', [orgId, admin_name || null, admin_email || null, admin_phone || null]);
      }
    } catch (e) {
      console.warn('Could not create org admin user automatically:', e.message);
    }

    const org = (await db.query('SELECT * FROM organizations WHERE id = ?', [orgId]))[0];
    return res.json({ ok:true, org });
  } catch (err) {
    console.error('POST /orgs error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

// GET /orgs/:id - organization details
router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const org = (await db.query('SELECT * FROM organizations WHERE id = ?', [id]))[0];
    if (!org) return res.status(404).json({ ok:false, error:'not_found' });
    return res.json({ ok:true, org });
  } catch (err) {
    console.error('GET /orgs/:id error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

// Upload banner for org
// POST /orgs/:id/banner (multipart/form-data) -> returns banner_url
router.post('/:id/banner', upload.single('banner'), async (req, res) => {
  try {
    const id = req.params.id;
    if (!req.file) return res.status(400).json({ ok:false, error:'file_required' });

    const relPath = `/uploads/org_banners/${req.file.filename}`;
    // update organization record
    await db.query('UPDATE organizations SET banner_url = ? WHERE id = ?', [relPath, id]);

    return res.json({ ok:true, banner_url: relPath });
  } catch (err) {
    console.error('POST /orgs/:id/banner error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

/**
 * GET /orgs/:id/users
 * List users belonging to org (if users table exists)
 */
router.get('/:id/users', async (req, res) => {
  try {
    const id = req.params.id;
    try {
      const users = await db.query('SELECT id, org_id, name, email, phone, role, is_active FROM users WHERE org_id = ?', [id]);
      return res.json({ ok:true, users });
    } catch (e) {
      return res.status(200).json({ ok:true, users: [], message: 'users_table_missing_or_error' });
    }
  } catch (err) {
    console.error('GET /orgs/:id/users error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

/**
 * POST /orgs/:id/users
 * Create a user within an org (admin use)
 * body: { name, email, phone, role }
 */
router.post('/:id/users', async (req, res) => {
  try {
    const id = req.params.id;
    const { name, email, phone, role } = req.body || {};
    if (!name) return res.status(400).json({ ok:false, error:'name_required' });

    // create user if users table exists
    try {
      const r = await db.query('INSERT INTO users (org_id, name, email, phone, role, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, NOW())', [id, name, email || null, phone || null, role || 'staff']);
      const user = (await db.query('SELECT id, org_id, name, email, phone, role, is_active FROM users WHERE id = ?', [r.insertId]))[0];
      return res.json({ ok:true, user });
    } catch (e) {
      return res.status(500).json({ ok:false, error:'users_table_missing_or_query_failed', details: e.message });
    }
  } catch (err) {
    console.error('POST /orgs/:id/users error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

module.exports = router;

