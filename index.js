// index.js (full-file)
// Entry point for EasyQue backend

require('dotenv').config();
const path = require('path');
const express = require('express');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs'); // in case users' passwords are hashed
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 8080;

/**
 * Load routers/modules. We'll try to be defensive:
 * - payments module may export either an express.Router or { router, webhookHandler }.
 * - admin/signup/auth routers may exist under routes/.
 */
let paymentsModule;
try {
  paymentsModule = require('./routes/payments');
} catch (e) {
  console.warn('routes/payments not found or failed to load:', e && e.message);
  paymentsModule = null;
}

let signupRouter;
try { signupRouter = require('./routes/signup'); } catch (e) { signupRouter = null; }
let adminRouter;
try { adminRouter = require('./routes/admin'); } catch (e) { adminRouter = null; }
let authRouter;
try { authRouter = require('./routes/auth'); } catch (e) { authRouter = null; }

/**
 * Fallback authentication middleware (if middleware/auth.js is missing).
 * It verifies JWT in "Authorization: Bearer <token>"
 */
let requireAuth, requireRole;
try {
  const authMw = require('./middleware/auth');
  requireAuth = authMw.requireAuth;
  requireRole = authMw.requireRole;
} catch (e) {
  console.warn('middleware/auth not found or failed to load, using fallback JWT auth');
  requireAuth = (req, res, next) => {
    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ ok: false, error: 'missing token' });
    const token = m[1];
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'devsecret');
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
 * IMPORTANT: mount the payments webhook raw handler BEFORE express.json(),
 * otherwise the raw body needed for HMAC verification will be lost.
 */
if (paymentsModule && typeof paymentsModule.webhookHandler === 'function') {
  app.post('/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
      await paymentsModule.webhookHandler(req, res);
    } catch (err) {
      console.error('payments/webhook handler failed:', err && err.message);
      res.status(500).send('webhook handler error');
    }
  });
} else {
  // Provide a safe fallback route to avoid 404 HTML responses:
  app.post('/payments/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    console.warn('payments.webhook not configured on server');
    res.status(501).send('webhook not configured');
  });
}

// JSON body parser for the rest of routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// static files (frontend HTML pages are in project root)
app.use(express.static(path.join(__dirname)));

// Simple health endpoint
app.get('/_health', (req, res) => res.json({ ok: true, now: new Date().toISOString() }));

/**
 * Authentication endpoints.
 * We provide POST /auth/login and GET /auth/me that always return JSON.
 * If your repo already has routes/auth providing richer logic, those will still be mounted further below.
 */

// Helper: find user by email
async function findUserByEmail(email) {
  const rows = await db.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
  if (!rows) return null;
  const row = Array.isArray(rows) ? rows[0] : rows;
  return row;
}

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ ok: false, error: 'email and password required' });

    const row = await findUserByEmail(email);
    if (!row) return res.status(401).json({ ok: false, error: 'invalid credentials' });

    // Support both hashed (password_hash) and legacy plaintext (password)
    let passwordOk = false;
    if (row.password_hash) {
      try {
        passwordOk = await bcrypt.compare(password, row.password_hash);
      } catch (e) { passwordOk = false; }
    } else if (row.password) {
      // fallback (not recommended) - compare plaintext
      passwordOk = (password === row.password);
    } else {
      // no password fields present - reject
      return res.status(401).json({ ok: false, error: 'no password configured for user' });
    }

    if (!passwordOk) return res.status(401).json({ ok: false, error: 'invalid credentials' });

    const tokenPayload = {
      sub: row.id,
      role: row.role || 'normal',
      email: row.email,
      name: row.name
    };
    const accessToken = jwt.sign(tokenPayload, process.env.JWT_SECRET || 'devsecret', { expiresIn: '7d' });

    const userPublic = {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      org_id: row.org_id
    };

    return res.json({ ok: true, user: userPublic, accessToken });
  } catch (err) {
    console.error('POST /auth/login error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: 'server error', details: err && err.message });
  }
});

app.get('/auth/me', requireAuth, async (req, res) => {
  try {
    // req.user should contain decoded token with sub (user id)
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

/**
 * Mount routers (payments: non-webhook endpoints, admin, signup, auth if available)
 * paymentsModule may export { router } or an express.Router directly.
 */
if (paymentsModule) {
  const paymentsRouter = paymentsModule.router || paymentsModule;
  app.use('/payments', paymentsRouter);
}

if (signupRouter) {
  app.use('/signup', signupRouter);
}

if (adminRouter) {
  app.use('/admin', adminRouter);
}

if (authRouter) {
  app.use('/auth', authRouter);
}

/**
 * Admin UI or debugging helper endpoints (optional)
 */
app.get('/_debug/fees', async (req, res) => {
  try {
    const rows = await db.query('SELECT key_name, value_decimal, value_text FROM fee_settings');
    return res.json({ ok: true, rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Daily cron job: expire unpaid trials that passed trial_expires_at.
 * This is a simple safe job — it marks signup_trials.payment_status='expired'
 * and sets org_subscriptions.status='suspended' for affected orgs.
 *
 * You can customize or remove it later.
 */
async function expireUnpaidTrials() {
  try {
    // Load configured free_trial_days (fallback to 7)
    const r = await db.query('SELECT value_decimal FROM fee_settings WHERE key_name = ? LIMIT 1', ['free_trial_days']);
    let freeTrialDays = 7;
    if (Array.isArray(r) && r.length) freeTrialDays = Number(r[0].value_decimal) || freeTrialDays;
    // Mark signup_trials expired where trial_expires_at < NOW() and not paid
    const res1 = await db.query("UPDATE signup_trials SET payment_status = 'expired', updated_at = NOW() WHERE trial_expires_at IS NOT NULL AND trial_expires_at < NOW() AND (payment_status IS NULL OR payment_status != 'paid')");
    // Optionally suspend org_subscriptions for those orgs
    const res2 = await db.query("UPDATE org_subscriptions s JOIN signup_trials t ON t.org_id = s.org_id SET s.status = 'suspended', s.updated_at = NOW() WHERE t.trial_expires_at IS NOT NULL AND t.trial_expires_at < NOW() AND (t.payment_status IS NULL OR t.payment_status != 'paid')");
    console.log('[cron] expireUnpaidTrials completed');
  } catch (e) {
    console.error('[cron] expireUnpaidTrials error', e && e.message);
  }
}

// run expireUnpaidTrials once at startup (safe) and schedule daily at 02:30 server time
expireUnpaidTrials().catch(() => {});
try {
  const cron = require('node-cron');
  cron.schedule('30 2 * * *', () => {
    console.log('[cron] running expireUnpaidTrials');
    expireUnpaidTrials();
  });
} catch (e) {
  console.warn('node-cron not installed; skipping schedule. To enable daily cron, install node-cron: npm i node-cron');
}

// catch-all for 404 (return JSON for API calls)
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/payments') || req.path.startsWith('/admin') || req.path.startsWith('/signup')) {
    return res.status(404).json({ ok: false, error: 'not found' });
  }
  next();
});

// error handler (JSON for API)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err && err.stack ? err.stack : err);
  if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/payments')) {
    return res.status(500).json({ ok: false, error: 'server error' });
  } else {
    res.status(500).send('server error');
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log('Ensure you set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, WEBHOOK_SECRET, JWT_SECRET in .env');
});
