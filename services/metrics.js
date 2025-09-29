// services/metrics.js — compute/update now serving; uses token_number

const db = require('./db');
const dayjs = require('dayjs');

const num = (x, d=0) => { const n = Number(x); return Number.isFinite(n) ? n : d; };

/**
 * Set "now serving" token for an org (or per assigned user if needed).
 * mode: 'org' | 'assigned'
 */
async function setNowServing({ org_id, token_number, assigned_user_id = null, mode = 'org' }) {
  const today = dayjs().format('YYYY-MM-DD');

  if (mode === 'org' || !assigned_user_id) {
    await db.query(`UPDATE organizations SET now_serving_token=? WHERE id=?`, [num(token_number,null), org_id]);
    return;
  }

  // assigned mode
  await db.query(
    `INSERT INTO assigned_live_metrics (org_id, assigned_user_id, booking_date, now_serving_token, updated_at)
     VALUES (?,?,?,?,NOW())
     ON DUPLICATE KEY UPDATE now_serving_token=VALUES(now_serving_token), updated_at=NOW()`,
    [org_id, assigned_user_id, today, num(token_number,null)]
  );
}

/**
 * Recalculate average service time based on served bookings today.
 * Requires bookings.served_at and token_number to exist.
 */
async function recalcAvgServiceSeconds({ org_id, assigned_user_id = null }) {
  const today = dayjs().format('YYYY-MM-DD');

  if (assigned_user_id) {
    const [rows] = await db.query(
      `SELECT TIMESTAMPDIFF(SECOND, scheduled_at, served_at) AS s
         FROM bookings
        WHERE org_id=? AND assigned_user_id=? AND booking_date=? AND served_at IS NOT NULL`,
      [org_id, assigned_user_id, today]
    );
    const avg = rows.length ? Math.round(rows.reduce((a,b)=>a+(b.s||0),0) / rows.length) : null;
    await db.query(
      `INSERT INTO assigned_live_metrics (org_id, assigned_user_id, booking_date, avg_service_seconds, updated_at)
       VALUES (?,?,?,?,NOW())
       ON DUPLICATE KEY UPDATE avg_service_seconds=VALUES(avg_service_seconds), updated_at=NOW()`,
      [org_id, assigned_user_id, today, avg]
    );
    return avg;
  }

  const [rows] = await db.query(
    `SELECT TIMESTAMPDIFF(SECOND, scheduled_at, served_at) AS s
       FROM bookings
      WHERE org_id=? AND booking_date=? AND served_at IS NOT NULL`,
    [org_id, today]
  );
  const avg = rows.length ? Math.round(rows.reduce((a,b)=>a+(b.s||0),0) / rows.length) : null;
  await db.query(`UPDATE organizations SET avg_service_seconds=? WHERE id=?`, [avg, org_id]);
  return avg;
}

module.exports = { setNowServing, recalcAvgServiceSeconds };

