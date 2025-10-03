// middleware/guards.js
const jwt = require('jsonwebtoken');
const db = require("../services/db");

const JWT_SECRET = process.env.JWT_SECRET || 'replace-me';

function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
}

// Only your admin email can access EasyQue Admin features
function requireSuperAdmin(req, res, next) {
  const email = (req.user && req.user.email) || '';
  if (email.toLowerCase() === 'easyque0@gmail.com') return next();
  return res.status(403).json({ ok: false, error: 'Forbidden' });
}

// Load org and attach to req.org by id
async function loadOrg(req, res, next) {
  try {
    const org_id = Number(req.params.org_id || req.body.org_id || req.query.org_id);
    if (!org_id) return res.status(400).json({ ok: false, error: 'org_id required' });
    const [row] = await db.query(`SELECT * FROM organizations WHERE id = ? LIMIT 1`, [org_id]);
    if (!row || !row[0]) return res.status(404).json({ ok: false, error: 'Organization not found' });
    req.org = row[0];
    next();
  } catch (e) { next(e); }
}

// Trial + paid status gate (login & booking create)
// login_gate=true -> enforce at login; create_gate=true -> enforce on booking create
function enforceOrgAccess({ login_gate = false, create_gate = false } = {}) {
  return async (req, res, next) => {
    try {
      const org = req.org || await (async ()=>{
        const oid = Number(req.body.org_id || req.query.org_id || req.params.org_id);
        if (!oid) return null;
        const [r] = await db.query(`SELECT * FROM organizations WHERE id = ? LIMIT 1`, [oid]);
        return r && r[0] ? r[0] : null;
      })();

      if (!org) return next(); // Some routes may not tie to org yet

      // If deactivated
      if (org.is_active === 0) {
        return res.status(403).json({ ok: false, error: 'Organization is deactivated' });
      }

      // After trial window, require paid (either last_paid_at within 30 days OR subscription_id present)
      const trialStart = org.trial_started_at ? new Date(org.trial_started_at).getTime() : null;
      const now = Date.now();
      const ms7d = 7 * 24 * 60 * 60 * 1000;
      const trialOver = trialStart ? (now - trialStart) > ms7d : false;

      const lastPaid = org.last_paid_at ? new Date(org.last_paid_at).getTime() : 0;
      const ms30d = 30 * 24 * 60 * 60 * 1000;
      const within30 = lastPaid && (now - lastPaid) <= ms30d;
      const hasSubscription = !!org.subscription_id;

      const paidOrTrial = (!trialOver) || within30 || hasSubscription;

      if (login_gate && !paidOrTrial) {
        return res.status(402).json({ ok: false, error: 'Your free trial is over, please sign up now to continue using our service.' });
      }
      if (create_gate && !paidOrTrial) {
        return res.status(402).json({ ok: false, error: 'Your free trial is over, please sign up now to continue using our service.' });
      }
      next();
    } catch (e) { next(e); }
  };
}

// Booking limits enforcement (per day and per month)
function enforceBookingLimits() {
  return async (req, res, next) => {
    try {
      const org_id = Number(req.body.org_id || req.query.org_id || req.params.org_id);
      if (!org_id) return res.status(400).json({ ok: false, error: 'org_id required' });

      const [r] = await db.query(`SELECT expected_bookings_per_day FROM organizations WHERE id = ?`, [org_id]);
      const perDay = (r && r[0] && r[0].expected_bookings_per_day) ? Number(r[0].expected_bookings_per_day) : null;
      if (!perDay || perDay <= 0) return next(); // no limit set

      // Today count
      const [d] = await db.query(`SELECT COUNT(*) AS c FROM bookings WHERE org_id = ? AND DATE(booking_datetime) = CURDATE()`, [org_id]);
      const todayCount = d && d[0] ? Number(d[0].c || 0) : 0;

      if (todayCount >= perDay) {
        return res.status(429).json({
          ok: false,
          error: 'Your booking limit is over as per your current plan, kindly contact EasyQue team for an upgrade.'
        });
      }

      // Monthly cap = perDay * 30
      const perMonth = perDay * 30;
      const [m] = await db.query(`SELECT COUNT(*) AS c FROM bookings WHERE org_id = ? AND YEAR(booking_datetime)=YEAR(CURDATE()) AND MONTH(booking_datetime)=MONTH(CURDATE())`, [org_id]);
      const monthCount = m && m[0] ? Number(m[0].c || 0) : 0;

      if (monthCount >= perMonth) {
        return res.status(429).json({
          ok: false,
          error: 'Your booking limit is over as per your current plan, kindly contact EasyQue team for an upgrade.'
        });
      }

      next();
    } catch (e) { next(e); }
  };
}

module.exports = {
  requireAuth,
  requireSuperAdmin,
  loadOrg,
  enforceOrgAccess,
  enforceBookingLimits
};
