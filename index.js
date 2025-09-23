// index.js (full file) - consolidated + payments webhook ordering + auth endpoints
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cron = require('node-cron');

const db = require('./db'); // expects { query(sql, params) => Promise<rows> }
const authRefreshRoutes = require('./routes/auth-refresh'); // optional
const debugRoutes = require('./routes/debug'); // optional
const signupRoutes = require('./routes/signup'); // you have this
const paymentsModule = require('./routes/payments'); // should export router and optionally webhookHandler
const adminRoutes = require('./routes/admin'); // has PUT /fees
const { requireAuth, requireRole } = require('./middleware/auth');

const app = express();
const PORT = parseInt(process.env.PORT || '8080', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'replace-me-in-env';
const ACCESS_TOKEN_EXPIRES = process.env.ACCESS_TOKEN_EXPIRES || '15m';

// nodemailer transport (optional)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// helper: public user view
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, email: row.email, role: row.role,
    org_id: row.org_id || null, phone: row.phone || null,
    designation: row.designation || null, department: row.department || null,
    profile_photo: row.profile_photo || null, is_active: !!row.is_active,
    created_at: row.created_at || null
  };
}

// uploads setup
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = (file.originalname && file.originalname.split('.').pop()) || '';
    const name = `${Date.now()}-${Math.round(Math.random()*1e6)}${ext ? '.' + ext : ''}`;
    cb(null, name);
  }
});
const upload = multer({ storage, limits: { fileSize: 6 * 1024 * 1024 } });

// ==== PAYMENTS WEBHOOK: mount raw handler BEFORE express.json()
const paymentsRouter = paymentsModule && (paymentsModule.router || paymentsModule) || null;
const paymentsWebhookHandler = paymentsModule && paymentsModule.webhookHandler;

if (typeof paymentsWebhookHandler === 'function') {
  // raw body so we can verify Razorpay signature
  app.post('/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
      await paymentsWebhookHandler(req, res);
    } catch (err) {
      console.error('payments webhook handler error', err);
      res.status(500).send('webhook handler error');
    }
  });
} else {
  // safety; respond 501 so Razorpay receives known response rather than 404 html
  app.post('/payments/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    console.warn('payments.webhookHandler not implemented - ignoring webhook');
    res.status(501).json({ ok:false, error:'webhook handler not configured' });
  });
}

// now safe to parse JSON for other endpoints
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname)));
app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.url, 'body=', (req.body && typeof req.body === 'object') ? req.body : (req.body ? '[raw]' : {}));
  next();
});

// mount payments router for normal payment endpoints (create order etc)
if (paymentsRouter && typeof paymentsRouter === 'function') {
  app.use('/payments', paymentsRouter);
} else {
  app.use('/payments', (req, res) => res.status(501).json({ ok:false, error:'payments module not configured' }));
}

// static root
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// mount optional routes
if (authRefreshRoutes) app.use('/auth-refresh', authRefreshRoutes);
if (debugRoutes) app.use('/_debug', debugRoutes);

// --- AUTH endpoints (ensures client POST /auth/login exists) ---
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const rows = await db.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
    const user = rows && rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (!user.is_active) return res.status(403).json({ error: 'Account disabled' });

    const ok = await bcrypt.compare(password, user.password || user.password_hash || '');
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const payload = { id: user.id, email: user.email, role: user.role, org_id: user.org_id || null };
    const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES });

    res.json({ ok: true, user: publicUser(user), accessToken });
  } catch (err) {
    console.error('/auth/login error', err);
    res.status(500).json({ error: 'server error', details: err.message });
  }
});

app.get('/auth/me', async (req, res) => {
  try {
    const auth = req.headers && req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;
    if (!auth) return res.status(401).json({ error: 'no token' });
    let payload;
    try { payload = jwt.verify(auth, JWT_SECRET); } catch (e) { return res.status(401).json({ error:'invalid token' }); }
    const rows = await db.query('SELECT * FROM users WHERE id = ? LIMIT 1', [payload.id]);
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true, user: publicUser(rows[0]) });
  } catch (err) {
    console.error('/auth/me error', err);
    res.status(500).json({ error: 'server error', details: err.message });
  }
});

// mount signup and admin routers
if (signupRoutes) app.use('/signup', signupRoutes);
if (adminRoutes) app.use('/admin', requireAuth, requireRole('admin'), adminRoutes);

// ORGANIZATIONS (GET list or search)
app.get('/organizations', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q) {
      if (/^\d+$/.test(q)) {
        const rows = await db.query('SELECT id, name, slug, location, services, photo, created_at FROM organizations WHERE id = ? LIMIT 1', [parseInt(q,10)]);
        return res.json({ ok:true, organizations: rows.length ? [rows[0]] : [] });
      }
      const like = `%${q}%`;
      const rows = await db.query('SELECT id, name, slug, location, services, photo, created_at FROM organizations WHERE name LIKE ? OR slug LIKE ? ORDER BY id DESC LIMIT 200', [like, like]);
      return res.json({ ok:true, organizations: rows || [] });
    }
    const rows = await db.query('SELECT id, name, slug, location, services, photo, created_at FROM organizations ORDER BY id DESC LIMIT 200');
    res.json({ ok:true, organizations: rows || [] });
  } catch (err) {
    console.error('GET /organizations error', err);
    res.status(500).json({ ok:false, error: err.message });
  }
});

