// index.js — EasyQue Backend Entry
// - Strict port binding (no auto-fallback)
// - Initializes DB
// - Mounts all routes
// - Serves /public and /uploads
// - Handles graceful shutdowns

const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');
const config = require('./config');
const { initDb } = require('./db');

const app = express();

// ==== MIDDLEWARE ====
app.use(cors());
app.use(bodyParser.json({ limit: '8mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// ==== STATIC ASSETS ====
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/public', express.static(path.join(__dirname, 'public')));

// ==== HEALTH CHECK ====
app.get('/', (req, res) =>
  res.json({ ok: true, message: 'EasyQue Backend Running' })
);

// ==== ROUTE LOADER (safe) ====
function safeRequire(p) {
  try {
    return require(p);
  } catch (err) {
    console.warn(`⚠️ Could not load ${p}: ${err.message}`);
    return null;
  }
}

// ==== ROUTES ====
const routes = {
  bookings: safeRequire('./routes/bookings'),
  orgs: safeRequire('./routes/orgs'),
  admin: safeRequire('./routes/admin'),
  billing: safeRequire('./routes/billing'),
  notifications: safeRequire('./routes/notifications'),
  live: safeRequire('./routes/live'),
  status: safeRequire('./routes/status'),
};

// Mount dynamically
for (const [name, router] of Object.entries(routes)) {
  if (router) app.use(`/${name}`, router);
}

// ==== ERROR HANDLER ====
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    ok: false,
    error: 'server_error',
    details: err.message || 'Unknown error',
  });
});

// ==== SERVER START ====
(async () => {
  try {
    await initDb();

    const port = parseInt(process.env.PORT || config.port || '5000', 10);
    const server = http.createServer(app);

    // Attach error handler BEFORE listen
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

    // Graceful shutdown
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

