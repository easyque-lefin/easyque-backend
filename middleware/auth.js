// middleware/auth.js (hardened)
// JWT verification + role guards

require('dotenv').config();
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET is required in production');
}

function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const payload = jwt.verify(token, JWT_SECRET || 'dev-only');
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'invalid_token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    next();
  };
}

/** Only the super-admin owner should access admin hub */
function requireSuperAdminEmail(req, res, next) {
  const email = (req.user && req.user.email) || '';
  if (email.toLowerCase() !== 'easyque0@gmail.com') {
    return res.status(403).json({ ok: false, error: 'admin_only' });
  }
  next();
}

module.exports = { requireAuth, requireRole, requireSuperAdminEmail };

