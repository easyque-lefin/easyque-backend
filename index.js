// index.js (hardened entry)
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const config = require('./config');

const app = express();
const server = http.createServer(app);

// Security & logging
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan('combined'));

// CORS
const corsOrigins = config.corsOrigins.length ? config.corsOrigins : [/\.easyque\.org$/, 'http://localhost:5173'];
app.use(cors({ origin: corsOrigins, credentials: true }));

// Raw body for Razorpay webhooks BEFORE json parser
app.use('/webhooks/razorpay', express.raw({ type: '*/*', limit: '2mb' }));

// JSON/body parsers
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Static
app.use('/public', express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { maxAge: '1h', etag: true }));

// Routes
app.use('/auth', require('./routes/auth'));
app.use('/auth', require('./routes/auth_reset'));
app.use('/users', require('./routes/users'));
app.use('/organizations', require('./routes/organizations'));
app.use('/bookings', require('./routes/bookings'));
app.use('/status', require('./routes/status'));
app.use('/reviews', require('./routes/reviews'));
app.use('/payments', require('./routes/payments'));
app.use('/admin', require('./routes/admin'));
app.use('/webhooks', require('./routes/webhooks'));
app.use('/assigned-metrics', require('./routes/assigned_metrics'));

// Health
app.get('/health', (req,res)=>res.json({ ok:true, env: config.env }));

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok:false, error:'server_error', details: err?.message });
});

const PORT = config.port;
server.listen(PORT, () => console.log(`EasyQue backend running on :${PORT}`));

