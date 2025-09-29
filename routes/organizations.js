// routes/organizations.js
const express = require('express');
const dayjs = require('dayjs');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../services/db');
const { requireAuth } = require('../middleware/auth');
const { requireAnyRole } = require('../middleware/roles');

const router = express.Router();

/* Uploads */
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const id = req.params.id || 'org';
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    cb(null, `org_${id}_banner_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

/* Helpers */
const qCols = `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`;
async function getCols(table){ const [rows] = await db.query(qCols, [table]); return new Set(rows.map(r=>r.COLUMN_NAME));}

/* CRUD (minimal) */
router.post('/', requireAuth, requireAnyRole('admin','organization_admin'), async (req,res,next)=>{
  try{
    const { name, address, map_url } = req.body || {};
    const [r] = await db.query(`INSERT INTO organizations (name, google_map_url) VALUES (?,?)`, [name || 'New Org', map_url || null]);
    res.json({ ok:true, id:r.insertId, org:{ id:r.insertId, name, google_map_url: map_url || null }});
  }catch(e){ next(e); }
});

router.get('/:id', requireAuth, requireAnyRole('admin','organization_admin','receptionist','assigned_user'), async (req,res,next)=>{
  try{
    const id = Number(req.params.id);
    const [rows] = await db.query(`SELECT * FROM organizations WHERE id=?`, [id]);
    if(!rows.length) return res.status(404).json({ ok:false, error:'org_not_found' });
    res.json({ ok:true, org: rows[0] });
  }catch(e){ next(e); }
});

/* Limits */
router.get('/:id/limits', requireAuth, requireAnyRole('admin','organization_admin'), async (req,res,next)=>{
  try{
    const id = Number(req.params.id);
    const [rows] = await db.query(`SELECT * FROM organizations WHERE id=?`, [id]);
    if(!rows.length) return res.status(404).json({ ok:false, error:'org_not_found' });
    res.json({ ok:true, limits: rows[0] });
  }catch(e){ next(e); }
});

router.post('/:id/limits', requireAuth, requireAnyRole('admin','organization_admin'), async (req,res,next)=>{
  try{
    const id = Number(req.params.id);
    const body = req.body || {};
    const allowed = new Set(['trial','semi','full']);
    if (!allowed.has(String(body.plan_mode))) {
      return res.status(400).json({ ok:false, error:'invalid_plan_mode' });
    }
    if (!['option1','option2'].includes(body.messaging_option)) {
      return res.status(400).json({ ok:false, error:'messaging_option required' });
    }

    const cols = await getCols('organizations');
    const sets = [], vals = [];
    const setIf = (c,v)=>{ if(cols.has(c) && typeof v!=='undefined'){ sets.push(`${c}=?`); vals.push(v);} };
    const setNullIf = (c)=>{ if(cols.has(c)){ sets.push(`${c}=NULL`); } };
    const setNowIf = (c)=>{ if(cols.has(c)){ sets.push(`${c}=NOW()`); } };

    setIf('messaging_option', body.messaging_option);
    setIf('users_limit', body.users_limit ?? 10);
    setIf('daily_booking_limit', body.daily_booking_limit ?? 200);
    setIf('monthly_booking_limit', body.monthly_booking_limit ?? 5000);
    setIf('expected_bookings_per_day', body.expected_bookings_per_day ?? 80);

    if (body.plan_mode === 'trial') {
      const days = Number(body.trial_days) || 7;
      setIf('plan_mode','trial');
      setNowIf('trial_starts_at');
      if (cols.has('trial_ends_at')) { sets.push(`trial_ends_at = DATE_ADD(NOW(), INTERVAL ? DAY)`); vals.push(days); }
      await db.query(
        `INSERT INTO org_billing (org_id, plan_mode, status)
           VALUES (?, 'trial', 'trial')
         ON DUPLICATE KEY UPDATE plan_mode='trial', status='trial'`,
        [id]
      );
    } else {
      setIf('plan_mode', body.plan_mode);
      setNullIf('trial_starts_at');
      setNullIf('trial_ends_at');
      await db.query(
        `INSERT INTO org_billing (org_id, plan_mode, status)
           VALUES (?, ?, 'none')
         ON DUPLICATE KEY UPDATE plan_mode=VALUES(plan_mode)`,
        [id, body.plan_mode]
      );
    }

    vals.push(id);
    await db.query(`UPDATE organizations SET ${sets.join(', ')} WHERE id = ?`, vals);
    const [rows] = await db.query(`SELECT * FROM organizations WHERE id=?`, [id]);
    res.json({ ok:true, limits: rows[0] || null });
  }catch(e){ next(e); }
});

/* Banner URL */
router.put('/:id/banner-url', requireAuth, requireAnyRole('admin','organization_admin'), async (req,res,next)=>{
  try{
    const id = Number(req.params.id);
    const url = req.body?.org_banner_url || req.body?.banner_url;
    if (!url) return res.status(400).json({ ok:false, error:'org_banner_url required' });
    await db.query(`UPDATE organizations SET org_banner_url = ? WHERE id=?`, [url, id]);
    res.json({ ok:true, org_banner_url: url });
  }catch(e){ next(e); }
});

/* Banner upload */
router.put('/:id/banner',
  requireAuth, requireAnyRole('admin','organization_admin'), upload.single('banner'),
  async (req,res,next)=>{
    try{
      const id = Number(req.params.id);
      if (!req.file) return res.status(400).json({ ok:false, error:'file "banner" required' });
      const publicUrl = `${process.env.APP_URL || 'http://localhost:5008'}/uploads/${path.basename(req.file.path)}`;
      await db.query(`UPDATE organizations SET org_banner_url = ? WHERE id=?`, [publicUrl, id]);
      res.json({ ok:true, org_banner_url: publicUrl });
    }catch(e){ next(e); }
  }
);

/* Map setter */
router.post('/:id/map', requireAuth, requireAnyRole('admin','organization_admin'), async (req,res,next)=>{
  try{
    const id = Number(req.params.id);
    const url = req.body?.google_map_url || req.body?.map_url;
    if (!url) return res.status(400).json({ ok:false, error:'google_map_url required' });
    await db.query(`UPDATE organizations SET google_map_url = ? WHERE id=?`, [url, id]);
    res.json({ ok:true, google_map_url: url });
  }catch(e){ next(e); }
});

module.exports = router;
module.exports.default = router;



