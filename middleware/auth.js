// middleware/auth.js
require('dotenv').config();
const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'replace-me-in-env';

function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ ok:false, error: 'Missing token' });
    const token = h.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    // attach user info to req.user
    req.user = { id: payload.id, email: payload.email, role: payload.role, org_id: payload.org_id || null };
    next();
  } catch (err) {
    return res.status(401).json({ ok:false, error: 'Invalid token', details: err.message });
  }
}

// requireRole returns middleware that checks req.user.role
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok:false, error: 'Not authenticated' });
    if (!allowedRoles.includes(req.user.role)) return res.status(403).json({ ok:false, error: 'Forbidden' });
    next();
  };
}

module.exports = { requireAuth, requireRole };
