// index.js (robust startup using http.createServer and pre-listen error handling)
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

// Serve uploads statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health check
app.get('/', (req, res) => res.json({ ok: true, message: 'EasyQue Backend Running' }));

// safe require helper
function safeRequire(p) {
  try {
    return require(p);
  } catch (err) {
    console.warn(`⚠️ Could not load ${p}:`, err.message);
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

// Basic error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ ok: false, error: 'server_error', details: err.message });
});

(async () => {
  try {
    await initDb();

    const preferred = parseInt(process.env.PORT || config.port || 4000, 10) || 4000;
    const maxAttempts = 10;
    let portToTry = preferred;
    let server = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // create a fresh server for each attempt
      server = http.createServer(app);

      // attach error handler BEFORE listen
      let bindError = null;
      const onError = (err) => {
        bindError = err;
      };
      server.once('error', onError);

      // Attempt to listen (this will trigger 'error' event instead of crashing)
      await new Promise((resolve) => {
        server.listen(portToTry, () => {
          // remove the temporary error listener if successful
          server.removeListener('error', onError);
          bindError = null;
          resolve();
        });
        // give short time for error event to fire, then resolve (error is captured in bindError)
        setTimeout(resolve, 200);
      });

      if (bindError) {
        // handle EADDRINUSE specially
        if (bindError.code === 'EADDRINUSE') {
          console.warn(`Port ${portToTry} is in use. Trying ${portToTry + 1}...`);
          try { server.close(); } catch(e) {}
          portToTry += 1;
          continue; // next attempt
        } else {
          // unexpected bind error
          console.error('Bind error:', bindError);
          process.exit(1);
        }
      } else {
        // success — server is listening
        const address = server.address();
        const actualPort = (address && address.port) ? address.port : portToTry;
        console.log(`🚀 EasyQue backend running at http://localhost:${actualPort}`);
        if (actualPort !== preferred) {
          console.warn(`(Note: preferred port ${preferred} was busy — using ${actualPort} instead)`);
        }

        // graceful shutdown handlers
        const shutdown = () => {
          console.log('Shutting down server...');
          server.close(() => process.exit(0));
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        // keep running — break out of loop
        return;
      }
    }

    console.error(`Could not bind to any port in range ${preferred}..${preferred + maxAttempts - 1}.`);
    process.exit(1);

  } catch (err) {
    console.error('Initialization error:', err);
    process.exit(1);
  }
})();
