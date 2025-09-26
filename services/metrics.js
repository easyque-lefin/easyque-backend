// services/metrics.js
// Live metrics & break logic
const db = require('../db');

/**
 * Get metrics row for org or assigned user.
 * Uses organizations table for org-level metrics, or assigned_live_metrics for per-doctor metrics.
 */
function pickTarget(orgId, assignedUserId) {
  if (assignedUserId != null) {
    return {
      table: 'assigned_live_metrics',
      where: 'org_id = ? AND assigned_user_id = ?',
      args: [orgId, assignedUserId]
    };
  }
  return {
    table: 'organizations',
    where: 'id = ?',
    args: [orgId]
  };
}

async function ensureAssignedRow(orgId, assignedUserId) {
  if (assignedUserId == null) return;
  const rows = await db.query(
    `SELECT 1 FROM assigned_live_metrics WHERE org_id = ? AND assigned_user_id = ? LIMIT 1`,
    [orgId, assignedUserId]
  );
  if (!rows.length) {
    await db.query(
      `INSERT INTO assigned_live_metrics
         (org_id, assigned_user_id, now_serving_token, avg_service_seconds)
       VALUES (?, ?, 0, 0)`,
      [orgId, assignedUserId]
    );
  }
}

async function getMetrics(orgId, assignedUserId = null) {
  const t = pickTarget(orgId, assignedUserId);
  const [row] = await db.query(`SELECT * FROM ${t.table} WHERE ${t.where} LIMIT 1`, t.args);
  if (!row) return null;
  return row;
}

/**
 * Called when a booking is served. Updates now_serving_token, service_start_at (if first),
 * and recomputes avg_service_seconds based on today's served bookings.
 */
async function onServe(orgId, assignedUserId = null) {
  await ensureAssignedRow(orgId, assignedUserId);

  // Resolve table
  const t = pickTarget(orgId, assignedUserId);

  // Compute now_serving as the max served token today in scope
  const scopeWhere = assignedUserId != null
    ? `org_id = ? AND assigned_user_id = ?`
    : `org_id = ? AND assigned_user_id IS NULL`;
  const scopeArgs = assignedUserId != null ? [orgId, assignedUserId] : [orgId];

  const [cur] = await db.query(
    `SELECT COALESCE(MAX(token_no),0) AS now_serving
       FROM bookings
      WHERE ${scopeWhere}
        AND DATE(served_at) = CURRENT_DATE()`,
    scopeArgs
  );
  const nowServing = cur?.now_serving || 0;

  // Start time = first served booking time today (if not already set)
  const [start] = await db.query(
    `SELECT MIN(served_at) AS first_served
       FROM bookings
      WHERE ${scopeWhere}
        AND DATE(served_at) = CURRENT_DATE()`,
    scopeArgs
  );
  const serviceStartAt = start?.first_served || null;

  // Average service seconds = avg(booked->served) for today's served tokens (proxy)
  const [avg] = await db.query(
    `SELECT ROUND(AVG(TIMESTAMPDIFF(SECOND, booking_datetime, served_at))) AS avg_secs
       FROM bookings
      WHERE ${scopeWhere}
        AND served_at IS NOT NULL
        AND DATE(served_at) = CURRENT_DATE()`,
    scopeArgs
  );
  const avgSecs = avg?.avg_secs || 0;

  // Update metrics row
  const cols = ['now_serving_token = ?','avg_service_seconds = ?'];
  const params = [nowServing, avgSecs];

  if (serviceStartAt) {
    cols.push('service_start_at = IFNULL(service_start_at, ?)');
    params.push(serviceStartAt);
  }

  await db.query(
    `UPDATE ${t.table}
        SET ${cols.join(', ')}
      WHERE ${t.where}`,
    [...params, ...t.args]
  );
}

/** ETA helper */
function etaFor(viewerToken, nowServing, avgSeconds) {
  const pos = Math.max(0, (viewerToken || 0) - (nowServing || 0));
  return pos * (avgSeconds || 0);
}

/** Pretty seconds */
function secsHuman(s) {
  s = s || 0;
  const m = Math.floor(s/60), sec = s%60;
  if (m <= 0) return `${sec}s`;
  return `${m}m ${sec}s`;
}

module.exports = {
  getMetrics,
  onServe,
  etaFor,
  secsHuman
};

