// config.js (hardened)
require('dotenv').config();

function must(name) {
  const val = process.env[name];
  if (!val && process.env.NODE_ENV === 'production') {
    throw new Error(`Missing required env: ${name}`);
  }
  return val;
}

const NODE_ENV = process.env.NODE_ENV || 'development';

module.exports = {
  env: NODE_ENV,
  port: Number(process.env.PORT || 4000),
  db: {
    host: must('DB_HOST') || 'localhost',
    user: must('DB_USER') || 'root',
    password: must('DB_PASSWORD') || '',
    database: must('DB_NAME') || 'easyque',
    port: Number(process.env.DB_PORT || 3306)
  },
  jwtSecret: must('JWT_SECRET') || 'dev-only',
  liveBaseUrl: process.env.LIVE_BASE_URL || 'https://status.easyque.org/status.html',

  razorpay: {
    keyId: must('RAZORPAY_KEY_ID') || 'rzp_test_xxxxx',
    keySecret: must('RAZORPAY_KEY_SECRET') || 'xxxxx',
    webhookSecret: must('RAZORPAY_WEBHOOK_SECRET') || 'xxxxx'
  },

  messaging: {
    provider: process.env.MSG_PROVIDER || 'manual', // manual | twilio | 360dialog | sms
    apiKey: process.env.MSG_API_KEY || '',
    senderId: process.env.MSG_SENDER_ID || ''
  },

  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
};
