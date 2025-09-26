// index.js — robust route loader + mounts + static + CORS

require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// -------- middleware
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS
const CORS_ORIGINS = (process.env.CORS_ORIGINS ||
  'http://localhost:5008,https://api.easyque.org,https://status.easyque.org')
  .split(',').map(s => s.trim());
app.use(cors({ origin: CORS_ORIGINS, credentials: true }));

// Static
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// -------- helper: safely unwrap different export styles
function loadRouter(modulePath, name) {
  let mod = require(modulePath);
  // unwrap ESM default export or named .router
  const candidate = (typeof mod === 'function') ? mod : (mod?.router || mod?.default);
  if (typeof candidate !== 'function') {
    console.error(`⚠️  Route "${name}" did not export an Express router. Got:`,
      typeof mod, mod && Object.keys(mod));
    // return a harmless middleware that surfaces the issue
    return (req, res) => res.status(500).json({ ok: false, error: `Route "${name}" misconfigured` });
  }
  return candidate;
}

// -------- routes
app.use('/auth',        loadRouter('./routes/auth', 'auth'));
app.use('/users',       loadRouter('./routes/users', 'users'));
app.use('/bookings',    loadRouter('./routes/bookings', 'bookings'));
app.use('/orgs',        loadRouter('./routes/orgs', 'orgs'));

// If your repo has routes/organizations.js, keep this; otherwise comment it out.
try { app.use('/organizations', loadRouter('./routes/organizations', 'organizations')); }
catch { /* not present in some repos; safe to ignore */ }

app.use('/payments',    loadRouter('./routes/payments', 'payments'));

// Some repos have billing as an object export; loader above handles it.
// If you don’t have routes/billing.js, it’ll log a warning but continue.
try { app.use('/billing', loadRouter('./routes/billing', 'billing')); } catch {}

app.use('/status',      loadRouter('./routes/status', 'status'));
app.use('/reviews',     loadRouter('./routes/reviews', 'reviews'));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('ERR', err);
  res.status(err.status || 500).json({ ok: false, error: err.message || 'Server error' });
});

const PORT = Number(process.env.PORT || 5008);

const PORT = Number(process.env.PORT || 5008);

// If the port is in use, kill the old process and retry
server.on('error', async (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n⚠️ Port ${PORT} is already in use. Trying to free it...`);

    // Windows-specific command to kill process on that port
    const { exec } = require('child_process');
    exec(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :${PORT}') do taskkill /F /PID %a`,
      (error, stdout, stderr) => {
        if (error) {
          console.error(`Could not free port ${PORT}:`, error.message);
          process.exit(1);
        } else {
          console.log(`✅ Freed port ${PORT}, restarting...`);
          setTimeout(() => {
            server.listen(PORT, () => {
              console.log(`EasyQue backend running on http://localhost:${PORT}`);
            });
          }, 1500);
        }
      });
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});



server.listen(PORT, () => {
  console.log(`EasyQue backend running on http://localhost:${PORT}`);
});
