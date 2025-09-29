// routes/organizations.js — aligns with updated schema
// - Uses organizations.subscription_status
// - Uses org_billing columns: initial_amount_paise, monthly_amount_paise, initial_paid_at,
//   rzp_order_id, rzp_payment_id, rzp_subscription_id, status (enum)

const express = require('express');
const dayjs = require('dayjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const db = require('../services/db');
const { requireAuth } = require('../middleware/auth');
const { requireAnyRole } = require('../middleware/roles');

const router = express.Router();

/* ---------- uploads (banner/map etc.) ---------- */
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename:   (_, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `org_${Date.now()}${ext || '.bin'}`);
  }
});
const upload = multer({ storage });

async function getCols(table) {
  const [rows] = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [table]
  );
  return new Set(rows.map(r => String(r.column_name)));
}
function num(x, d = 0) { const n = Number(x); return Number.isFinite(n) ? n : d; }

/* ---------- GET /organizations/:id ---------- */
router.get('/:id', requireAuth, requireAnyRole('admin','organization_admin','receptionist','assigned_user'), async (req,res,next)=>{
  try{
    const id = num(req.params.id);
    const [rows] = await db.query(`SELECT * FROM organizations WHERE id=?`, [id]);
    res.json({ ok:true, org: rows[0] || null });
  }catch(e){ next(e); }
});

/* ---------- PATCH /organizations/:id (basic details) ---------- */
router.patch('/:id', requireAuth, requireAnyRole('admin','organization_admin'), async (req,res,next)=>{
  try{
    const id = num(req.params.id);
    const body = req.body || {};
    const editable = new Set([
      'name','location','services','photo',
      'map_url','google_map_url','google_review_url',
      'users_limit','users_count',
      'expected_bookings_per_day','daily_booking_limit','monthly_booking_limit','monthly_expected_bookings',
      'plan_mode', 'subscription_status', // allowed but validated below
      'org_banner_url','banner_url'
    ]);
    const cols = await getCols('organizations');
    const sets = [], vals = [];

    function setIf(c, v) { if (editable.has(c) && cols.has(c)) { sets.push(`${c}=?`); vals.push(v); } }

    // Guard values
    if (body.plan_mode && !['trial','semi','full'].includes(String(body.plan_mode))) {
      return res.status(400).json({ ok:false, error:'invalid_plan_mode' });
    }
    if (body.subscription_status && !['active','paused','canceled','past_due', null].includes(body.subscription_status)) {
      return res.status(400).json({ ok:false, error:'invalid_subscription_status' });
    }

    for (const [k,v] of Object.entries(body)) setIf(k, v);

    if (!sets.length) return res.json({ ok:true, updated:0 });

    vals.push(id);
    const [r] = await db.query(`UPDATE organizations SET ${sets.join(', ')} WHERE id=?`, vals);
    res.json({ ok:true, updated: r.affectedRows || 0 });
  }catch(e){ next(e); }
});

/* ---------- POST /organizations/:id/upload (banner/map/review URLs) ---------- */
router.post('/:id/upload', requireAuth, requireAnyRole('admin','organization_admin'), upload.single('file'), async (req,res,next)=>{
  try{
    const id = num(req.params.id);
    const type = (req.body?.type || '').trim(); // 'banner' | 'photo'
    if (!req.file) return res.status(400).json({ ok:false, error:'file_required' });

    const url = `/uploads/${req.file.filename}`;
    let col = null;
    if (type === 'banner') col = 'org_banner_url';
    else if (type === 'photo') col = 'photo';
    else col = 'banner_url';

    const cols = await getCols('organizations');
    if (!cols.has(col)) return res.status(400).json({ ok:false, error:`column_${col}_missing` });

    await db.query(`UPDATE organizations SET ${col}=? WHERE id=?`, [url, id]);
    res.json({ ok:true, [col]: url });
  }catch(e){ next(e); }
});