// GET single organization
app.get('/organizations/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10); if (!id) return res.status(400).json({ error: 'invalid id' });
    const rows = await db.query('SELECT id, name, slug, location, services, photo, created_at FROM organizations WHERE id = ? LIMIT 1', [id]);
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'not found' });
    res.json({ ok:true, organization: rows[0] });
  } catch (err) { console.error('GET /organizations/:id error', err); res.status(500).json({ ok:false, error: err.message }); }
});

// Departments
app.get('/organizations/:id/departments', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10); if (!id) return res.status(400).json({ error: 'invalid id' });
    let rows = [];
    try { rows = await db.query('SELECT name FROM departments WHERE org_id = ? ORDER BY name', [id]); } catch (e) { rows = []; }
    if (!rows || rows.length === 0) {
      rows = await db.query('SELECT DISTINCT department FROM users WHERE org_id = ? AND department IS NOT NULL ORDER BY department', [id]);
      const depts = (rows || []).map(r => ({ name: r.department }));
      return res.json({ ok:true, departments: depts });
    }
    res.json({ ok:true, departments: rows.map(r => ({ name: r.name })) });
  } catch (err) { console.error('GET /organizations/:id/departments error', err); res.status(500).json({ ok:false, error: err.message }); }
});

// Users for org
app.get('/organizations/:id/users', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10); if (!id) return res.status(400).json({ error: 'invalid id' });
    const role = req.query.role || null;
    const params = [id];
    let sql = 'SELECT id, name, email, role, department, is_active FROM users WHERE org_id = ?';
    if (role) { sql += ' AND role = ?'; params.push(role); }
    sql += ' ORDER BY name';
    const rows = await db.query(sql, params);
    res.json({ ok:true, users: rows || [] });
  } catch (err) { console.error('GET /organizations/:id/users error', err); res.status(500).json({ ok:false, error: err.message }); }
});

