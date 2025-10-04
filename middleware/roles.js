// middleware/roles.js
const db = require('../services/db');

// --- Simple role checks (unchanged API) ---
function requireRole(role) {
  return (req, res, next) => {
    const r = req.user?.role;
    if (r === role) return next();
    return res.status(403).json({ ok: false, error: 'forbidden' });
  };
}

function requireAnyRole(...roles) {
  const allow = new Set(roles);
  return (req, res, next) => {
    const r = req.user?.role;
    if (r && allow.has(r)) return next();
    return res.status(403).json({ ok: false, error: 'forbidden' });
  };
}

// ---------- helpers for schema-safe checks ----------
async function getCols(table) {
  try {
    const [rows] = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ?`,
      [table]
    );
    return new Set(rows.map(r => String(r.column_name)));
  } catch {
    return new Set();
  }
}

async function tableExists(table) {
  try {
    const [rows] = await db.query(
      `SELECT 1
         FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = ?`,
      [table]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * ensureOrgAccessParam(paramName='id')
 *
 * Allows:
 *  - admin: any org
 *  - organization_admin / receptionist / assigned_user:
 *      a) JWT org_id matches the requested org, OR
 *      b) (org_admin only) they created the org (organizations.created_by = req.user.id), OR
 *      c) membership exists in user_orgs (user_id, org_id)
 *
 * Resolves org id from:
 *   - req.params[paramName] OR req.body.org_id OR req.query.org_id
 */
function ensureOrgAccessParam(paramName = 'id') {
  return async (req, res, next) => {
    const orgId =
      Number(req.params?.[paramName]) ||
      Number(req.body?.org_id) ||
      Number(req.query?.org_id) ||
      0;

    if (!orgId) {
      return res.status(400).json({ ok: false, error: 'org_id required' });
    }

    const u = req.user || {};
    const role = u.role;

    // Admin bypass
    if (role === 'admin') return next();

    // Only these roles can be scoped to an org
    const orgScopedRoles = new Set([
      'organization_admin',
      'receptionist',
      'assigned_user',
    ]);
    if (!orgScopedRoles.has(role)) {
      return res.status(403).json({ ok: false, error: 'forbidden_org_scope' });
    }

    // (a) JWT org_id match
    if (Number(u.org_id) === orgId) return next();

    // (b) organization_admin who created the org (if column exists)
    if (role === 'organization_admin' && u.id) {
      const orgCols = await getCols('organizations');
      if (orgCols.has('created_by')) {
        const [rows] = await db.query(
          `SELECT 1 FROM organizations WHERE id = ? AND created_by = ? LIMIT 1`,
          [orgId, u.id]
        );
        if (rows.length) return next();
      }
    }

    // (c) membership in user_orgs (if table/columns exist)
    if (await tableExists('user_orgs')) {
      const cols = await getCols('user_orgs');
      if (cols.has('user_id') && cols.has('org_id') && u.id) {
        const [rows] = await db.query(
          `SELECT 1 FROM user_orgs WHERE user_id = ? AND org_id = ? LIMIT 1`,
          [u.id, orgId]
        );
        if (rows.length) return next();
      }
    }

    // Otherwise, forbidden
    return res.status(403).json({ ok: false, error: 'forbidden_org_scope' });
  };
}

module.exports = { requireRole, requireAnyRole, ensureOrgAccessParam };
