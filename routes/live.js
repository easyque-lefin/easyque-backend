// routes/live.js
// Server-Sent Events for live queue updates.
// Keep in-memory subscribers for now. For production use Redis pub/sub.

const express = require('express');
const router = express.Router();

// map org_id -> Set of responses
const subscribers = new Map();

function addSubscriber(orgId, res) {
  if (!subscribers.has(orgId)) subscribers.set(orgId, new Set());
  subscribers.get(orgId).add(res);
}

function removeSubscriber(orgId, res) {
  if (!subscribers.has(orgId)) return;
  subscribers.get(orgId).delete(res);
  if (subscribers.get(orgId).size === 0) subscribers.delete(orgId);
}

function publishOrgUpdate(orgId, payload) {
  const clients = subscribers.get(orgId);
  if (!clients) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
    } catch (e) {
      try { removeSubscriber(orgId, res); res.end(); } catch(_) {}
    }
  }
}

router.get('/stream/:orgId', (req, res) => {
  const orgId = parseInt(req.params.orgId, 10);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('\n'); // handshake
  addSubscriber(orgId, res);
  req.on('close', () => {
    removeSubscriber(orgId, res);
  });
});

module.exports = router;
module.exports.publishOrgUpdate = publishOrgUpdate;
