const express = require('express');
const router = express.Router();
const db = require('../db');
const { sendLive } = require('../services/liveBus');

// ---------- helpers ----------
function toE164(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const cleaned = s.replace(/[^\d+]/g, '');
  return cleaned || null;
}
function humanDateTime(dt) { return dt; }
function buildStatusUrl({ org_id, token_no, assigned_user_id }) {
  const base = 'https://status.easyque.org/public/status.html';
  const qs = new URLSearchParams();
  qs.set('org_id', String(org_id));
  qs.set('token', String(token_no));
  if (assigned_user_id) qs.set('assigned_user_id', String(assigned_user_id));
  return `${base}?${qs.toString()}`;
}
async function getOrgClock(org_id) {
  const [org] = await db.query(
    `SELECT now_serving_token, service_start_at, avg_service_seconds, active_clock_at
     FROM organizations WHERE id = ? LIMIT 1`, [org_id]);
  return org || null;
}
async function startOrgClockIfNeeded(org_id, firstServeAt) {
  const clock = await getOrgClock(org_id);
  if (!clock || clock.service_start_at) return;
  await db.query(
    `UPDATE organizations
       SET service_start_at = ?, active_clock_at = ?
     WHERE id = ?`,
    [firstServeAt, firstServeAt, org_id]
  );
}
async function updateOrgAvgOnServe(org_id, servedSeconds) {
  // update org rolling avg;  simple formula using total_served derived from bookings
  const [{ cnt }] = await db.query(
    `SELECT COUNT(*) AS cnt FROM bookings WHERE org_id = ? AND served_at IS NOT NULL`, [org_id]
  );
  const prevCount = Math.max(0, (cnt || 0) - 1);
  const [org] = await db.query(
    `SELECT avg_service_seconds FROM organizations WHERE id = ?`, [org_id]
  );
  const prevAvg = org?.avg_service_seconds || 0;
  const newAvg = prevCount <= 0 ? servedSeconds
    : Math.round((prevAvg * prevCount + servedSeconds) / (prevCount + 1));
  await db.query(
    `UPDATE organizations SET avg_service_seconds = ? WHERE id = ?`, [newAvg, org_id]
  );
}
async function updateAssignedAvgOnServe(org_id, assigned_user_id, servedSeconds) {
  if (!assigned_user_id) return;
  const [row] = await db.query(
    `SELECT id, total_served, total_seconds FROM assigned_live_metrics
      WHERE org_id = ? AND assigned_user_id = ? LIMIT 1`,
    [org_id, assigned_user_id]
  );
  if (!row) {
    await db.query(
      `INSERT INTO assigned_live_metrics (org_id, assigned_user_id, total_served, total_seconds, avg_service_seconds)
       VALUES (?, ?, 1, ?, ?)`,
      [org_id, assigned_user_id, servedSeconds, servedSeconds]
    );
  } else {
    const totalServed = (row.total_served || 0) + 1;
    const totalSec = (row.total_seconds || 0) + servedSeconds;
    const avg = Math.round(totalSec / totalServed);
    await db.query(
      `UPDATE assigned_live_metrics
         SET total_served = ?, total_seconds = ?, avg_service_seconds = ?
       WHERE id = ?`,
      [totalServed, totalSec, avg, row.id]
    );
  }
}

