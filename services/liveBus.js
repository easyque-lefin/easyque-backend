// services/liveBus.js
const db = require('../db');
const { getMetrics, etaFor, secsHuman } = require('./metrics');
const { broadcastToOrgUser } = require('../routes/live');

async function orgSnapshot(orgId, assignedUserId = null, viewerToken = null) {
  const m = await getMetrics(orgId, assignedUserId);
  if (!m) return null;

  // Fetch some org context (name, banner) if needed on status page
  const [org] = await db.query(
    `SELECT id, name, location, banner_url
       FROM organizations
      WHERE id = ?
      LIMIT 1`,
    [orgId]
  );

  const payload = {
    org_id: orgId,
    assigned_user_id: assignedUserId,
    organization: org ? { id: org.id, name: org.name, location: org.location, banner_url: org.banner_url } : null,
    now_serving_token: m.now_serving_token || 0,
    service_start_at: m.service_start_at || null,
    avg_service_seconds: m.avg_service_seconds || 0,
    avg_service_time: secsHuman(m.avg_service_seconds || 0),
    on_break: !!m.break_started_at,
    break_until: m.break_until || null,
    breaking_user_id: m.breaking_user_id || null
  };

  if (viewerToken) {
    payload.viewer_token = viewerToken;
    payload.estimated_wait = etaFor(viewerToken, payload.now_serving_token, m.avg_service_seconds || 0);
  }

  return payload;
}

// Broadcast to all clients watching this (org,assigned_userId) channel
async function sendLive(orgId, assignedUserId = null) {
  const p = await orgSnapshot(orgId, assignedUserId, null);
  if (p) broadcastToOrgUser(orgId, assignedUserId, { type:'live:update', data:p });
}

module.exports = { orgSnapshot, sendLive };
