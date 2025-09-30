// index.js — EasyQue backend (production-ready, with /auth/login restored)

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');

const db = require('./db'); // keep your existing db helper

// Ensure uploads directory exists
const uploadsRoot = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsRoot)) fs.mkdirSync(uploadsRoot, { recursive: true });

const app = express();

/* ---------------------------- global middlewares ---------------------------- */
app.use(helmet());
app.use(morgan('combined'));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve /uploads from Node as well (Caddy also serves it)
app.use('/uploads', express.static(uploadsRoot, {
  fallthrough: true,
  maxAge: '365d',
  setHeaders(res) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));

/* ---------------------------------- health --------------------------------- */
app.get('/health', (_req, res) => res.status(200).send('OK'));

/* --------------------------------- routes ---------------------------------- */
// IMPORTANT: mount your original auth routes so /auth/login works again
// (keep the filename that already exists in your project)
app.use('/auth', require('./routes/auth'));          // <-- contains POST /auth/login, etc.

// Password reset routes (normalized: /auth/request-reset, /auth/confirm-reset)
app.use('/auth', require('./routes/auth_reset'));

// Users (list/create, edit me, upload photo)
app.use('/users', require('./routes/users'));

/* ----------------------------------- 404 ----------------------------------- */
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found', details: `Cannot ${req.method} ${req.path}` });
});

/* ------------------------------- error handler ------------------------------ */
/* eslint no-unused-vars: "off" */
app.use((err, _req, res, _next) => {
  console.error('Uncaught error:', err);
  const status = err.statusCode || err.status || 500;
  const details = err.sqlMessage || err.message || 'server_error';
  res.status(status).json({ ok: false, error: 'server_error', details });
});

/* --------------------------------- startup --------------------------------- */
const PORT = process.env.PORT || 5008;
app.listen(PORT, () => {
  console.log(`EasyQue backend running on :${PORT}`);
});

module.exports = app;