// ---------- create booking ----------
router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const org_id = parseInt(b.org_id, 10);
    const user_name = (b.user_name || '').trim();
    const user_phone = (b.user_phone || '').trim();
    const booking_datetime = b.booking_datetime; // 'YYYY-MM-DD HH:mm:ss'
    const assigned_user_id = b.assigned_user_id != null ? parseInt(b.assigned_user_id, 10) : null;

    if (!org_id || !user_name || !user_phone || !booking_datetime) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }

    if (assigned_user_id != null) {
      const [assignee] = await db.query(
        `SELECT id FROM users WHERE id = ? AND org_id = ? LIMIT 1`,
        [assigned_user_id, org_id]
      );
      if (!assignee) {
        return res.status(400).json({ ok: false, error: 'invalid_assigned_user' });
      }
    }

    // next token for same org + date (+ same assignee grouping)
    let where = 'org_id = ? AND DATE(booking_datetime) = DATE(?) AND ';
    const args = [org_id, booking_datetime];
    if (assigned_user_id == null) {
      where += 'assigned_user_id IS NULL';
    } else {
      where += 'assigned_user_id = ?';
      args.push(assigned_user_id);
    }
    const [mx] = await db.query(
      `SELECT COALESCE(MAX(token_no),0) AS m FROM bookings WHERE ${where}`,
      args
    );
    const nextToken = (mx?.m || 0) + 1;

    const insertSql = `
      INSERT INTO bookings (
        org_id, user_name, user_phone, user_email,
        department, division, assigned_user_id, receptionist_id,
        user_alt_phone, prefer_video, notes, place,
        booking_date, booking_time, booking_datetime,
        booking_number, token_no, status, created_at
      )
      VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        DATE(?), TIME(?), ?,
        ?, ?, 'waiting', NOW()
      )
    `;
    const params = [
      org_id, user_name, user_phone, b.user_email ?? null,
      b.department ?? null, b.division ?? null, assigned_user_id, b.receptionist_id ?? null,
      b.user_alt_phone ?? null, b.prefer_video ?? 0, b.notes ?? null, b.place ?? null,
      booking_datetime, booking_datetime, booking_datetime,
      nextToken, nextToken
    ];
    const result = await db.query(insertSql, params);

    // notify links
    const statusUrl = buildStatusUrl({ org_id, token_no: nextToken, assigned_user_id });
    const msg =
      `Hi ${user_name}, your booking is confirmed (token ${nextToken}) on ${humanDateTime(booking_datetime)}. ` +
      `Track your live queue: ${statusUrl}`;
    const e164 = toE164(user_phone) || '';
    const whatsapp_url = e164.startsWith('+')
      ? `https://wa.me/${encodeURIComponent(e164)}?text=${encodeURIComponent(msg)}`
      : null;
    const sms_url = `sms:${encodeURIComponent(e164 || user_phone)}?body=${encodeURIComponent(msg)}`;

    res.json({
      ok: true,
      booking: {
        id: result.insertId,
        org_id, assigned_user_id, user_name, user_phone,
        booking_datetime, token_no: nextToken, booking_number: nextToken, place: b.place ?? null
      },
      notify: { message: msg, whatsapp_url, sms_url, status_url: statusUrl }
    });

    // live fanout
    sendLive(org_id, assigned_user_id || null);
  } catch (err) {
    next(err);
  }
});

// ---------- serve booking ----------
router.post('/:id/serve', async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'invalid_id' });

    await conn.beginTransaction();

    const [bk] = await conn.query(
      `SELECT id, org_id, assigned_user_id, booking_datetime, served_at, token_no
         FROM bookings WHERE id = ? FOR UPDATE`,
      [id]
    );
    if (!bk) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: 'not_found' });
    }
    if (bk.served_at) {
      await conn.rollback();
      return res.json({ ok: true, already_served: true });
    }

    const servedAt = new Date();
    await conn.query(`UPDATE bookings SET served_at = ?, status='served' WHERE id = ?`, [servedAt, id]);

    // org now serving = this token if higher than previous
    await conn.query(
      `UPDATE organizations
          SET now_serving_token = GREATEST(COALESCE(now_serving_token,0), ?)
        WHERE id = ?`,
      [bk.token_no, bk.org_id]
    );

    // start org clock on first serve
    await startOrgClockIfNeeded(bk.org_id, servedAt);

    // update averages
    const waitSeconds = Math.max(
      0,
      Math.round((servedAt.getTime() - new Date(bk.booking_datetime).getTime()) / 1000)
    );
    await updateOrgAvgOnServe(bk.org_id, waitSeconds);
    await updateAssignedAvgOnServe(bk.org_id, bk.assigned_user_id, waitSeconds);

    await conn.commit();

    res.json({ ok: true, served_at: servedAt });
    sendLive(bk.org_id, bk.assigned_user_id || null);
  } catch (err) {
    try { await db.rollback(conn); } catch {}
    next(err);
  } finally {
    try { await conn.release(); } catch {}
  }
});

// ---------- list queue (optional, handy for admin/debug) ----------
router.get('/live', async (req, res, next) => {
  try {
    const org_id = parseInt(req.query.org_id, 10);
    const assigned_user_id = req.query.assigned_user_id != null
      ? parseInt(req.query.assigned_user_id, 10) : null;
    if (!org_id) return res.status(400).json({ ok: false, error: 'missing_org_id' });

    let where = 'org_id = ? AND status = "waiting"';
    const args = [org_id];
    if (assigned_user_id == null) {
      where += ' AND assigned_user_id IS NULL';
    } else {
      where += ' AND assigned_user_id = ?';
      args.push(assigned_user_id);
    }
    const rows = await db.query(
      `SELECT id, token_no, user_name, user_phone, booking_datetime
         FROM bookings
        WHERE ${where}
        ORDER BY booking_datetime ASC, token_no ASC`,
      args
    );
    res.json({ ok: true, items: rows });
  } catch (err) { next(err); }
});

module.exports = router;
