// index.js — EasyQue Backend Entry
// - Strict port binding
// - Initializes DB
// - Mounts all routes
// - Serves /public and /uploads
// - Graceful shutdown

require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');
const { initDb } = require('./db');

const app = express();

// ==== MIDDLEWARE ====
app.use(cors());
app.use(bodyParser.json({ limit: '8mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// ==== STATIC ASSETS ====
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/public', express.static(path.join(__dirname, 'public')));

// ==== HEALTH ====
app.get('/health', (req, res) => res.json({ ok: true }));

// ==== ROUTES ====
app.use('/bookings', require('./routes/bookings'));
app.use('/orgs', require('./routes/orgs'));
app.use('/live', require('./routes/live'));
app.use('/admin', require('./routes/admin'));        // if present
app.use('/billing', require('./routes/billing'));    // if present
app.use('/notifications', require('./routes/notifications')); // if present

// Simple status page to test live stream quickly
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'status.html'));
});

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
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error('Initialization error:', err);
    process.exit(1);
  }
})();
