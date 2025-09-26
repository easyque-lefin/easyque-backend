// services/metrics.js
// Centralized live metrics & break logic (per org OR per assigned user)

const db = require('../db');
const { addSeconds } = require('../util/date');

const ASSIGNED = (process.env.ASSIGNED_METRICS || 'false').toLowerCase() === 'true';

// pick base table + key set
function T(orgId, assignedUserId) {
  if (ASSIGNED) {
    return {
      table: 'assigned_live_metrics',
      where: 'org_id = ? AND assigned_user_id = ?',
      args: [orgId, assignedUserId || 0],
      keys: ['org_id','assigned_user_id'],
      vals: [orgId, assignedUserId || 0]
    };
  }
  return {
    table: 'organizations',
    where: 'id = ?',
    args: [orgId],
    keys: ['id'],
    vals: [orgId]
  };
}

async function ensureRow(orgId, assignedUserId) {
  const t = T(orgId, assignedUserId);
  if (ASSIGNED) {
    const [r] = await db.query(
      `SELECT now_serving_token FROM ${t.table} WHERE ${t.where} LIMIT 1`,
      t.args
    );
    if (!r.length) {
      await db.query(
        `INSERT INTO ${t.table} (${t.keys.join(',')}) VALUES (?,?)`,
        t.vals
      );
    }
  }
}

async function getMetrics(orgId, assignedUserId) {
  const t = T(orgId, assignedUserId);
  await ensureRow(orgId, assignedUserId);

  const [rows] = await db.query(
    `SELECT now_serving_token, service_start_at, avg_service_seconds, active_clock_at, break_started_at, break_until
       FROM ${t.table}
      WHERE ${t.where}
      LIMIT 1`,
    t.args
  );
  return rows[0] || null;
}

async function updateMetrics(orgId, assignedUserId, patch) {
  const t = T(orgId, assignedUserId);
  const fields = [];
  const values = [];
  for (const [k,v] of Object.entries(patch)) {
    fields.push(`${k} = ?`);
    values.push(v);
  }
  values.push(...t.args);
  const sql = `UPDATE ${t.table} SET ${fields.join(', ')} WHERE ${t.where}`;
  await db.query(sql, values);
}

function secsHuman(s) {
  if (s == null) return null;
  const sec = Math.max(0, Math.floor(s));
  const m = Math.floor(sec/60);
  const r = sec % 60;
  return { seconds: sec, label: m ? `${m}m ${r}s` : `${r}s` };
}

async function startBreak(orgId, assignedUserId, until = null, breakingUserId = null) {
  const metrics = await getMetrics(orgId, assignedUserId);
  if (metrics?.break_started_at) {
    await updateMetrics(orgId, assignedUserId, { break_until: until ? new Date(until) : null });
    return;
  }
  await updateMetrics(orgId, assignedUserId, {
    break_started_at: new Date(),
    break_until: until ? new Date(until) : null
  });
  await db.query(
    `INSERT INTO org_breaks (org_id, assigned_user_id, started_at) VALUES (?,?,?)`,
    [orgId, assignedUserId || null, new Date()]
  );
}

async function endBreak(orgId, assignedUserId) {
  const m = await getMetrics(orgId, assignedUserId);
  if (!m?.break_started_at) return { ok:true, changed:false };

  const start = new Date(m.break_started_at);
  const until = m.break_until ? new Date(m.break_until) : new Date();
  const extra = Math.max(0, Math.floor((until - start)/1000));
  const ac = new Date(m.active_clock_at || m.service_start_at || new Date());

  await updateMetrics(orgId, assignedUserId, {
    break_started_at: null,
    break_until: null,
    active_clock_at: addSeconds(ac, extra)
  });

  await db.query(
    `UPDATE org_breaks SET ended_at=? WHERE org_id=? AND (assigned_user_id <=> ?) AND ended_at IS NULL`,
    [new Date(), orgId, assignedUserId || null]
  );

  return { ok:true, changed:true };
}

async function onServe({
  orgId,
  assignedUserId = null,
  bookingTokenNo
}) {
  // load metrics
  const m = await getMetrics(orgId, assignedUserId);
  const now = new Date();

  // not allowed while on break and not expired
  if (m?.break_started_at) {
    if (m.break_until && now >= new Date(m.break_until)) {
      // auto end
      await endBreak(orgId, assignedUserId);
    } else {
      const err = new Error('On break — resume before serving');
      err.status = 409;
      throw err;
    }
  }

  // first serve of the day: set start and active clock
  let serviceStartAt = m?.service_start_at;
  if (!serviceStartAt) {
    // check if any served today for the target scope
    const [cnt] = await db.query(
      `SELECT COUNT(*) AS c
         FROM bookings
        WHERE org_id = ?
          AND (${ASSIGNED ? 'assigned_user_id <=> ?' : '1=1'})
          AND served_at IS NOT NULL
          AND DATE(served_at) = CURDATE()`,
      ASSIGNED ? [orgId, assignedUserId] : [orgId]
    );
    if (!cnt[0].c) {
      serviceStartAt = now;
      await updateMetrics(orgId, assignedUserId, {
        service_start_at: serviceStartAt,
        active_clock_at: serviceStartAt
      });
    }
  }

  // compute delta from active_clock_at to now (excludes breaks by construction)
  const activeClock = new Date(m?.active_clock_at || serviceStartAt || now);
  const delta = Math.max(0, Math.floor((now - activeClock)/1000));

  // served count today (after this serve)
  const [cnt2] = await db.query(
    `SELECT COUNT(*) AS c
       FROM bookings
      WHERE org_id = ?
        AND (${ASSIGNED ? 'assigned_user_id <=> ?' : '1=1'})
        AND served_at IS NOT NULL
        AND DATE(served_at) = CURDATE()`,
    ASSIGNED ? [orgId, assignedUserId] : [orgId]
  );
  const n = (cnt2[0].c || 0) + 1; // include this one

  const prevAvg = m?.avg_service_seconds || 0;
  const nextAvg = n <= 1 ? delta : Math.floor((prevAvg * (n - 1) + delta) / n);

  // bump now_serving_token to at least this booking
  const newNowServing = Math.max(m?.now_serving_token || 0, bookingTokenNo);

  // advance active_clock_at to now (we "consumed" the active time)
  await updateMetrics(orgId, assignedUserId, {
    avg_service_seconds: nextAvg,
    now_serving_token: newNowServing,
    active_clock_at: now
  });

  return {
    now_serving_token: newNowServing,
    avg_service_seconds: nextAvg,
    service_start_at: serviceStartAt || now
  };
}

function etaFor(viewerToken, nowServing, avgSec) {
  if (!viewerToken || !avgSec) return null;
  const lag = Math.max(0, viewerToken - (nowServing || 0));
  const s = lag * avgSec;
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
