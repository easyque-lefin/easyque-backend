// index.js — mounts all routes, strict port, static /public + /uploads, CORS, JWT parsing where needed

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const app = express();
const server = http.createServer(app);

// --- Core middleware
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// CORS: allow both your api + status subdomains during dev/tunnel
const CORS_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5008,https://api.easyque.org,https://status.easyque.org')
  .split(',').map(s => s.trim());
app.use(cors({ origin: CORS_ORIGINS, credentials: true }));

// Static
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// --- DB helper (already in your project; keeping simple here)
const db = require('./services/db'); // ensure this exports db.query

// --- Live bus / SSE (already present in your project)
// const liveBus = require('./services/liveBus');

// --- Routes (core)
app.use('/auth', require('./routes/auth'));
app.use('/users', require('./routes/users'));
app.use('/bookings', require('./routes/bookings'));
app.use('/orgs', require('./routes/orgs'));               // your existing orgs route
app.use('/organizations', require('./routes/organizations')); // ✅ mount so UI calls work
app.use('/payments', require('./routes/payments'));
app.use('/billing', require('./routes/billing'));

// --- New/Updated routes in this delivery
app.use('/status', require('./routes/status'));   // ✅ returns { org, booking, metrics }
app.use('/reviews', require('./routes/reviews')); // ✅ internal reviews system

// --- Fallback: serve minimal index or 404
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('ERR', err);
  res.status(err.status || 500).json({ ok: false, error: err.message || 'Server error' });
});

const PORT = Number(process.env.PORT || 5008);
server.listen(PORT, () => {
  console.log(`EasyQue backend running on http://localhost:${PORT}`);
});

