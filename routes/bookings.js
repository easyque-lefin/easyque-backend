// routes/bookings.js
// Full route file for bookings: create booking, send-link, serve, export.
// Generates direct WhatsApp (web & app) links using phone number if available,
// and an SMS link. Inserts a pending notification row on booking creation.

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');

const router = express.Router();

// Try to load live SSE module (optional)
let live = null;
try {
  live = require('./live');
} catch (e) {
  live = null;
  console.warn('live SSE module not found or failed to load:', e.message);
}

/** Helper: generate a random queue code */
function genQueueCode() {
  return crypto.randomBytes(8).toString('hex'); // 16 hex chars
}

/** Helper: digits only phone sanitizer */
function digitsOnly(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const d = phone.replace(/\D/g, '');
  return d.length > 0 ? d : null;
}

/** Build whatsapp/sms links given phone and text */
function buildSendLinks(phone, text) {
  const textEnc = encodeURIComponent(text || '');
  // fallback generic web link (no recipient)
  let whatsapp_web = `https://wa.me/?text=${textEnc}`;
  let whatsapp_app = `whatsapp://send?text=${textEnc}`;
  let sms_link = `sms:?body=${textEnc}`;

  const phoneDigits = digitsOnly(phone);
  if (phoneDigits) {
    // desktop web.whatsapp chat to specific number
    whatsapp_web = `https://web.whatsapp.com/send?phone=${phoneDigits}&text=${textEnc}`;
    // also safe short link (commented alternative)
    // whatsapp_web = `https://wa.me/${phoneDigits}?text=${textEnc}`;

    // app deep link for mobile
    whatsapp_app = `whatsapp://send?phone=${phoneDigits}&text=${textEnc}`;

    // sms link
    sms_link = `sms:${phoneDigits}?body=${textEnc}`;
  }

  return { whatsapp_web, whatsapp_app, sms_link };
}

/**
 * POST /bookings
 * Body: { org_id, user_name, user_phone, user_email, department, booking_date, booking_time, assigned_user_id, prefer_channel }
 */
