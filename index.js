// index.js - robust startup with port fallback + public status page mounting
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');
const config = require('./config');
const { initDb } = require('./db');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '8mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// Serve uploads statically (for org banner images)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Serve public assets (status page HTML/JS/CSS)
app.use('/public', express.static(path.join(__dirname, 'public')));

// Health check
app.get('/', (req, res) => res.json({ ok: true, message: 'EasyQue Backend Running' }));

// Safe require helper (doesn’t crash if route file missing)
function safeRequire(p) {
  try { return require(p); }
  catch (err) { console.warn(`⚠️ Could not load ${p}:`, err.message); return null; }
}

// Routers
const bookingsRouter = safeRequire('./routes/bookings');
const orgsRouter = safeRequire('./routes/orgs');
const adminRouter = safeRequire('./routes/admin');
const billingRouter = safeRequire('./routes/billing');
const notificationsRouter = safeRequire('./routes/notifications');
const liveRouter = safeRequire('./routes/live');
const statusRouter = safeRequire('./routes/status'); // ⬅️ NEW

if (bookingsRouter) app.use('/bookings', bookingsRouter);
if (orgsRouter) app.use('/orgs', orgsRouter);
if (adminRouter) app.use('/admin', adminRouter);
if (billingRouter) app.use('/billing', billingRouter);
if (notificationsRouter) app.use('/notifications', notificationsRouter);
if (liveRouter) app.use('/live', liveRouter);
if (statusRouter) app.use('/status', statusRouter); // ⬅️ NEW

// Last-resort error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ ok: false, error: 'server_error', details: err.message });
});

(async () => {
  try {
    await initDb();

    const preferred = parseInt(process.env.PORT || process.env.port || config.port || 4000, 10) || 4000;
    const maxAttempts = 10;
    let portToTry = preferred;
    let server;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      server = http.createServer(app);

      let bindError = null;
      const onError = (err) => { bindError = err; };
      server.once('error', onError);

      await new Promise((resolve) => {
        server.listen(portToTry, () => {
          server.removeListener('error', onError);
          bindError = null;
          resolve();
        });
        setTimeout(resolve, 200);
      });

      if (bindError) {
        if (bindError.code === 'EADDRINUSE') {
          console.warn(`Port ${portToTry} in use — trying ${portToTry + 1}...`);
          try { server.close(); } catch (_) {}
          portToTry += 1;
          continue;
        } else {
          console.error('Failed to start server:', bindError);
          process.exit(1);
        }
      } else {
        const addr = server.address();
        const actualPort = (addr && addr.port) ? addr.port : portToTry;
        console.log(`🚀 EasyQue backend running at http://localhost:${actualPort}`);
        if (actualPort !== preferred) {
          console.warn(`(Note: preferred port ${preferred} was busy — using ${actualPort} instead)`);
        }
        // graceful shutdown
        const shutdown = () => { console.log('Shutting down...'); server.close(() => process.exit(0)); };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        return;
      }
    }

    console.error(`Could not bind any port in range ${preferred}..${preferred + maxAttempts - 1}`);
    process.exit(1);

  } catch (err) {
    console.error('Initialization error:', err);
    process.exit(1);
  }
})();
