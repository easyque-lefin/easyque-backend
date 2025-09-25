const express = require('express');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');
const config = require('./config');
const { initDb } = require('./db');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// Health check
app.get('/', (req, res) => res.json({ ok: true, message: 'EasyQue Backend Running' }));

// Safe require helper
function safeRequire(path) {
  try {
    return require(path);
  } catch (err) {
    console.warn(`⚠️ Could not load ${path}:`, err.message);
    return null;
  }
}

// Routers
const bookingsRouter = safeRequire('./routes/bookings');
const orgsRouter = safeRequire('./routes/orgs');
const adminRouter = safeRequire('./routes/admin');
const billingRouter = safeRequire('./routes/billing');
const notificationsRouter = safeRequire('./routes/notifications');
const liveRouter = safeRequire('./routes/live');

if (bookingsRouter) app.use('/bookings', bookingsRouter);
if (orgsRouter) app.use('/orgs', orgsRouter);
if (adminRouter) app.use('/admin', adminRouter);
if (billingRouter) app.use('/billing', billingRouter);
if (notificationsRouter) app.use('/notifications', notificationsRouter);
if (liveRouter) app.use('/live', liveRouter);

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ ok: false, error: 'server_error', details: err.message });
});

// Start server
(async () => {
  try {
    await initDb();
    app.listen(config.port, () => {
      console.log(`🚀 EasyQue backend running at http://localhost:${config.port}`);
    });
  } catch (err) {
    console.error('Failed to init DB:', err);
    process.exit(1);
  }
})();

