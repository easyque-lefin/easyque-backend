// middleware/roles.js
function requireRole(role) {
  return (req, res, next) => {
    const r = req.user?.role;
    if (r === role) return next();
    return res.status(403).json({ ok:false, error:'forbidden' });
  };
}
function requireAnyRole(...roles) {
  const allow = new Set(roles);
  return (req, res, next) => {
    const r = req.user?.role;
    if (r && allow.has(r)) return next();
    return res.status(403).json({ ok:false, error:'forbidden' });
  };
}
function ensureOrgAccessParam(paramName='id') {
  return (req, res, next) => {
    const orgId = Number(req.params?.[paramName] || req.body?.org_id || req.query?.org_id);
    if (!orgId) return res.status(400).json({ ok:false, error:'org_id required' });
    const u = req.user || {};
    if (u.role === 'admin') return next();
    if (u.role === 'organization_admin' && Number(u.org_id) === orgId) return next();
    return res.status(403).json({ ok:false, error:'forbidden_org_scope' });
  };
}
module.exports = { requireRole, requireAnyRole, ensureOrgAccessParam };
