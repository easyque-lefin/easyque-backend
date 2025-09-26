// routes/live.js
const express = require('express');
const router = express.Router();
const clients = new Map(); // key = `${orgId}:${assignedUserId||0}` -> Set(res)

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

router.get('/stream/:orgId/:assignedUserId?', (req, res) => {
  const orgId = parseInt(req.params.orgId, 10);
  const assignedUserId = req.params.assignedUserId ? parseInt(req.params.assignedUserId, 10) : null;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('retry: 1000\n\n');

  const k = key(orgId, assignedUserId);
  let set = clients.get(k);
  if (!set) { set = new Set(); clients.set(k, set); }
  set.add(res);

  req.on('close', () => {
    set.delete(res);
    if (!set.size) clients.delete(k);
  });
});

module.exports = router;
module.exports.broadcastToOrgUser = broadcastToOrgUser;

