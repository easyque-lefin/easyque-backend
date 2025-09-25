// routes/bookings.js
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');

// live publisher (SSE)
let live;
try { live = require('./live'); } catch(e) { live = null; }

const router = express.Router();

/**
 * Helper: generate queue code
 */
function genQueueCode() {
  return crypto.randomBytes(8).toString('hex'); // 16 hex chars
}

/**
 * Create booking
 * Body: { org_id, user_name, user_phone, user_email, department, booking_date, booking_time, assigned_user_id, prefer_channel }
 */
router.post('/', async (req, res) => {
  try {
    const {
      org_id, user_name, user_phone, user_email, department,
      booking_date, booking_time, assigned_user_id, prefer_channel
    } = req.body;

    if (!org_id || !user_name || !user_phone || !booking_date) {
      return res.status(400).json({ ok: false, error: 'org_id,user_name,user_phone,booking_date required' });
    }

    // enforce booking limit per org per day
    const subs = await db.query('SELECT booking_limit_daily FROM org_subscriptions WHERE org_id = ? ORDER BY id DESC LIMIT 1', [org_id]);
    const limit = subs && subs[0] ? subs[0].booking_limit_daily : null;
    if (limit) {
      const cntRow = await db.query('SELECT COUNT(*) AS cnt FROM bookings WHERE org_id = ? AND booking_date = ? AND status <> "cancelled"', [org_id, booking_date]);
      const cnt = cntRow && cntRow[0] ? cntRow[0].cnt : 0;
      if (cnt >= limit) {
        return res.status(403).json({ ok:false, error:'booking_limit_reached', message:'Your booking limit for today has been reached for this organization. Please contact support or upgrade plan.'});
      }
    }

    // compute next token for this org & date
    const maxRow = await db.query('SELECT MAX(token_no) AS max_token FROM bookings WHERE org_id = ? AND booking_date = ?', [org_id, booking_date]);
    const nextToken = (maxRow && maxRow[0] && maxRow[0].max_token) ? (maxRow[0].max_token + 1) : 1;

    // booking number & queue code
    const booking_number = 'BKG' + Date.now().toString(36).toUpperCase();
    const queue_code = genQueueCode();
    const status_link = `${config.liveBaseUrl}/status/${queue_code}`;

    // insert booking
    const insertSql = `INSERT INTO bookings (org_id, department, assigned_user_id, user_name, user_phone, user_email, booking_date, booking_time, token_no, booking_number, queue_code, status_link, status, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', NOW(), NOW())`;
    const params = [org_id, department||null, assigned_user_id||null, user_name, user_phone, user_email||null, booking_date, booking_time||null, nextToken, booking_number, queue_code, status_link];
    const r = await db.query(insertSql, params);

    // fetch created booking
    const created = await db.query('SELECT * FROM bookings WHERE id = ?', [r.insertId]);
    const booking = created[0];

    // insert a pending notification row
    const msg = `Hi ${user_name}, your booking is confirmed at token ${booking.token_no} on ${booking_date}. Track live: ${status_link}`;
    const channel = (prefer_channel === 'sms') ? 'sms' : 'whatsapp';
    await db.query('INSERT INTO notifications (booking_id, org_id, to_phone, to_email, channel, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, "pending", NOW())',
      [booking.id, org_id, user_phone, user_email||null, channel, msg]);

    // respond with booking and send links for manual sending
    const waText = encodeURIComponent(msg);
    const waWeb = `https://wa.me/?text=${waText}`;
    const waApp = `whatsapp://send?text=${waText}`;
    const smsText = msg;

    return res.json({ ok: true, booking, send_links: { whatsapp_web: waWeb, whatsapp_app: waApp, sms_text: smsText } });
  } catch (err) {
    console.error('POST /bookings error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

/**
 * GET /bookings/:id/send-link
 * Returns prebuilt send links (whatsapp / sms) and status link
 */
router.get('/:id/send-link', async (req, res) => {
  try {
    const id = req.params.id;
    const rows = await db.query('SELECT id, user_name, user_phone, booking_date, token_no, status_link FROM bookings WHERE id = ?', [id]);
    if (!rows || !rows[0]) return res.status(404).json({ ok:false, error:'not_found' });
    const b = rows[0];
    const text = `Hi ${b.user_name}, your booking (token ${b.token_no}) on ${b.booking_date} is confirmed. Track live: ${b.status_link}`;
    const waText = encodeURIComponent(text);
    const waUrlWeb = `https://wa.me/?text=${waText}`;
    const waUrlApp = `whatsapp://send?text=${waText}`;
    return res.json({ ok:true, booking_id: b.id, status_link: b.status_link, whatsapp_web: waUrlWeb, whatsapp_app: waUrlApp, sms_text: text });
  } catch (err) {
    console.error('GET /bookings/:id/send-link error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});


/**
 * POST /bookings/:id/serve
 * Marks booking as served; publishes org-level live update
 * Body: { served_by }
 */
router.post('/:id/serve', async (req, res) => {
  try {
    const id = req.params.id;
    const { served_by } = req.body;
    await db.query('UPDATE bookings SET status = "served", served_at = NOW(), served_by = ? WHERE id = ?', [served_by||null, id]);

    const booking = (await db.query('SELECT * FROM bookings WHERE id = ?', [id]))[0];
    if (!booking) return res.status(404).json({ ok:false, error:'not_found' });

    // compute current served token for the org & date
    const cur = await db.query("SELECT MAX(token_no) AS current_served FROM bookings WHERE org_id = ? AND booking_date = ? AND status = 'served'", [booking.org_id, booking.booking_date]);
    const current_served = cur && cur[0] && cur[0].current_served ? cur[0].current_served : null;

    // compute avg service time seconds
    const avg = await db.query("SELECT AVG(TIMESTAMPDIFF(SECOND, created_at, served_at)) AS avg_seconds FROM bookings WHERE org_id = ? AND DATE(served_at)=CURDATE() AND served_at IS NOT NULL", [booking.org_id]);
    const avg_seconds = avg && avg[0] && avg[0].avg_seconds ? Math.round(avg[0].avg_seconds) : null;

    // publish to SSE subscribers
    if (live && typeof live.publishOrgUpdate === 'function') {
      live.publishOrgUpdate(booking.org_id, { current_served, avg_seconds, updated_at: new Date().toISOString() });
    }

    return res.json({ ok:true, served_by, current_served, avg_seconds });
  } catch (err) {
    console.error('POST /bookings/:id/serve error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

/**
 * GET /bookings/export?org_id=...&from=YYYY-MM-DD&to=YYYY-MM-DD
 * Returns CSV of bookings
 */
router.get('/export', async (req, res) => {
  try {
    const { org_id, from, to } = req.query;
    if (!org_id) return res.status(400).json({ ok:false, error:'org_id_required' });

    const params = [org_id];
    let where = 'WHERE org_id = ?';
    if (from) {
      where += ' AND booking_date >= ?';
      params.push(from);
    }
    if (to) {
      where += ' AND booking_date <= ?';
      params.push(to);
    }

    const sql = `SELECT id, booking_number, token_no, user_name, user_phone, user_email, department, booking_date, booking_time, status, created_at, served_at FROM bookings ${where} ORDER BY booking_date, token_no ASC`;
    const rows = await db.query(sql, params);

    // CSV streaming
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="bookings_${org_id}_${from||'all'}.csv"`);

    // header
    res.write('id,booking_number,token_no,user_name,user_phone,user_email,department,booking_date,booking_time,status,created_at,served_at\n');
    for (const r of rows) {
      const line = [
        r.id, r.booking_number, r.token_no, `"${(r.user_name||'').replace(/"/g,'""')}"`, r.user_phone||'',
        `"${(r.user_email||'').replace(/"/g,'""')}"`, `"${(r.department||'').replace(/"/g,'""')}"`, r.booking_date||'',
        r.booking_time||'', r.status||'', r.created_at ? r.created_at.toISOString() : '', r.served_at ? r.served_at.toISOString() : ''
      ].join(',') + '\n';
      res.write(line);
    }
    res.end();
  } catch (err) {
    console.error('GET /bookings/export error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});


module.exports = router;

