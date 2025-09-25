require('dotenv').config();

module.exports = {
  port: process.env.PORT || 4000,
  db: {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'easyque',
    port: process.env.DB_PORT || 3306
  },
  jwtSecret: process.env.JWT_SECRET || 'supersecretkey',
  liveBaseUrl: process.env.LIVE_BASE_URL || 'https://live.easyque.app',

  // Razorpay config
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_xxxxx',
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || 'xxxxx',

  // Messaging provider config (Twilio, 360dialog, or SMS gateway)
  messaging: {
    provider: process.env.MSG_PROVIDER || 'manual', // manual | twilio | 360dialog | sms
    apiKey: process.env.MSG_API_KEY || '',
    senderId: process.env.MSG_SENDER_ID || ''
  }
};
