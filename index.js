// index.js — EasyQue backend entry
// - Robust router loader (handles module.exports, exports.router, or default export)
// - Serves /public and /uploads
// - CORS for localhost + your subdomains
// - Health endpoint
// - Auto-frees the port (Windows/macOS/Linux) if it's already in use, then retries

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);

// ---------- Middleware
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------- CORS
const CORS_ORIGINS = (process.env.CORS_ORIGINS ||
  'http://localhost:5008,https://api.easyque.org,https://status.easyque.org')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({ origin: CORS_ORIGINS, credentials: true }));

// ---------- Static
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ---------- Health
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ---------- Helper: safe route loader
function loadRouter(modulePath, name) {
  let mod;
  try {
    mod = require(modulePath);
  } catch (e) {
    console.warn(`⚠️  Route "${name}" not found at ${modulePath} (skipping).`);
    // Return a harmless handler so app keeps running
    return (_req, res) => res.status(501).json({ ok: false, error: `Route "${name}" not installed` });
  }
  const candidate =
    (typeof mod === 'function') ? mod :
    (mod && typeof mod.router === 'function') ? mod.router :
    (mod && typeof mod.default === 'function') ? mod.default :
    null;

  if (!candidate) {
    console.error(`⚠️  Route "${name}" misconfigured. Export a router function. Got:`, mod && Object.keys(mod));
    return (_req, res) => res.status(500).json({ ok: false, error: `Route "${name}" misconfigured` });
  }
  return candidate;
}

// ---------- Routes
app.use('/auth',        loadRouter('./routes/auth', 'auth'));
app.use('/users',       loadRouter('./routes/users', 'users'));
app.use('/bookings',    loadRouter('./routes/bookings', 'bookings'));
app.use('/orgs',        loadRouter('./routes/orgs', 'orgs'));

// Some repos also have /organizations (legacy name)
app.use('/organizations', loadRouter('./routes/organizations', 'organizations'));

// Payments / Billing (present in your repo)
app.use('/payments',    loadRouter('./routes/payments', 'payments'));
app.use('/billing',     loadRouter('./routes/billing', 'billing'));

// New routes we added for live status + reviews
app.use('/status',      loadRouter('./routes/status', 'status'));
app.use('/reviews',     loadRouter('./routes/reviews', 'reviews'));

// Root -> login page
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

  // Windows kills all PIDs bound to the port; *nix uses lsof
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
        server.listen(PORT, () => {
          console.log(`EasyQue backend running on http://localhost:${PORT}`);
        });
      }, 1200);
    }
  });
}

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    freePortAndRetry();
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});

// Start daily billing scheduler (02:00 run)
try { require('./services/billingScheduler').start(); } catch { console.warn('BillingScheduler not started'); }


server.listen(PORT, () => {
  console.log(`EasyQue backend running on http://localhost:${PORT}`);
});

