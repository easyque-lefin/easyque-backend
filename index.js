// index.js — EasyQue backend entry (clean mount)

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);

// ---------- Body parsers
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------- CORS
const CORS_ORIGINS = (process.env.CORS_ORIGINS ||
  'http://localhost:5008,https://api.easyque.org,https://status.easyque.org')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: CORS_ORIGINS, credentials: true }));

// ---------- Static
app.use('/public',  express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ---------- Health
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ---------- Routes (direct require; all CJS)
app.use('/auth',          require('./routes/auth'));
app.use('/',              require('./routes/auth_reset'));          // /auth/request-reset, /auth/reset
app.use('/users',         require('./routes/users'));
app.use('/bookings',      require('./routes/bookings'));
app.use('/bookings',      require('./routes/bookings_export'));     // /bookings/export
app.use('/organizations', require('./routes/organizations'));
app.use('/payments',      require('./routes/payments'));
app.use('/billing',       require('./routes/billing'));             // if present in your project
app.use('/status',        require('./routes/status'));
app.use('/reviews',       require('./routes/reviews'));
app.use('/',              require('./routes/assigned_metrics'));    // /assigned-metrics/* (break/resume/today)
app.use('/webhooks',      require('./routes/webhooks'));            // Razorpay webhook

// Root → optional
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('ERR', err);
  res.status(err.status || 500).json({ ok: false, error: err.message || 'Server error' });
});

// ---------- Listen + auto free port logic
const PORT = Number(process.env.PORT || 5008);

function freePortAndRetry() {
  console.error(`\n⚠️  Port ${PORT} is in use. Trying to free it...`);
  const isWin = process.platform === 'win32';
  const cmdWin = `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${PORT}') do taskkill /F /PID %a`;
  const cmdNix = `pid=$(lsof -t -i:${PORT} -sTCP:LISTEN 2>/dev/null); if [ -n "$pid" ]; then kill -9 $pid; fi`;
  exec(isWin ? `cmd /c "${cmdWin}"` : cmdNix, (error, stdout, stderr) => {
    if (error) {
      console.error(`❌ Could not free port ${PORT}: ${error.message}`);
      process.exit(1);
    } else {
      if (stdout) console.log(stdout.trim());
      if (stderr) console.log(stderr.trim());
      console.log(`✅ Freed port ${PORT}. Restarting...`);
      setTimeout(() => {
        server.listen(PORT, '0.0.0.0', () => {
          console.log(`EasyQue backend running on http://localhost:${PORT}`);
        });
      }, 1200);
    }
  });
}

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') freePortAndRetry();
  else { console.error('Server error:', err); process.exit(1); }
});

// Start billing scheduler (02:00)
try { require('./services/billingScheduler').start(); } catch { console.warn('BillingScheduler not started'); }

server.listen(PORT, '0.0.0.0', () => {
  console.log(`EasyQue backend running on http://localhost:${PORT}`);
});

