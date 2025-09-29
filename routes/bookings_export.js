// routes/bookings_export.js
const express = require('express');
const dayjs = require('dayjs');
const db = require('../services/db');
const { requireAuth } = require('../middleware/auth');
const { requireAnyRole } = require('../middleware/roles');

const router = express.Router();

router.get('/export', requireAuth, requireAnyRole('admin','organization_admin'), async (req,res,next)=>{
  try{
    const org_id = Number(req.query.org_id);
    if (!org_id) return res.status(400).send('org_id required');

    const from = req.query.from;
    const to   = req.query.to;
    const date = req.query.date || dayjs().format('YYYY-MM-DD');

    let sql = `SELECT id, org_id, user_name, user_phone, department, assigned_user_id,
                      booking_date, booking_time, COALESCE(token_number, token_no) AS token,
                      booking_number, status, created_at
                 FROM bookings WHERE org_id=?`;
    const params=[org_id];
    if (from && to){ sql += ' AND booking_date BETWEEN ? AND ?'; params.push(from,to); }
    else { sql += ' AND booking_date = ?'; params.push(date); }
    sql += ' ORDER BY booking_date ASC, id ASC';

    const [rows] = await db.query(sql, params);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bookings_${org_id}.csv"`);
    const header = ['id','org_id','user_name','user_phone','department','assigned_user_id','booking_date','booking_time','token','booking_number','status','created_at'];
    res.write(header.join(',')+'\n');
    for (const r of rows) {
      const line = header.map(k=>{
        const v = r[k] ?? '';
        const s = String(v).replace(/"/g,'""');
        return /[",\n]/.test(s) ? `"${s}"` : s;
      }).join(',');
      res.write(line+'\n');
    }
    res.end();
  }catch(e){ next(e); }
});

module.exports = router;
module.exports.default = router;
