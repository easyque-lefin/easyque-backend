// routes/live.js
// Simple Server-Sent Events (SSE) server for live queue updates.
// Maintains in-memory subscribers per org. For production consider Redis pub/sub across processes.

const express = require('express');
const router = express.Router();

// map org_id -> Set of response objects
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

/**
 * publishOrgUpdate(orgId, payload)
 * payload should be a serializable object.
 * This function will be used by other routes to push updates to connected clients.
 */
function publishOrgUpdate(orgId, payload) {
  const clients = subscribers.get(orgId);
  if (!clients) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
    } catch (e) {
      // ignore write errors; remove client
      try { removeSubscriber(orgId, res); res.end(); } catch(_) {}
    }
  }
}

router.get('/stream/:orgId', (req, res) => {
  const orgId = parseInt(req.params.orgId, 10);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('\n'); // handshake

  addSubscriber(orgId, res);

  req.on('close', () => {
    removeSubscriber(orgId, res);
  });
});

// Export router and publisher so other modules can require and call publishOrgUpdate
module.exports = router;
module.exports.publishOrgUpdate = publishOrgUpdate;
