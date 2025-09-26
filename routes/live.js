// routes/live.js
// Server-Sent Events for org/doctor live status
const express = require('express');
const router = express.Router();
const { orgSnapshot } = require('../services/liveBus');

const clients = new Map(); // key => Set(res)
const HEARTBEAT_MS = 15000;

function key(orgId, assignedUserId) {
  return `${orgId}:${assignedUserId || 0}`;
}

function broadcastToOrgUser(orgId, assignedUserId, payload) {
  const k = key(orgId, assignedUserId);
  const set = clients.get(k);
  if (!set || !set.size) return;
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const res of set) {
    try { res.write(`data: ${data}\n\n`); } catch {}
  }
}

// GET /live?org_id=1&assigned_user_id=3&viewer_token=25
router.get('/', async (req, res, next) => {
  try {
    const orgId = parseInt(req.query.org_id, 10);
    if (!orgId) return res.status(400).end('org_id required');

    const assignedUserId = req.query.assigned_user_id ? parseInt(req.query.assigned_user_id, 10) : null;
    const viewerToken = req.query.viewer_token ? parseInt(req.query.viewer_token, 10) : null;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    res.flushHeaders?.();

    const k = key(orgId, assignedUserId);
    let set = clients.get(k);
    if (!set) { set = new Set(); clients.set(k, set); }
    set.add(res);

    // Immediately push a snapshot
    const snap = await orgSnapshot(orgId, assignedUserId, viewerToken);
    if (snap) {
      res.write(`event: init\ndata: ${JSON.stringify(snap)}\n\n`);
    }

    // Heartbeat to keep connection alive
    const hb = setInterval(() => {
      try { res.write(`event: ping\ndata: {}\n\n`); } catch {}
    }, HEARTBEAT_MS);

    req.on('close', () => {
      clearInterval(hb);
      set.delete(res);
      if (!set.size) clients.delete(k);
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.broadcastToOrgUser = broadcastToOrgUser;

