const express = require('express');
const router = express.Router();
const db = require('../db');

function secondsToNice(s) {
  s = Math.max(0, Math.round(s || 0));
  const m = Math.floor(s / 60), sec = s % 60;
  return `${m}m ${sec}s`;
}

router.get('/snapshot', async (req, res, next) => {
  try {
    const org_id = parseInt(req.query.org_id, 10);
    const token = parseInt(req.query.token, 10);
    const assigned_user_id = req.query.assigned_user_id != null
      ? parseInt(req.query.assigned_user_id, 10) : null;

    if (!org_id || !token) return res.status(400).json({ ok: false, error: 'missing_params' });

    const [org] = await db.query(
      `SELECT name, banner_url, now_serving_token, service_start_at, avg_service_seconds,
              break_started_at, break_until, breaking_user_id
         FROM organizations WHERE id = ? LIMIT 1`, [org_id]);
    if (!org) return res.status(404).json({ ok: false, error: 'org_not_found' });

    // queue position
    let where = 'org_id = ? AND status = "waiting"';
    const args = [org_id];
    if (assigned_user_id == null) {
      where += ' AND assigned_user_id IS NULL';
    } else {
      where += ' AND assigned_user_id = ?';
      args.push(assigned_user_id);
    }
    const waiting = await db.query(
      `SELECT token_no FROM bookings WHERE ${where} ORDER BY booking_datetime ASC, token_no ASC`,
      args
    );
    const pos = waiting.findIndex(r => r.token_no === token);
    const queuePos = pos === -1 ? null : pos + 1;

    // ETA using org avg (or assigned avg if available)
    let avg = org.avg_service_seconds || 0;
    if (assigned_user_id) {
      const [m] = await db.query(
        `SELECT avg_service_seconds FROM assigned_live_metrics
          WHERE org_id = ? AND assigned_user_id = ? LIMIT 1`,
        [org_id, assigned_user_id]
      );
      if (m && m.avg_service_seconds) avg = m.avg_service_seconds;
    }
    const etaSec = queuePos ? (queuePos - 1) * (avg || 0) : 0;

    res.json({
      ok: true,
      org: {
        name: org.name,
        banner_url: org.banner_url
      },
      counters: {
        now_serving: org.now_serving_token || 0,
        avg_service_seconds: avg,
        avg_service_readable: secondsToNice(avg),
        service_start_at: org.service_start_at
      },
      you: {
        token,
        queue_position: queuePos,
        eta_seconds: etaSec,
        eta_readable: secondsToNice(etaSec),
        assigned_user_id: assigned_user_id || null
      },
      break: {
        on_break: !!org.break_started_at,
        break_started_at: org.break_started_at,
        break_until: org.break_until,
        breaking_user_id: org.breaking_user_id
      }
    });
  } catch (err) { next(err); }
});

module.exports = router;