router.post('/', async (req, res) => {
  try {
    const {
      org_id, user_name, user_phone, user_email, department,
      booking_date, booking_time, assigned_user_id, prefer_channel
    } = req.body || {};

    if (!org_id || !user_name || !user_phone || !booking_date) {
      return res.status(400).json({ ok: false, error: 'org_id,user_name,user_phone,booking_date required' });
    }

    // enforce booking limit per org per day (if subscription exists)
    try {
      const subs = await db.query('SELECT booking_limit_daily FROM org_subscriptions WHERE org_id = ? ORDER BY id DESC LIMIT 1', [org_id]);
      const limit = subs && subs[0] ? subs[0].booking_limit_daily : null;
      if (limit) {
        const cntRow = await db.query('SELECT COUNT(*) AS cnt FROM bookings WHERE org_id = ? AND booking_date = ? AND status <> "cancelled"', [org_id, booking_date]);
        const cnt = cntRow && cntRow[0] ? cntRow[0].cnt : 0;
        if (cnt >= limit) {
          return res.status(403).json({
            ok: false,
            error: 'booking_limit_reached',
            message: 'Your booking limit for today has been reached for this organization. Please contact support or upgrade plan.'
          });
        }
      }
    } catch (e) {
      // non-fatal: log but continue (so missing subscription table doesn't block)
      console.warn('Warning checking booking_limit_daily:', e.message);
    }

    // compute next token for this org & date
    const maxRow = await db.query('SELECT MAX(token_no) AS max_token FROM bookings WHERE org_id = ? AND booking_date = ?', [org_id, booking_date]);
    const nextToken = (maxRow && maxRow[0] && maxRow[0].max_token) ? (maxRow[0].max_token + 1) : 1;

    // booking number & queue code & status link
    const booking_number = 'BKG' + Date.now().toString(36).toUpperCase();
    const queue_code = genQueueCode();
    const baseLive = config.liveBaseUrl || config.LIVE_BASE_URL || process.env.LIVE_BASE_URL || process.env.LIVE_BASEURL || '';
    const status_link = baseLive ? `${baseLive.replace(/\/$/, '')}/status/${queue_code}` : `/status/${queue_code}`;

    // Insert booking
    const insertSql = `INSERT INTO bookings (org_id, department, assigned_user_id, user_name, user_phone, user_email,
                        booking_date, booking_time, token_no, booking_number, queue_code, status_link, status, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', NOW(), NOW())`;
    const params = [org_id, department || null, assigned_user_id || null, user_name, user_phone, user_email || null,
      booking_date, booking_time || null, nextToken, booking_number, queue_code, status_link];

    const r = await db.query(insertSql, params);

    // fetch created booking
    const created = await db.query('SELECT * FROM bookings WHERE id = ?', [r.insertId]);
    const booking = created[0];

    // Build confirmation message
    const msg = `Hi ${user_name}, your booking is confirmed (token ${booking.token_no}) on ${booking.booking_date}. Track your live que: ${booking.status_link}`;

    // channel choice
    const channel = (prefer_channel === 'sms') ? 'sms' : 'whatsapp';

    // insert a pending notification row
    await db.query('INSERT INTO notifications (booking_id, org_id, to_phone, to_email, channel, body, status, created_at) VALUES (?, ?, ?, ?, ?, ?, "pending", NOW())',
      [booking.id, org_id, user_phone, user_email || null, channel, msg]);

    // build send links (whatsapp web, app deep link, sms)
    const sendLinks = buildSendLinks(user_phone, msg);

    return res.json({ ok: true, booking, send_links: sendLinks });

  } catch (err) {
    console.error('POST /bookings error', err);
    return res.status(500).json({ ok: false, error: 'server_error', details: err.message });
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
    const links = buildSendLinks(b.user_phone, text);
    return res.json({ ok:true, booking_id: b.id, status_link: b.status_link, ...links });
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
    const { served_by } = req.body || {};
    await db.query('UPDATE bookings SET status = "served", served_at = NOW(), served_by = ? WHERE id = ?', [served_by || null, id]);

    const booking = (await db.query('SELECT * FROM bookings WHERE id = ?', [id]))[0];
    if (!booking) return res.status(404).json({ ok:false, error:'not_found' });

    // compute current served token for the org & date
    const cur = await db.query("SELECT MAX(token_no) AS current_served FROM bookings WHERE org_id = ? AND booking_date = ? AND status = 'served'", [booking.org_id, booking.booking_date]);
    const current_served = cur && cur[0] && cur[0].current_served ? cur[0].current_served : null;

    // compute avg service time seconds for today (best-effort)
    const avg = await db.query("SELECT AVG(TIMESTAMPDIFF(SECOND, created_at, served_at)) AS avg_seconds FROM bookings WHERE org_id = ? AND DATE(served_at)=CURDATE() AND served_at IS NOT NULL", [booking.org_id]);
    const avg_seconds = avg && avg[0] && avg[0].avg_seconds ? Math.round(avg[0].avg_seconds) : null;

    // publish to SSE subscribers
    try {
      if (live && typeof live.publishOrgUpdate === 'function') {
        live.publishOrgUpdate(booking.org_id, { current_served, avg_seconds, updated_at: new Date().toISOString() });
      }
    } catch (e) {
      console.warn('Failed to publish SSE update:', e.message);
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
    if (from) { where += ' AND booking_date >= ?'; params.push(from); }
    if (to)   { where += ' AND booking_date <= ?'; params.push(to); }

    const sql = `SELECT id, booking_number, token_no, user_name, user_phone, user_email, department, booking_date, booking_time, status, created_at, served_at FROM bookings ${where} ORDER BY booking_date, token_no ASC`;
    const rows = await db.query(sql, params);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="bookings_${org_id}_${from||'all'}.csv"`);

    res.write('id,booking_number,token_no,user_name,user_phone,user_email,department,booking_date,booking_time,status,created_at,served_at\n');
    for (const r of rows) {
      const line = [
        r.id,
        r.booking_number,
        r.token_no,
        `"${(r.user_name||'').replace(/"/g,'""')}"`,
        r.user_phone || '',
        `"${(r.user_email||'').replace(/"/g,'""')}"`,
        `"${(r.department||'').replace(/"/g,'""')}"`,
        r.booking_date || '',
        r.booking_time || '',
        r.status || '',
        r.created_at ? (new Date(r.created_at)).toISOString() : '',
        r.served_at ? (new Date(r.served_at)).toISOString() : ''
      ].join(',') + '\n';
      res.write(line);
    }
    res.end();
  } catch (err) {
    console.error('GET /bookings/export error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});
