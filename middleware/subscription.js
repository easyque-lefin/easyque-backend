// middleware/subscription.js
// Usage: const checkSubscription = require('../middleware/subscription');
// app.use('/bookings', requireAuth, checkSubscription, bookingsRouter);

const db = require("../services/db");

async function checkSubscription(req, res, next) {
  try {
    // req.user should be set by your auth middleware (requireAuth)
    if (!req.user || !req.user.id) return res.status(401).json({ ok:false, error:'unauthenticated' });

    // If user is admin (global) allow everything
    if (req.user.role === 'admin') return next();

    const orgId = req.user.org_id;
    if (!orgId) return res.status(403).json({ ok:false, error:'no_org_assigned' });

    // fetch subscription row for this org
    const rows = await db.query('SELECT * FROM org_subscriptions WHERE org_id = ? ORDER BY id DESC LIMIT 1', [orgId]);
    if (!rows || !rows.length) {
      // No subscription row -> treat as no-access unless you want to allow (decide policy)
      return res.status(403).json({ ok:false, error:'no_subscription' });
    }

    const sub = rows[0];
    // if trial & not expired -> allow
    if (sub.status === 'trial') {
      // check signup_trials to find expiry
      const trials = await db.query('SELECT trial_expires_at FROM signup_trials WHERE org_id = ? ORDER BY id DESC LIMIT 1', [orgId]);
      if (trials && trials[0] && trials[0].trial_expires_at) {
        const expires = new Date(trials[0].trial_expires_at);
        if (expires > new Date()) return next();
        // otherwise trial expired -> fall-through to check status below
      }
    }

    // allow if active
    if (sub.status === 'active') return next();

    // if past_due or cancelled -> deny with appropriate message
    if (['past_due','cancelled'].includes(sub.status)) {
      return res.status(403).json({ ok:false, error:'subscription_inactive', status: sub.status });
    }

    // otherwise deny by default
    return res.status(403).json({ ok:false, error:'subscription_blocked', status: sub.status });

  } catch (err) {
    console.error('subscription middleware error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
}

module.exports = checkSubscription;
