// index.js
require('dotenv').config();
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 8080;

function safeRequire(p) {
  try { return require(p); } catch (e) { console.warn('module load failed', p, e && e.message); return null; }
}

// load routers (defensive)
const paymentsModule = safeRequire('./routes/payments');
const signupRouter = safeRequire('./routes/signup');
const adminRouter = safeRequire('./routes/admin');
const organizationsRouter = safeRequire('./routes/organizations');

// mount payments webhook raw BEFORE express.json()
if (paymentsModule && typeof paymentsModule.webhookHandler === 'function') {
  app.post('/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
      await paymentsModule.webhookHandler(req, res);
    } catch (err) {
      console.error('webhook handler error', err && err.stack ? err.stack : err);
      res.status(500).send('webhook handler error');
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

// simple JWT auth helpers
const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ ok: false, error: 'missing token' });
  try {
    const decoded = jwt.verify(m[1], JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'invalid token' });
  }
}
function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || (req.user.role || '') !== role) return res.status(403).json({ ok: false, error: 'forbidden' });
    return next();
  };
}

// helper DB find user by email
async function findUserByEmail(email) {
  const rows = await db.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
  if (!rows) return null;
  return Array.isArray(rows) ? rows[0] : rows;
}

// POST /auth/login
// - if user has password_hash -> bcrypt compare
// - else if plaintext password column matches -> migrate to bcrypt automatically
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, error: 'email and password required' });

    const user = await findUserByEmail(email);
    if (!user) return res.status(401).json({ ok: false, error: 'invalid credentials' });

    // prefer bcrypt hash if present
    if (user.password_hash && user.password_hash.trim() !== '') {
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return res.status(401).json({ ok: false, error: 'invalid credentials' });
    } else {
      // fallback: plaintext comparison (legacy)
      if (user.password && user.password === password) {
        // migrate: create hash and clear plaintext
        try {
          const h = await bcrypt.hash(password, 10);
          await db.query('UPDATE users SET password_hash = ?, password = NULL, updated_at = NOW() WHERE id = ?', [h, user.id]);
          console.log('Migrated user to bcrypt:', user.email);
        } catch (e) {
          console.warn('Password migration failed for', user.email, e && e.message);
        }
      } else {
        return res.status(401).json({ ok: false, error: 'invalid credentials' });
      }
    }

    const payload = { sub: user.id, id: user.id, role: user.role || 'normal', email: user.email, name: user.name };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
    return res.json({
      ok: true,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, org_id: user.org_id },
      accessToken: token
    });
  } catch (err) {
    console.error('/auth/login error', err && err.stack ? err.stack : err);
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
    console.error('/auth/me error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

// Mount routers
if (paymentsModule) {
  const paymentsRouter = paymentsModule.router || paymentsModule;
  app.use('/payments', paymentsRouter);
}
if (signupRouter) app.use('/signup', signupRouter);
if (adminRouter) app.use('/admin', adminRouter);
if (organizationsRouter) app.use('/organizations', organizationsRouter);

// minimal debug user endpoint (safe)
app.get('/_debug/user', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ ok: false, error: 'email required' });
    const rows = await db.query('SELECT id, email, password IS NOT NULL AS has_password, password_hash IS NOT NULL AS has_password_hash, role, org_id, created_at FROM users WHERE email = ? LIMIT 1', [email]);
    const user = Array.isArray(rows) ? rows[0] : rows;
    if (!user) return res.status(404).json({ ok: false, error: 'not found' });
    return res.json({ ok: true, user });
  } catch (e) {
    console.error('_debug/user error', e && e.message);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

// generic 404 for API routes should return JSON (avoid HTML 404 pages for API)
app.use((req, res, next) => {
  if (req.path.startsWith('/auth') || req.path.startsWith('/payments') || req.path.startsWith('/signup') || req.path.startsWith('/admin') || req.path.startsWith('/organizations')) {
    return res.status(404).json({ ok: false, error: 'not found' });
  }
  next();
});

// error handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error', err && err.stack ? err.stack : err);
  res.status(500).json({ ok: false, error: 'server error' });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});