// Create booking (keeps your original logic)
app.post('/bookings', requireAuth, requireRole('admin', 'receptionist'), async (req, res) => {
  try {
    const requester = req.user || {};
    let org_id = requester.org_id || null;
    if (!org_id && requester.role === 'admin' && req.body && req.body.org_id) org_id = req.body.org_id;
    if (!org_id) return res.status(400).json({ error: 'org_id is required' });

    const {
      user_name, user_phone, user_alt_phone = null, user_email = null,
      assigned_user_id, department = null, division = null,
      booking_date, booking_time = null, token_no = null,
      prefer_video = 0, notes = null
    } = req.body || {};

    if (!user_name || !user_phone || !booking_date) return res.status(400).json({ error: 'user_name, user_phone and booking_date are required' });

    let finalAssignedUserId = assigned_user_id || null;
    if (finalAssignedUserId) {
      const assignedRows = await db.query('SELECT id, org_id, is_active, role FROM users WHERE id = ? LIMIT 1', [finalAssignedUserId]);
      if (!assignedRows || assignedRows.length === 0) return res.status(400).json({ error: 'assigned_user_id not found' });
      const a = assignedRows[0];
      if (parseInt(a.org_id, 10) !== parseInt(org_id, 10)) return res.status(400).json({ error: 'assigned_user_id does not belong to the organization' });
      if (!a.is_active) return res.status(400).json({ error: 'assigned user is not active' });
    } else {
      const pick = await db.query('SELECT id FROM users WHERE org_id = ? AND role = ? AND is_active = 1 LIMIT 1', [org_id, 'assigned']);
      if (!pick || pick.length === 0) return res.status(400).json({ error: 'No assigned users available for this organization.' });
      finalAssignedUserId = pick[0].id;
    }

    let finalToken = token_no;
    if (!finalToken) {
      const rows = await db.query('SELECT MAX(token_no) AS max_token FROM bookings WHERE assigned_user_id = ? AND booking_date = ?', [finalAssignedUserId, booking_date]);
      const maxToken = (rows && rows[0] && rows[0].max_token) ? parseInt(rows[0].max_token, 10) : 0;
      finalToken = maxToken + 1;
    }

    const bookingNumber = `${org_id}-${Date.now()}`;
    const result = await db.query(
      `INSERT INTO bookings (org_id, assigned_user_id, user_name, user_phone, user_alt_phone, user_email,
         department, division, booking_date, booking_time, token_no, booking_number, prefer_video, notes, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [org_id, finalAssignedUserId, user_name, user_phone, user_alt_phone, user_email, department, division, booking_date, booking_time, finalToken, bookingNumber, prefer_video ? 1 : 0, notes, 'waiting']
    );

    const insertObj = Array.isArray(result) ? result[0] : result;
    const createdRows = await db.query('SELECT id, org_id, assigned_user_id, user_name, user_phone, user_email, token_no, booking_number, booking_date, booking_time, status FROM bookings WHERE id = ? LIMIT 1', [insertObj.insertId]);
    res.status(201).json({ ok: true, booking: createdRows[0] });
  } catch (err) {
    console.error('POST /bookings error', err);
    res.status(500).json({ error: 'server error', details: err.message });
  }
});

// Invite endpoint
app.post('/users/invite', requireAuth, async (req, res) => {
  try {
    if (!['admin','organization_admin'].includes(req.user.role)) return res.status(403).json({ ok:false, error:"Not allowed" });

    const { name, email, department = null, role = 'assigned', org_id } = req.body || {};
    if (!name || !email) return res.status(400).json({ error:"name & email required" });

    const finalOrgId = org_id || req.user.org_id || null;
    if (!finalOrgId) return res.status(400).json({ error: 'org_id required when inviting user' });

    const exists = await db.query('SELECT id FROM users WHERE email=? LIMIT 1', [email]);
    if (exists && exists.length) return res.status(400).json({ error:"email already exists" });

    const token = Math.random().toString(36).substring(2, 15);
    const expiry = new Date(Date.now() + 24*60*60*1000);

    const insert = await db.query("INSERT INTO users (name,email,role,department,org_id,is_active,reset_token,reset_token_expiry,created_at) VALUES (?,?,?,?,?,?,?,?,NOW())",
      [name, email, role || 'assigned', department || null, finalOrgId, 1, token, expiry]);
    const insertObj = Array.isArray(insert) ? insert[0] : insert;
    const userId = insertObj.insertId || null;

    const link = `${process.env.APP_URL || 'http://localhost:8080'}/set-password.html?token=${token}`;
    const mailOptions = { from: process.env.EMAIL_USER, to: email, subject: "EasyQue - Set your password", html: `<p>Hello ${name},</p><p>Click here to set your password: <a href="${link}">${link}</a></p>` };

    try {
      await transporter.sendMail(mailOptions);
      return res.json({ ok:true, msg:"Invite sent to " + email, userId });
    } catch (mailErr) {
      console.error('Mail send failed:', mailErr && mailErr.message ? mailErr.message : mailErr);
      return res.json({ ok:true, msg:"Invite email failed - use link printed", link, userId });
    }
  } catch (err) {
    console.error('POST /users/invite error', err);
    res.status(500).json({ ok:false, error:"Invite failed", details: err.message });
  }
});

// Set password endpoint
app.post('/users/set-password', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error:"token and password required" });

    const rows = await db.query("SELECT id FROM users WHERE reset_token=? AND reset_token_expiry > NOW() LIMIT 1", [token]);
    if (!rows || !rows.length) return res.status(400).json({ error:"Invalid or expired token" });

    const hash = await bcrypt.hash(password, 10);
    await db.query("UPDATE users SET password=?, reset_token=NULL, reset_token_expiry=NULL WHERE id=?", [hash, rows[0].id]);

    res.json({ ok:true, msg:"Password set successfully" });
  } catch (err) {
    console.error('/users/set-password error', err);
    res.status(500).json({ ok:false, error:"Server error", details: err.message });
  }
});

// health
app.get('/health', async (req, res) => {
  try {
    const rows = await db.query('SELECT 1+1 AS ok');
    res.json({ ok: true, db: rows && rows[0] ? rows[0].ok : null, time: new Date().toISOString() });
  } catch (err) { res.status(500).json({ ok:false, error: err.message }); }
});

// CRON: expire unpaid trials (daily)
async function expireUnpaidTrials() {
  try {
    const trials = await db.query("SELECT id, user_id, org_id FROM signup_trials WHERE trial_expires_at < NOW() AND (payment_status IS NULL OR payment_status != 'paid')");
    if (!trials || trials.length === 0) return;
    for (const t of trials) {
      try {
        await db.query("UPDATE users SET status = 'trial_expired', updated_at = NOW() WHERE id = ?", [t.user_id]);
        await db.query("UPDATE signup_trials SET payment_status = COALESCE(payment_status, 'pending'), updated_at = NOW() WHERE id = ?", [t.id]);
      } catch (inner) { console.error('Error processing trial', t, inner); }
    }
  } catch (err) { console.error('expireUnpaidTrials error', err); }
}

try {
  const schedule = process.env.BILLING_CRON_SCHEDULE || '0 2 * * *';
  cron.schedule(schedule, () => expireUnpaidTrials().catch(e => console.error('cron error', e)));
  console.log('Billing cron scheduled at', process.env.BILLING_CRON_SCHEDULE || '0 2 * * *');
} catch (err) { console.warn('Failed to schedule cron:', err && err.message ? err.message : err); }

app.listen(PORT, () => {
  console.log(`✅ EasyQue backend running on http://localhost:${PORT}`);
});
