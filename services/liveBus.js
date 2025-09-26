// services/liveBus.js
const clients = new Set();

function onClientSubscribe(req, res) {
  // Keep connection open
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no' // for nginx-like proxies
  });
  const client = {
    res,
    org_id: req.query.org_id ? String(req.query.org_id) : null,
    assigned_user_id: req.query.assigned_user_id ? String(req.query.assigned_user_id) : null
  };
  clients.add(client);

  // ping to keep-alive
  const ping = setInterval(() => {
    try { res.write(`event: ping\ndata: {}\n\n`); } catch {}
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
  });

  res.write(`retry: 3000\n\n`);
}

function sendLive(orgId, assignedUserId /* can be null */) {
  const org = String(orgId);
  const tgtAssigned = assignedUserId == null ? null : String(assignedUserId);
  for (const c of clients) {
    const sameOrg = !c.org_id || c.org_id === org; // if client didn’t filter org, send anyway
    const sameAssignee =
      c.assigned_user_id == null
        ? true // client wants all in org
        : c.assigned_user_id === (tgtAssigned ?? 'null');
    if (sameOrg && sameAssignee) {
      try {
        c.res.write(`event: live\ndata: ${JSON.stringify({ org_id: orgId, assigned_user_id: assignedUserId })}\n\n`);
      } catch { /* ignore broken clients */ }
    }
  }
}

module.exports = { onClientSubscribe, sendLive };
