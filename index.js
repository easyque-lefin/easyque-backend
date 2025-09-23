// index.js (full)
require('dotenv').config();
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 8080;

// Load routers
let paymentsModule = null;
try { paymentsModule = require('./routes/payments'); } catch (e) { console.warn('payments module missing', e && e.message); }
let signupRouter = null;
try { signupRouter = require('./routes/signup'); } catch (e) { console.warn('signup router missing', e && e.message); }
let adminRouter = null;
try { adminRouter = require('./routes/admin'); } catch (e) { console.warn('admin router missing', e && e.message); }
let authRouter = null;
try { authRouter = require('./routes/auth'); } catch (e) { /* ignore */ }

// Fallback auth middleware if middleware/auth.js not present
let requireAuth, requireRole;
try {
  const authMw = require('./middleware/auth');
  requireAuth = authMw.requireAuth;
  requireRole = authMw.requireRole;
} catch (e) {
  requireAuth = (req, res, next) => {
    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ ok: false, error: 'missing token' });
    try {
      const decoded = jwt.verify(m[1], process.env.JWT_SECRET || 'devsecret');
      req.user = decoded;
      return next();
    } catch (err) {
      return res.status(401).json({ ok: false, error: 'invalid token' });
    }
  };
  requireRole = role => (req, res, next) => {
    if (!req.user || (req.user.role || '') !== role) return res.status(403).json({ ok: false, error: 'forbidden' });
    return next();
  };
}

/**
 * Mount raw webhook before express.json()
 */
if (paymentsModule && typeof paymentsModule.webhookHandler === 'function') {
  app.post('/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
      await paymentsModule.webhookHandler(req, res);
    } catch (err) {
      console.error('payments/webhook error', err && err.message);
      res.status(500).send('webhook error');
    }
  });
} else {
  app.post('/payments/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    console.warn('Webhook endpoint not configured properly');
    res.status(501).send('webhook not configured');
  });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// Health
app.get('/_health', (req, res) => res.json({ ok: true }));

// AUTH: POST /auth/login and GET /auth/me
async function findUserByEmail(email) {
  const rows = await db.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
  if (!rows) return null;
  return Array.isArray(rows) ? rows[0] : rows;
}

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, error: 'email and password required' });

    const user = await findUserByEmail(email);
    if (!user) return res.status(401).json({ ok: false, error: 'invalid credentials' });

    // Try bcrypt compare if password_hash exists
    let ok = false;
    try {
      if (user.password_hash) {
        ok = await bcrypt.compare(password, user.password_hash);
      }
    } catch (e) {
      console.warn('bcrypt compare error', e && e.message);
      ok = false;
    }

    // fallback: compare legacy plaintext 'password' column
    if (!ok && user.password) {
      ok = (password === user.password);
    }

    // fallback: compare sha256 if password_hash not bcrypt (some older systems store sha256)
    if (!ok && user.password_hash) {
      try {
        const h = crypto.createHash('sha256').update(password).digest('hex');
        if (h === user.password_hash) ok = true;
      } catch (e) { /* ignore */ }
    }

    if (!ok) {
      console.warn('login failed for', email, '- password mismatch. user row hint:', {
        id: user.id,
        has_password_hash: !!user.password_hash,
        has_plain_password: !!user.password
      });
      return res.status(401).json({ ok: false, error: 'invalid credentials' });
    }

    const payload = { sub: user.id, role: user.role || 'normal', email: user.email, name: user.name };
    const accessToken = jwt.sign(payload, process.env.JWT_SECRET || 'devsecret', { expiresIn: '7d' });

    return res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email, role: user.role, org_id: user.org_id }, accessToken });
  } catch (err) {
    console.error('POST /auth/login error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

app.get('/auth/me', requireAuth, async (req, res) => {
  try {
    const uid = req.user && (req.user.sub || req.user.id);
    if (!uid) return res.status(401).json({ ok: false, error: 'invalid token' });
    const rows = await db.query('SELECT id, name, email, role, org_id FROM users WHERE id = ? LIMIT 1', [uid]);
    const user = Array.isArray(rows) ? rows[0] : rows;
    if (!user) return res.status(404).json({ ok: false, error: 'user not found' });
    return res.json({ ok: true, user });
  } catch (err) {
    console.error('GET /auth/me error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

// mount routers
if (paymentsModule) {
  const paymentsRouter = paymentsModule.router || paymentsModule;
  app.use('/payments', paymentsRouter);
}
if (signupRouter) app.use('/signup', signupRouter);
if (adminRouter) app.use('/admin', adminRouter);
if (authRouter) app.use('/auth', authRouter);

// small debug endpoint to inspect a user (admin-only in production - remove when done)
// USE: GET /_debug/user?email=easyque0@gmail.com
app.get('/_debug/user', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ ok: false, error: 'email required' });
    const rows = await db.query('SELECT id, email, password, password_hash, role, org_id, created_at FROM users WHERE email = ? LIMIT 1', [email]);
    const user = Array.isArray(rows) ? rows[0] : rows;
    if (!user) return res.status(404).json({ ok: false, error: 'not found' });
    // Return the row but DO NOT RETURN password or password_hash to public logs. We will show presence only.
    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        org_id: user.org_id,
        created_at: user.created_at,
        has_password: !!user.password,
        has_password_hash: !!user.password_hash
      }
    });
  } catch (e) {
    console.error('_debug/user error', e && e.message);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

// final error handlers
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/payments') || req.path.startsWith('/signup') || req.path.startsWith('/admin')) {
    return res.status(404).json({ ok: false, error: 'not found' });
  }
  next();
});
app.use((err, req, res, next) => {
  console.error('Unhandled error', err && err.stack ? err.stack : err);
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/payments')) {
    return res.status(500).json({ ok: false, error: 'server error' });
  }
  res.status(500).send('server error');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

