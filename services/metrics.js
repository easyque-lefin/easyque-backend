// services/metrics.js
// Centralized live metrics & break logic (per org OR per assigned user)
const db = require('../db');

const ASSIGNED = (process.env.ASSIGNED_METRICS || 'false').toLowerCase() === 'true';

// pick base table + key set
function T(orgId, assignedUserId) {
  if (ASSIGNED) {
    return {
      table: 'assigned_live_metrics',
      where: 'org_id = ? AND assigned_user_id = ?',
      args: [orgId, assignedUserId || 0],
      keys: ['org_id','assigned_user_id'],
    };
  }
  return {
    table: 'organizations',
    where: 'id = ?',
    args: [orgId],
    keys: ['id'],
  };
}

// Ensure row exists (for assigned_live_metrics)
async function ensureRow(orgId, assignedUserId) {
  const { table, where, args } = T(orgId, assignedUserId);
  if (table === 'assigned_live_metrics') {
    const rows = await db.query(`SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`, args);
    if (!rows.length) {
      await db.query(
        `INSERT INTO ${table}
         (org_id, assigned_user_id, now_serving_token, service_start_at, avg_service_seconds, active_clock_at, break_started_at, break_until, breaking_user_id)
         VALUES (?, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL)`,
        [orgId, assignedUserId || 0]
      );
    }
  }
}

async function getMetrics(orgId, assignedUserId = null) {
  const { table, where, args } = T(orgId, assignedUserId);
  await ensureRow(orgId, assignedUserId);
  const [row] = await db.query(
    `SELECT now_serving_token, service_start_at, avg_service_seconds, active_clock_at,
            break_started_at, break_until, breaking_user_id
       FROM ${table}
      WHERE ${where}
      LIMIT 1`, args
  );
  return row || null;
}

async function updateMetrics(orgId, assignedUserId, patch) {
  const { table, where, args } = T(orgId, assignedUserId);
  await ensureRow(orgId, assignedUserId);

  const fields = [];
  const values = [];
  for (const [k, v] of Object.entries(patch)) {
    fields.push(`${k} = ?`);
    values.push(v);
  }
  const sql = `UPDATE ${table} SET ${fields.join(', ')} WHERE ${where}`;
  await db.query(sql, [...values, ...args]);
}

function secsHuman(s) {
  s = Math.max(0, Math.round(s || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

function isBreakActive(m) {
  if (!m) return false;
  if (!m.break_started_at) return false;
  if (!m.break_until) return true;
  return new Date(m.break_until) > new Date();
}

/**
 * Called AFTER a booking is marked served.
 * Updates:
 *  - now_serving_token = tokenNo
 *  - service_start_at = first serve time (if null)
 *  - avg_service_seconds (incremental average by counting served tokens today)
 *  - active_clock_at = now (start timing the next token)
 */
async function onServe(orgId, assignedUserId, tokenNo, now = new Date()) {
  await ensureRow(orgId, assignedUserId);
  let m = await getMetrics(orgId, assignedUserId);

  // If first ever serve: establish start time & initialize clock
  const patch = { now_serving_token: tokenNo };
  if (!m.service_start_at) patch.service_start_at = now;
  // If break is active, we don't accumulate time for this token; the duration will be near-zero.
  // We still reset active clock for timing the next token.
  const prevClock = m.active_clock_at ? new Date(m.active_clock_at) : (m.service_start_at ? new Date(m.service_start_at) : now);
  const secondsForThisToken = isBreakActive(m) ? 0 : Math.max(0, Math.round((now - prevClock) / 1000));

  // Count served tokens for scope today (for simple, robust average)
  const whereScope =
    assignedUserId != null
      ? 'org_id = ? AND assigned_user_id = ?'
      : 'org_id = ? AND assigned_user_id IS NULL';

  const params =
    assignedUserId != null ? [orgId, assignedUserId] : [orgId];

  const [cntRow] = await db.query(
    `SELECT COUNT(*) AS c
       FROM bookings
      WHERE ${whereScope}
        AND DATE(booking_datetime) = DATE(NOW())
        AND served_at IS NOT NULL`,
    params
  );

  const servedCount = cntRow?.c || 1;
  const prevAvg = m.avg_service_seconds || 0;
  // Incremental average:
  // newAvg = ((prevAvg * (servedCount - 1)) + secondsForThisToken) / servedCount
  const newAvg = ((prevAvg * Math.max(0, servedCount - 1)) + secondsForThisToken) / servedCount;

  patch.avg_service_seconds = Math.max(0, Math.round(newAvg));
  patch.active_clock_at = now; // start timing the next token

  await updateMetrics(orgId, assignedUserId, patch);
  m = await getMetrics(orgId, assignedUserId);

  return {
    ...m,
    avg_service_time_human: secsHuman(m.avg_service_seconds || 0)
  };
}

async function startBreak(orgId, assignedUserId, breakingUserId, untilTs) {
  await updateMetrics(orgId, assignedUserId, {
    break_started_at: new Date(),
    break_until: untilTs ? new Date(untilTs) : null,
    breaking_user_id: breakingUserId || null
  });
}

async function endBreak(orgId, assignedUserId) {
  await updateMetrics(orgId, assignedUserId, {
    break_started_at: null,
    break_until: null,
    breaking_user_id: null,
    active_clock_at: new Date() // resume clock from now
  });
}

function etaFor(viewerToken, nowServingToken, avgSec) {
  const lag = Math.max(0, (parseInt(viewerToken || 0, 10) - parseInt(nowServingToken || 0, 10)));
  const s = lag * Math.max(0, avgSec || 0);
  return secsHuman(s);
}

module.exports = {
  getMetrics,
  updateMetrics,
  onServe,
  startBreak,
  endBreak,
  etaFor,
  secsHuman,
  ASSIGNED
};

