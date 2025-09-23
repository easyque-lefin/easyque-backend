// index.js (bcrypt-only login)
// Replace your index.js with this version once you have migrated all plaintext passwords.
// This file still mounts payments/signup/admin routers if they exist.

require('dotenv').config();
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 8080;

// load routers (defensive)
let paymentsModule = null;
try { paymentsModule = require('./routes/payments'); } catch (e) { console.warn('payments module load failed', e && e.message); }
let signupRouter = null;
try { signupRouter = require('./routes/signup'); } catch (e) { console.warn('signup router load failed', e && e.message); }
let adminRouter = null;
try { adminRouter = require('./routes/admin'); } catch (e) { console.warn('admin router load failed', e && e.message); }
let authRouter = null;
try { authRouter = require('./routes/auth'); } catch (e) { /* optional */ }

// minimal JWT auth middleware fallback
let requireAuth = (req, res, next) => {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ ok: false, error: 'missing token' });
  try {
    const decoded = jwt.verify(m[1], process.env.JWT_SECRET || 'devsecret');
    req.user = decoded;
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'invalid token' });
  }
};
let requireRole = role => (req, res, next) => {
  if (!req.user || (req.user.role || '') !== role) return res.status(403).json({ ok: false, error: 'forbidden' });
  return next();
};

// Mount payments webhook raw handler first if present
if (paymentsModule && typeof paymentsModule.webhookHandler === 'function') {
  app.post('/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
      await paymentsModule.webhookHandler(req, res);
    } catch (err) {
      console.error('webhook handler error', err && err.message);
      res.status(500).send('webhook error');
    }
  });
} else {
  app.post('/payments/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    res.status(501).send('webhook not configured');
  });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

app.get('/_health', (req, res) => res.json({ ok: true }));

async function findUserByEmail(email) {
  const rows = await db.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
  if (!rows) return null;
  return Array.isArray(rows) ? rows[0] : rows;
}

// POST /auth/login -> bcrypt-only
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, error: 'email and password required' });

    const user = await findUserByEmail(email);
    if (!user) return res.status(401).json({ ok: false, error: 'invalid credentials' });

    if (!user.password_hash || user.password_hash.trim() === '') {
      console.warn('User has no password_hash; login disallowed for email:', email);
      return res.status(401).json({ ok: false, error: 'invalid credentials' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      console.warn('bcrypt compare failed for email:', email);
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
    console.error('GET /auth/me', err && err.message);
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

app.use((req, res, next) => {
  if (req.path.startsWith('/auth') || req.path.startsWith('/payments') || req.path.startsWith('/signup') || req.path.startsWith('/admin')) {
    return res.status(404).json({ ok: false, error: 'not found' });
  }
  next();
});

app.use((err, req, res, next) => {
  console.error('Unhandled error', err && err.stack ? err.stack : err);
  res.status(500).json({ ok: false, error: 'server error' });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

