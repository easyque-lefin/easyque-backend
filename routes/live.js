// routes/live.js
// Server-Sent Events stream for live queue status (org-wide or per assigned user)

const express = require('express');
const router = express.Router();
const { orgSnapshot } = require('../services/liveBus');

const clients = new Map(); // key = `${orgId}:${assignedUserId||0}` -> Set(res)
const HEARTBEAT_MS = 15000;

function key(orgId, assignedUserId) {
  return `${orgId}:${assignedUserId || 0}`;
}

function broadcastToOrgUser(orgId, assignedUserId, payload) {
  const k = key(orgId, assignedUserId);
  const set = clients.get(k);
  if (!set) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try { res.write(data); } catch {}
  }
}

router.get('/', async (req, res, next) => {
  try {
    // Query: /live?org_id=123&assigned_user_id=45&viewer_token=27
    const orgId = parseInt(req.query.org_id, 10);
    if (!orgId) return res.status(400).end('org_id required');

    const assignedUserId = req.query.assigned_user_id
      ? parseInt(req.query.assigned_user_id, 10)
      : null;

    const viewerToken = req.query.viewer_token
      ? parseInt(req.query.viewer_token, 10)
      : null;

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // initial snapshot (includes ETA if viewerToken provided)
    const snap = await orgSnapshot(orgId, assignedUserId, viewerToken);
    res.write(`event: init\n`);
    res.write(`data: ${JSON.stringify({ type: 'live:init', data: snap })}\n\n`);

    // register client
    const k = key(orgId, assignedUserId);
    let set = clients.get(k);
    if (!set) { set = new Set(); clients.set(k, set); }
    set.add(res);

    // heartbeat
    const hb = setInterval(() => {
      try { res.write(`event: ping\ndata: {}\n\n`); } catch {}
    }, HEARTBEAT_MS);

    req.on('close', () => {
      clearInterval(hb);
      set.delete(res);
      if (!set.size) clients.delete(k);
    });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.broadcastToOrgUser = broadcastToOrgUser;

