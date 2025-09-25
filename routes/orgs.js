// routes/orgs.js
const express = require('express');
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config');

const router = express.Router();

// uploads folder (ensure exists)
const uploadsDir = path.join(__dirname, '..', 'uploads', 'org_banners');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    const name = `${Date.now()}-${Math.round(Math.random()*10000)}${ext}`;
    cb(null, name);
  }
});
const upload = multer({ storage });

/**
 * POST /orgs
 * Create organization
 * body: { name, address, phone, email, map_link }
 */
router.post('/', async (req, res) => {
  try {
    const { name, address, phone, email, map_link } = req.body;
    if (!name) return res.status(400).json({ ok:false, error:'name required' });

    const r = await db.query('INSERT INTO organizations (name, address, phone, email, map_link, created_at) VALUES (?, ?, ?, ?, ?, NOW())', [name, address||null, phone||null, email||null, map_link||null]);
    const org = (await db.query('SELECT * FROM organizations WHERE id = ?', [r.insertId]))[0];
    return res.json({ ok:true, org });
  } catch (err) {
    console.error('POST /orgs error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

/**
 * GET /orgs/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const rows = await db.query('SELECT * FROM organizations WHERE id = ?', [id]);
    if (!rows || !rows[0]) return res.status(404).json({ ok:false, error:'not_found' });
    return res.json({ ok:true, org: rows[0] });
  } catch (err) {
    console.error('GET /orgs/:id error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

/**
 * POST /orgs/:id/banner
 * Upload banner image; saves file to uploads/org_banners and updates organizations.banner_url
 */
router.post('/:id/banner', upload.single('banner'), async (req, res) => {
  try {
    const id = req.params.id;
    if (!req.file) return res.status(400).json({ ok:false, error:'file_required' });
    // create public URL based on server base (if serving uploads static, else path)
    const rel = `/uploads/org_banners/${req.file.filename}`; // ensure you serve /uploads static
    await db.query('UPDATE organizations SET banner_url = ? WHERE id = ?', [rel, id]);
    return res.json({ ok:true, banner_url: rel });
  } catch (err) {
    console.error('POST /orgs/:id/banner error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

/**
 * GET /orgs/:id/users
 * list users in org (simple)
 */
router.get('/:id/users', async (req, res) => {
  try {
    const id = req.params.id;
    const rows = await db.query('SELECT id, name, email, role, is_active FROM users WHERE org_id = ?', [id]);
    return res.json({ ok:true, users: rows });
  } catch (err) {
    console.error('GET /orgs/:id/users error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

/**
 * POST /orgs/:id/users
 * Create a user for the org: body { name, email, phone, role }
 */
router.post('/:id/users', async (req, res) => {
  try {
    const id = req.params.id;
    const { name, email, phone, role } = req.body;
    if (!name || !email) return res.status(400).json({ ok:false, error:'name_email_required' });
    const r = await db.query('INSERT INTO users (org_id, name, email, phone, role, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, NOW())', [id, name, email, phone||null, role||'assigned_user']);
    const user = (await db.query('SELECT id, name, email, role, is_active FROM users WHERE id = ?', [r.insertId]))[0];
    return res.json({ ok:true, user });
  } catch (err) {
    console.error('POST /orgs/:id/users error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

/**
 * PUT /orgs/:id
 * update organization
 */
router.put('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { name, address, phone, email, map_link } = req.body;
    await db.query('UPDATE organizations SET name = ?, address = ?, phone = ?, email = ?, map_link = ?, updated_at = NOW() WHERE id = ?',
      [name||null, address||null, phone||null, email||null, map_link||null, id]);
    const org = (await db.query('SELECT * FROM organizations WHERE id = ?', [id]))[0];
    return res.json({ ok:true, org });
  } catch (err) {
    console.error('PUT /orgs/:id error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

module.exports = router;
