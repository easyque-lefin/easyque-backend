// services/liveBus.js
const db = require('../db');
const { getMetrics, etaFor, secsHuman } = require('./metrics');
const { broadcastToOrgUser } = require('../routes/live'); // function below

async function orgSnapshot(orgId, assignedUserId = null, viewerToken = null) {
  const m = await getMetrics(orgId, assignedUserId);
  if (!m) return null;

  const payload = {
    org_id: orgId,
    assigned_user_id: assignedUserId,
    now_serving_token: m.now_serving_token || 0,
    service_start_at: m.service_start_at || null,
    avg_service_time: secsHuman(m.avg_service_seconds || 0),
    on_break: !!m.break_started_at,
    break_until: m.break_until || null
  };

  if (viewerToken) {
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
