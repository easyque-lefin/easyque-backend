// services/liveBus.js
const db = require('../db');
const { getMetrics, etaFor, secsHuman } = require('./metrics');
const { broadcastToOrgUser } = require('../routes/live');

async function orgSnapshot(orgId, assignedUserId = null, viewerToken = null) {
  const m = await getMetrics(orgId, assignedUserId);
  if (!m) return null;

  // Organization context + map_url (add this column in organizations if missing)
  const [org] = await db.query(
    `SELECT id, name, location, banner_url, map_url
       FROM organizations
      WHERE id = ?
      LIMIT 1`,
    [orgId]
  );

  const payload = {
    org_id: orgId,
    assigned_user_id: assignedUserId,
    organization: org ? {
      id: org.id,
      name: org.name,
      location: org.location,
      banner_url: org.banner_url,
      map_url: org.map_url || null
    } : null,
    now_serving_token: m.now_serving_token || 0,
    service_start_at: m.service_start_at || null,
    avg_service_seconds: m.avg_service_seconds || 0,
    avg_service_time: secsHuman(m.avg_service_seconds || 0),
    on_break: !!m.break_started_at,
    break_until: m.break_until || null,
    breaking_user_id: m.breaking_user_id || null
  };

  // If we know the viewer's token, include ETA and booking info
  if (viewerToken) {
    payload.viewer_token = viewerToken;
    payload.estimated_wait = etaFor(
      viewerToken,
      payload.now_serving_token,
      m.avg_service_seconds || 0
    );

    // Try to fetch today's booking for this token
    // Scope: same org, same day, and same assigned_user (if provided)
    const scopeWhere = assignedUserId != null
      ? `org_id = ? AND assigned_user_id = ?`
      : `org_id = ? AND assigned_user_id IS NULL`;

    const scopeArgs = assignedUserId != null
      ? [orgId, assignedUserId, viewerToken]
      : [orgId, viewerToken];

    const [bk] = await db.query(
      `SELECT id, full_name, booking_datetime, assigned_user_id, department
         FROM bookings
        WHERE ${scopeWhere}
          AND DATE(booking_datetime) = DATE(NOW())
          AND token_no = ?
        LIMIT 1`,
      scopeArgs
    );

    if (bk) {
      // Resolve assigned user name if available
      let assignedUserName = null;
      if (bk.assigned_user_id) {
        const [u] = await db.query(
          `SELECT 
              COALESCE(name, full_name, display_name, username) AS resolved_name
             FROM users
            WHERE id = ?
            LIMIT 1`,
          [bk.assigned_user_id]
        );
        assignedUserName = (u && u.resolved_name) ? u.resolved_name : null;
      }

      payload.booking_info = {
        booking_id: bk.id,
        name: bk.full_name || null,
        booking_datetime: bk.booking_datetime || null,
        assigned_user_id: bk.assigned_user_id || null,
        assigned_user_name: assignedUserName,
        department: bk.department || null
      };
    }
  }

  return payload;
}

// Broadcast to all clients watching this (org,assigned_userId) channel
async function sendLive(orgId, assignedUserId = null) {
  const p = await orgSnapshot(orgId, assignedUserId, null);
  if (p) broadcastToOrgUser(orgId, assignedUserId, { type:'live:update', data:p });
}

module.exports = { orgSnapshot, sendLive };