/* ---------- POST /organizations/:id/links (map/review urls via JSON) ---------- */
router.post('/:id/links', requireAuth, requireAnyRole('admin','organization_admin'), async (req,res,next)=>{
  try{
    const id = num(req.params.id);
    const body = req.body || {};
    const cols = await getCols('organizations');
    const sets=[], vals=[];

    function setIf(c) { if (body[c] && cols.has(c)) { sets.push(`${c}=?`); vals.push(String(body[c])); } }

    setIf('map_url');
    setIf('google_map_url');
    setIf('google_review_url');
    if (!sets.length) return res.status(400).json({ ok:false, error:'no_valid_fields' });
    vals.push(id);

    await db.query(`UPDATE organizations SET ${sets.join(', ')} WHERE id=?`, vals);
    res.json({ ok:true });
  }catch(e){ next(e); }
});

/* ---------- POST /organizations/:id/limits (plan & quotas) ---------- */
router.post('/:id/limits', requireAuth, requireAnyRole('admin','organization_admin'), async (req,res,next)=>{
  try{
    const id = num(req.params.id);
    const body = req.body || {};
    const allowedPlan = new Set(['trial','semi','full']);
    if (!allowedPlan.has(String(body.plan_mode))) {
      return res.status(400).json({ ok:false, error:'invalid_plan_mode' });
    }

    const orgCols = await getCols('organizations');
    const sets=[], vals=[];
    function setIf(c, v) { if (orgCols.has(c)) { sets.push(`${c}=?`); vals.push(v); } }
    function setNullIf(c){ if (orgCols.has(c)) { sets.push(`${c}=NULL`); } }
    function setNowIf(c){ if (orgCols.has(c)) { sets.push(`${c}=NOW()`); } }

    // messaging option (if present)
    if (orgCols.has('messaging_option') && body.messaging_option) {
      setIf('messaging_option', body.messaging_option);
    }

    // plan_mode
    setIf('plan_mode', body.plan_mode);

    // trial handling
    if (body.plan_mode === 'trial') {
      const days = Math.max(1, Math.min(Number(body.trial_days || 7), 30));
      setNowIf('trial_starts_at');
      if (orgCols.has('trial_ends_at')) { sets.push(`trial_ends_at = DATE_ADD(NOW(), INTERVAL ? DAY)`); vals.push(days); }

      // seed org_billing status=trial
      const obCols = await getCols('org_billing');
      if (obCols.has('org_id')) {
        const cols = ['org_id'];
        const qv   = ['?'];
        const up   = [];
        const v    = [id];

        if (obCols.has('plan_mode')) { cols.push('plan_mode'); qv.push('?'); v.push('trial'); up.push(`plan_mode=VALUES(plan_mode)`); }
        if (obCols.has('status'))    { cols.push('status');    qv.push('?'); v.push('trial'); up.push(`status=VALUES(status)`); }

        const sql = `INSERT INTO org_billing (${cols.join(',')}) VALUES (${qv.join(',')})
                     ON DUPLICATE KEY UPDATE ${up.join(', ')}`;
        await db.query(sql, v);
      }
    } else {
      // switching to semi/full clears trial dates
      setNullIf('trial_starts_at');
      setNullIf('trial_ends_at');

      const obCols = await getCols('org_billing');
      if (obCols.has('org_id')) {
        const cols = ['org_id'];
        const qv   = ['?'];
        const up   = [];
        const v    = [id];

        if (obCols.has('plan_mode')) { cols.push('plan_mode'); qv.push('?'); v.push(body.plan_mode); up.push(`plan_mode=VALUES(plan_mode)`); }
        if (obCols.has('status'))    { cols.push('status');    qv.push('?'); v.push('none');         up.push(`status=VALUES(status)`); }

        const sql = `INSERT INTO org_billing (${cols.join(',')}) VALUES (${qv.join(',')})
                     ON DUPLICATE KEY UPDATE ${up.join(', ')}`;
        await db.query(sql, v);
      }
    }

    vals.push(id);
    await db.query(`UPDATE organizations SET ${sets.join(', ')} WHERE id = ?`, vals);
    const [rows] = await db.query(`SELECT * FROM organizations WHERE id=?`, [id]);
    res.json({ ok:true, limits: rows[0] || null });
  }catch(e){ next(e); }
});

module.exports = router;
module.exports.default = router;



