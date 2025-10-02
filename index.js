// index.js — EasyQue backend (production-ready, ALL routes mounted)

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');

// Initialize DB early (adjust to your helper path)
require('./db'); // or require('./services/db') if that's your initializer

const app = express();
app.set('trust proxy', 1);

/* ----------------------------- global middleware ---------------------------- */
app.use(helmet());
app.use(morgan('combined'));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

/* ----------------------------- static: /uploads ----------------------------- */
const uploadsRoot = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsRoot)) fs.mkdirSync(uploadsRoot, { recursive: true });

app.use(
  '/uploads',
  express.static(uploadsRoot, {
    fallthrough: true,
    maxAge: '365d',
    setHeaders(res) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  })
);

/* ---------------------------------- health --------------------------------- */
app.get('/health', (_req, res) => res.status(200).send('OK'));

/* --------------------------------- ROUTES ---------------------------------- */
app.use('/auth', require('./routes/auth'));            // /auth/login, /auth/me

// Keep only the one(s) that exist in your repo:
try { app.use('/auth', require('./routes/auth_reset')); } catch {}
try { app.use('/auth', require('./routes/auth-refresh')); } catch {}

app.use('/users', require('./routes/users'));

app.use('/organizations', require('./routes/organizations')); // create/list/me/:id, items, uploads
app.use('/orgs', require('./routes/orgs'));                    // legacy/org utilities (breaks, etc.)

app.use('/bookings', require('./routes/bookings'));
app.use('/status', require('./routes/status'));
app.use('/reviews', require('./routes/reviews'));
app.use('/payments', require('./routes/payments'));
app.use('/admin', require('./routes/admin'));
app.use('/live', require('./routes/live'));
app.use('/notifications', require('./routes/notifications'));
app.use('/assigned-metrics', require('./routes/assigned_metrics'));
app.use('/billing', require('./routes/billing'));
app.use('/bookings-export', require('./routes/bookings_export'));
app.use('/signup', require('./routes/signup'));
app.use('/debug', require('./routes/debug'));
app.use('/webhooks', require('./routes/webhooks'));

/* ----------------------------------- 404 ----------------------------------- */
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found', details: `Cannot ${req.method} ${req.path}` });
});

/* ------------------------------- error handler ------------------------------ */
app.use((err, _req, res, _next) => {
  console.error('Uncaught error:', err);
  const status = err.statusCode || err.status || 500;
  const details = err.sqlMessage || err.message || 'server_error';
  res.status(status).json({ ok: false, error: 'server_error', details });
});

/* --------------------------------- start ----------------------------------- */
const PORT = process.env.PORT || 5008;
app.listen(PORT, () => {
  console.log(`EasyQue backend running on :${PORT}`);
});

module.exports = app;


