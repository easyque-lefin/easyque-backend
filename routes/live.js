// routes/live.js
// SSE live stream for organization queue updates and a simple status endpoint to show current queue and banner info

const express = require('express');
const db = require('../db');
const router = express.Router();

const clientsByOrg = new Map(); // orgId -> Set(res)

function publishOrgUpdate(orgId, payload) {
  const set = clientsByOrg.get(String(orgId));
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const res of set) {
    try {
      res.write(`data: ${data}\n\n`);
    } catch (e) {
      // ignore broken connection
    }
  }
}

/**
 * SSE stream
 * GET /live/stream/:orgId
 */
router.get('/stream/:orgId', (req, res) => {
  const orgId = req.params.orgId;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  const key = String(orgId);
  if (!clientsByOrg.has(key)) clientsByOrg.set(key, new Set());
  clientsByOrg.get(key).add(res);

  req.on('close', () => {
    const s = clientsByOrg.get(key);
    if (s) {
      s.delete(res);
      if (s.size === 0) clientsByOrg.delete(key);
    }
  });
});

/**
 * Helper for other routes to publish
 */
module.exports = router;
module.exports.publishOrgUpdate = publishOrgUpdate;
