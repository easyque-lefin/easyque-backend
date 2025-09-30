// index.js — EasyQue backend (production-ready, ALL routes mounted)

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');

// Keep your existing db helper; some routes use ./db, others use ./services/db.
// Requiring it here also helps catch env issues early.
require('./db');

const app = express();

/* ----------------------------- global middleware ---------------------------- */
app.use(helmet());
app.use(morgan('combined'));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

/* ----------------------------- static: /uploads ----------------------------- */
const uploadsRoot = path.join(process.cwd(), 'uploads');
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
/** Auth & users */
app.use('/auth', require('./routes/auth'));            // /auth/login, /auth/me
app.use('/auth', require('./routes/auth_reset'));      // /auth/request-reset, /auth/confirm-reset
app.use('/auth', require('./routes/auth-refresh'));    // /auth/refresh, /auth/logout
app.use('/users', require('./routes/users'));

/** Organizations / org operations */
app.use('/organizations', require('./routes/organizations')); // GET /organizations/:id, items, etc.
app.use('/orgs', require('./routes/orgs'));                    // org utilities (banner, breaks, etc.)

/** Core business flows */
app.use('/bookings', require('./routes/bookings'));
app.use('/status', require('./routes/status'));
app.use('/reviews', require('./routes/reviews'));
app.use('/payments', require('./routes/payments'));

/** Admin, live, notifications, metrics, billing */
app.use('/admin', require('./routes/admin'));
app.use('/live', require('./routes/live'));
app.use('/notifications', require('./routes/notifications'));
app.use('/assigned-metrics', require('./routes/assigned_metrics'));
app.use('/billing', require('./routes/billing'));

/** Exports, signup, debug, webhooks */
app.use('/bookings-export', require('./routes/bookings_export'));
app.use('/signup', require('./routes/signup'));
app.use('/debug', require('./routes/debug'));
app.use('/webhooks', require('./routes/webhooks'));

/* ----------------------------------- 404 ----------------------------------- */
app.use((req, res) => {
  res
    .status(404)
    .json({ ok: false, error: 'not_found', details: `Cannot ${req.method} ${req.path}` });
});

/* ------------------------------- error handler ------------------------------ */
/* eslint no-unused-vars: "off" */
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

