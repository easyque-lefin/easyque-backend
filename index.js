// index.js — strict port binding (no auto-fallback) + mounts all routes + serves /public and /uploads

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

// Static assets
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/public', express.static(path.join(__dirname, 'public')));

// Health
app.get('/', (req, res) => res.json({ ok: true, message: 'EasyQue Backend Running' }));

function safeRequire(p) {
  try { return require(p); }
  catch (err) { console.warn(`⚠️ Could not load ${p}: ${err.message}`); return null; }
}

// Routes
const bookingsRouter = safeRequire('./routes/bookings');
const orgsRouter = safeRequire('./routes/orgs');
const adminRouter = safeRequire('./routes/admin');
const billingRouter = safeRequire('./routes/billing');
const notificationsRouter = safeRequire('./routes/notifications');
const liveRouter = safeRequire('./routes/live');
const statusRouter = safeRequire('./routes/status');

if (bookingsRouter) app.use('/bookings', bookingsRouter);
if (orgsRouter) app.use('/orgs', orgsRouter);
if (adminRouter) app.use('/admin', adminRouter);
if (billingRouter) app.use('/billing', billingRouter);
if (notificationsRouter) app.use('/notifications', notificationsRouter);
if (liveRouter) app.use('/live', liveRouter);
if (statusRouter) app.use('/status', statusRouter);

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ ok: false, error: 'server_error', details: err.message });
});

(async () => {
  try {
    await initDb();

    const port = parseInt(process.env.PORT || config.port || '5000', 10);

    const server = http.createServer(app);

    // Attach error handler BEFORE listen to capture EADDRINUSE and show a friendly message
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${port} is already in use.`);
        console.error('To free it on Windows:');
        console.error(`  netstat -ano | findstr :${port}`);
        console.error('  taskkill /PID <PID> /F');
        process.exit(1);
      } else {
        console.error('Server bind error:', err);
        process.exit(1);
      }
    });

    server.listen(port, () => {
      console.log(`🚀 EasyQue backend running at http://localhost:${port}`);
    });

    const shutdown = () => {
      console.log('Shutting down...');
      server.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (err) {
    console.error('Initialization error:', err);
    process.exit(1);
  }
})();

