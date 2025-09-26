// index.js — EasyQue Backend Entry
// - Strict port binding (0.0.0.0)
// - Initializes DB
// - Mounts all routes (bookings, orgs, users, status, live/SSE)
// - Serves /public and /uploads
// - Graceful shutdown + basic error handler

require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');

const { initDb } = require('./db');

const app = express();

/* --------------------------- Middleware --------------------------- */
app.use(cors());
app.use(bodyParser.json({ limit: '8mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

/* --------------------------- Static files ------------------------- */
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/public', express.static(path.join(__dirname, 'public')));

/* --------------------------- Health ------------------------------- */

app.get('/health', (_req, res) => res.json({ ok: true }));

/* --------------------------- status ------------------------------- */

app.use('/status', require('./routes/status'));
/* --------------------------- reviews ------------------------------- */

app.use('/reviews', require('./routes/reviews'));


/* -------- helper: require route only if the file actually exists --- */
function useIfExists(mountPath, relModulePath) {
  try {
    // Resolve throws if module does not exist
    const resolved = require.resolve(relModulePath);
    // eslint-disable-next-line global-require, import/no-dynamic-require
    app.use(mountPath, require(resolved));
    console.log(`[routes] mounted ${mountPath} -> ${relModulePath}`);
  } catch {
    console.log(`[routes] skipped ${mountPath} (missing: ${relModulePath})`);
  }
}

/* --------------------------- Routes ------------------------------- */
// Core routes (present)
app.use('/bookings', require('./routes/bookings'));
app.use('/orgs', require('./routes/orgs'));
app.use('/users', require('./routes/users'));
app.use('/status', require('./routes/status'));
app.use('/live', require('./routes/live')); // Server-Sent Events stream

// Optional routes (mount only if files exist)
useIfExists('/admin', './routes/admin');
useIfExists('/billing', './routes/billing');
useIfExists('/notifications', './routes/notifications');

/* --------- Root: quick status page (opens /public/status.html) ---- */
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'status.html'));
});

/* --------------------------- 404 fallback ------------------------- */
app.use((req, res, _next) => {
  res.status(404).json({ ok: false, error: 'not_found', path: req.path });
});

/* --------------------------- Error handler ------------------------ */
app.use((err, _req, res, _next) => {
  // Avoid leaking internals in production
  const status = err.status || err.statusCode || 500;
  console.error('Error:', err);
  res.status(status).json({
    ok: false,
    error: err.code || err.name || 'internal_error',
    message: process.env.NODE_ENV === 'production' ? 'Internal Server Error' : (err.message || 'Error'),
  });
});

/* --------------------------- Bootstrap --------------------------- */
(async () => {
  try {
    await initDb();

    const PORT = parseInt(process.env.PORT || '5008', 10);
    const server = http.createServer(app);

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`EasyQue backend listening on :${PORT}`);
    });

    // Graceful shutdown
    const shutdown = () => {
      console.log('Shutting down...');
      server.close(() => process.exit(0));
      // If not closed in 10s, force-exit
      setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error('Initialization error:', err);
    process.exit(1);
  }
})();

