// routes/status.js
// Public live page endpoints:
//  - GET /status/:queue_code           -> serves the HTML shell (public/status.html)
//  - GET /status/api/:queue_code       -> returns JSON: org/banner, booking, now serving, avg wait, SSE stream URL

const express = require('express');
const path = require('path');
const db = require('../db');

const router = express.Router();

// Serve the HTML shell; the shell JS will fetch /status/api/:queue_code
router.get('/:queue_code', async (req, res) => {
  try {
    const filePath = path.join(__dirname, '..', 'public', 'status.html');
    res.sendFile(filePath);
  } catch (err) {
    console.error('GET /status/:queue_code sendFile error', err);
    res.status(500).send('Server error');
  }
});

// JSON bootstrap for the shell
router.get('/api/:queue_code', async (req, res) => {
  try {
    const { queue_code } = req.params;

    const bookingRows = await db.query('SELECT * FROM bookings WHERE queue_code = ? LIMIT 1', [queue_code]);
    if (!bookingRows || !bookingRows[0]) {
      return res.status(404).json({ ok: false, error: 'not_found', message: 'Invalid or expired link.' });
    }
    const booking = bookingRows[0];

    // org info (for banner & name)
    let org = null;
    try {
      const orgRows = await db.query('SELECT id, name, banner_url FROM organizations WHERE id = ? LIMIT 1', [booking.org_id]);
      org = orgRows && orgRows[0] ? orgRows[0] : null;
    } catch (_) { /* ignore */ }

    // current served token for this org & date
    const cur = await db.query(
      "SELECT MAX(token_no) AS current_served FROM bookings WHERE org_id = ? AND booking_date = ? AND status = 'served'",
      [booking.org_id, booking.booking_date]
    );
    const current_served = cur && cur[0] && cur[0].current_served ? cur[0].current_served : 0;

    // avg service time today (seconds)
    const avg = await db.query(
      "SELECT AVG(TIMESTAMPDIFF(SECOND, created_at, served_at)) AS avg_seconds FROM bookings WHERE org_id = ? AND DATE(served_at)=CURDATE() AND served_at IS NOT NULL",
      [booking.org_id]
    );
    const avg_seconds = avg && avg[0] && avg[0].avg_seconds ? Math.round(avg[0].avg_seconds) : null;

    return res.json({
      ok: true,
      org: org ? { id: org.id, name: org.name, banner_url: org.banner_url || null } : null,
      booking: {
        id: booking.id,
        token_no: booking.token_no,
        booking_date: booking.booking_date,
        status: booking.status
      },
      now: {
        current_served,
        avg_seconds
      },
      stream_url: `/live/stream/${booking.org_id}`
    });
  } catch (err) {
    console.error('GET /status/api/:queue_code error', err);
    res.status(500).json({ ok: false, error: 'server_error', details: err.message });
  }
});

module.exports = router;
