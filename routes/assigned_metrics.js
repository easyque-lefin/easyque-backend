// routes/assigned_metrics.js
const express = require('express');
const dayjs = require('dayjs');
const db = require('../services/db');
const { requireAuth } = require('../middleware/auth');
const { requireAnyRole } = require('../middleware/roles');

const router = express.Router();

async function upsertToday({ org_id, assigned_user_id, booking_date }){
  await db.query(
    `INSERT INTO assigned_live_metrics (org_id, assigned_user_id, booking_date, updated_at)
     VALUES (?,?,?,NOW())
     ON DUPLICATE KEY UPDATE updated_at=NOW()`,
    [org_id, assigned_user_id, booking_date]
  );
}

router.post('/assigned-metrics/:assigned_user_id/break',
  requireAuth, requireAnyRole('admin','organization_admin','receptionist','assigned_user'),
  async (req,res,next)=>{
    try{
      const assigned_user_id = Number(req.params.assigned_user_id);
      const org_id = Number(req.body?.org_id);
      if (!org_id || !assigned_user_id) return res.status(400).json({ ok:false, error:'org_id and assigned_user_id required' });
      const d = req.body?.break_until ? dayjs(req.body.break_until) : dayjs().add(15,'minute');
      if (!d.isValid()) return res.status(400).json({ ok:false, error:'invalid break_until' });
      const date = dayjs().format('YYYY-MM-DD');
      await upsertToday({ org_id, assigned_user_id, booking_date: date });
      await db.query(
        'UPDATE assigned_live_metrics SET break_until=? WHERE org_id=? AND assigned_user_id=? AND booking_date=?',
        [d.format('YYYY-MM-DD HH:mm:ss'), org_id, assigned_user_id, date]
      );
      res.json({ ok:true, break_until: d.toISOString() });
    }catch(e){ next(e); }
  });

router.post('/assigned-metrics/:assigned_user_id/resume',
  requireAuth, requireAnyRole('admin','organization_admin','receptionist','assigned_user'),
  async (req,res,next)=>{
    try{
      const assigned_user_id = Number(req.params.assigned_user_id);
      const org_id = Number(req.body?.org_id);
      const date = dayjs().format('YYYY-MM-DD');
      await upsertToday({ org_id, assigned_user_id, booking_date: date });
      await db.query(
        'UPDATE assigned_live_metrics SET break_until=NULL WHERE org_id=? AND assigned_user_id=? AND booking_date=?',
        [org_id, assigned_user_id, date]
      );
      res.json({ ok:true, break_until: null });
    }catch(e){ next(e); }
  });

router.get('/assigned-metrics/:assigned_user_id/today',
  requireAuth, requireAnyRole('admin','organization_admin','receptionist','assigned_user'),
  async (req,res,next)=>{
    try{
      const assigned_user_id = Number(req.params.assigned_user_id);
      const org_id = Number(req.query?.org_id);
      const date = dayjs().format('YYYY-MM-DD');
      const [rows] = await db.query(
        'SELECT * FROM assigned_live_metrics WHERE org_id=? AND assigned_user_id=? AND booking_date=?',
        [org_id, assigned_user_id, date]
      );
      res.json({ ok:true, metrics: rows[0] || null });
    }catch(e){ next(e); }
  });

module.exports = router;
module.exports.default = router;
