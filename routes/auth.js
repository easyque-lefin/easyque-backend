// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'replace-me-in-env';
const ACCESS_TOKEN_EXPIRES = process.env.ACCESS_TOKEN_EXPIRES || '15m';

// helper to return public user view
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    org_id: row.org_id || null,
    phone: row.phone || null,
    designation: row.designation || null,
    department: row.department || null,
    profile_photo: row.profile_photo || null,
    is_active: !!row.is_active,
    created_at: row.created_at || null
  };
}

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    // Find user by email (adjust fields to match your DB)
    const rows = await db.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
    const user = rows && rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (!user.is_active) return res.status(403).json({ error: 'Account disabled' });

    // Support older column names (password vs password_hash)
    const stored = user.password || user.password_hash || '';
    const ok = await bcrypt.compare(password, stored);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const payload = { id: user.id, email: user.email, role: user.role, org_id: user.org_id || null };
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES });

    res.json({ ok: true, user: publicUser(user), accessToken });
  } catch (err) {
    console.error('POST /auth/login error', err);
    res.status(500).json({ error: 'server error', details: err.message });
  }
});

// simple auth middleware for /auth/me
async function requireAuth(req, res, next) {
  try {
    const h = req.headers && (req.headers.authorization || req.headers.Authorization);
    if (!h) return res.status(401).json({ error: 'missing authorization' });
    const parts = h.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') return res.status(401).json({ error: 'invalid authorization header' });
    const token = parts[1];
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ error: 'invalid or expired token' });
    }
    // attach user info
    req.user = decoded;
    next();
  } catch (err) {
    console.error('requireAuth error', err);
    res.status(500).json({ error: 'server error', details: err.message });
  }
}

// GET /auth/me
router.get('/me', requireAuth, async (req, res) => {
  try {
    const id = req.user && req.user.id;
    if (!id) return res.status(401).json({ error: 'invalid token' });
    const rows = await db.query('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'user not found' });
    res.json({ ok: true, user: publicUser(rows[0]) });
  } catch (err) {
    console.error('GET /auth/me error', err);
    res.status(500).json({ error: 'server error', details: err.message });
  }
});

module.exports = router;
