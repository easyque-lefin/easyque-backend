// index.js — EasyQue backend (production-ready)
// - Normalized route mounts
// - Security, logging, CORS
// - Static /uploads served by Express (works with or without Caddy)
// - Centralized 404 + error handling

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');

// DB helper should export a `query(sql, params)` promise function
const db = require('./db');

// Ensure uploads dir exists (Express static + Multer in routes/users.js)
const uploadsRoot = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsRoot)) fs.mkdirSync(uploadsRoot, { recursive: true });

const app = express();

// ---------- Middlewares ----------
app.use(helmet());                         // security headers
app.use(morgan('combined'));               // access log
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));   // JSON bodies
app.use(express.urlencoded({ extended: true }));

// Serve static uploads. With Caddy in front, Caddy can serve them too.
// Keeping this ensures localhost:5008/uploads/... also works.
app.use('/uploads', express.static(uploadsRoot, {
  fallthrough: true,
  maxAge: '365d',
  setHeaders(res) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));

// ---------- Health (plain text OK) ----------
app.get('/health', (_req, res) => res.status(200).send('OK'));

// ---------- Routes ----------
app.use('/users', require('./routes/users'));          // list/create users, edit me, upload photo
app.use('/auth', require('./routes/auth_reset'));      // password reset (normalized below)

// ---------- 404 ----------
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found', details: `Cannot ${req.method} ${req.path}` });
});

// ---------- Error handler ----------
/* eslint no-unused-vars: "off" */
app.use((err, _req, res, _next) => {
  console.error('Uncaught error:', err);
  const status = err.statusCode || err.status || 500;
  const details = err.sqlMessage || err.message || 'server_error';
  res.status(status).json({ ok: false, error: 'server_error', details });
});

// ---------- Start ----------
const PORT = process.env.PORT || 5008;
app.listen(PORT, () => {
  console.log(`EasyQue backend running on :${PORT}`);
});

module.exports = app;

