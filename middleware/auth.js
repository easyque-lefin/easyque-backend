// middleware/auth.js
// JWT verification + role guards

require('dotenv').config();
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'changeme';

function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    const r = (req.user && (req.user.role || req.user.user_role)) || '';
    if (!roles.includes(r)) return res.status(403).json({ ok: false, error: 'Forbidden' });
    next();
  };
}

/** Only the super-admin owner should access admin hub */
function requireSuperAdminEmail(req, res, next) {
  const email = (req.user && req.user.email) || '';
  if (email.toLowerCase() !== 'easyque0@gmail.com') {
    return res.status(403).json({ ok: false, error: 'Admin only' });
  }
  next();
}

module.exports = { requireAuth, requireRole, requireSuperAdminEmail };
