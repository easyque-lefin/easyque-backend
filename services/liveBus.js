// services/liveBus.js
const db = require('../db');
const { getMetrics, etaFor, secsHuman } = require('./metrics');
const { broadcastToOrgUser } = require('../routes/live');

/**
 * Build a snapshot payload that the status page understands.
 */
async function orgSnapshot(orgId, assignedUserId = null, viewerToken = null) {
  const metrics = await getMetrics(orgId, assignedUserId);
  if (!metrics) return null;

  const [org] = await db.query(
    `SELECT id, name, banner_url, map_url
       FROM organizations
      WHERE id = ?
      LIMIT 1`,
    [orgId]
  );
  if (!org) return null;

  const payload = {
    org_id: orgId,
    org_name: org.name,
    banner_url: org.banner_url || null,
    map_url: org.map_url || null,

    now_serving_token: metrics.now_serving_token || 0,
    service_start_at: metrics.service_start_at || null,
    avg_service_seconds: metrics.avg_service_seconds || 0,
    avg_service_human: secsHuman(metrics.avg_service_seconds || 0),

    break_started_at: metrics.break_started_at || null,
    break_until: metrics.break_until || null,
    breaking_user_id: metrics.breaking_user_id || null,
  };

  if (viewerToken) {
    payload.viewer_token = viewerToken;
    payload.estimated_wait = etaFor(
      viewerToken,
      payload.now_serving_token,
      payload.avg_service_seconds
    );

    // Booking info for the viewer token today
    const scopeWhere = assignedUserId != null
      ? `org_id = ? AND assigned_user_id = ?`
      : `org_id = ? AND assigned_user_id IS NULL`;
    const scopeArgs = assignedUserId != null
      ? [orgId, assignedUserId]
      : [orgId];

    const [bk] = await db.query(
      `SELECT id, user_name, booking_datetime, assigned_user_id, department
         FROM bookings
        WHERE ${scopeWhere}
          AND DATE(booking_datetime) = CURRENT_DATE()
          AND token_no = ?
        LIMIT 1`,
      [...scopeArgs, viewerToken]
    );

    if (bk) {
      let assignedUserName = null;
      if (bk.assigned_user_id) {
        const [u] = await db.query(
          `SELECT COALESCE(name, full_name, display_name, username) AS resolved_name
             FROM users WHERE id = ? LIMIT 1`,
          [bk.assigned_user_id]
        );
        assignedUserName = (u && u.resolved_name) ? u.resolved_name : null;
      }

      payload.booking_info = {
        booking_id: bk.id,
        name: bk.user_name || null,
        booking_datetime: bk.booking_datetime,
        assigned_user_id: bk.assigned_user_id || null,
        assigned_user_name: assignedUserName,
        department: bk.department || null
      };
    }
  }

  return payload;
}

/** Broadcast helper used by routes */
async function sendLive(orgId, assignedUserId = null) {
  const p = await orgSnapshot(orgId, assignedUserId, null);
  if (p) broadcastToOrgUser(orgId, assignedUserId, { type:'live:update', data:p });
}

module.exports = { orgSnapshot, sendLive };
