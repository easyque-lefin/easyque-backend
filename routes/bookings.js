// routes/bookings.js — with items support

const express = require('express');
const dayjs = require('dayjs');
const router = express.Router();

const db = require('../services/db');
const { requireAuth } = require('../middleware/auth');
const { enforceOrgLimits } = require('../middleware/limits');

const LIVE_BASE_URL =
  process.env.LIVE_BASE_URL && process.env.LIVE_BASE_URL.startsWith('http')
    ? process.env.LIVE_BASE_URL
    : 'https://status.easyque.org/status.html';

const num = (x, d = 0) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
};

async function getTableColumns(table) {
  const [rows] = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ?`,
    [table]
  );
  return new Set(rows.map(r => r.column_name));
}

/* ---------- Create booking ---------- */
router.post('/', requireAuth, enforceOrgLimits || ((req,res,next)=>next()), async (req,res,next)=>{
  try {
    const b = req.body || {};
    const org_id = num(b.org_id);
    const user_name = (b.user_name || '').trim();
    const user_phone = (b.user_phone || '').trim();
    const assigned_user_id = b.assigned_user_id ? num(b.assigned_user_id) : null;
    if (!org_id || !user_name || !user_phone) {
      return res.status(400).json({ ok:false, error:'org_id, user_name, user_phone required' });
    }

    const now = dayjs();
    const booking_date = now.format('YYYY-MM-DD');
    const scheduled_at = b.scheduled_at && dayjs(b.scheduled_at).isValid()
      ? dayjs(b.scheduled_at).format('YYYY-MM-DD HH:mm:ss')
      : null;

    // next token
    const scopeClause = assigned_user_id ? 'AND assigned_user_id = ?' : 'AND assigned_user_id IS NULL';
    const params = assigned_user_id ? [org_id, booking_date, assigned_user_id] : [org_id, booking_date];
    const [maxRow] = await db.query(
      `SELECT COALESCE(MAX(token_number),0) AS max_token
         FROM bookings
        WHERE org_id = ? AND booking_date = ? ${scopeClause}`,
      params
    );
    const token_number = (maxRow[0]?.max_token || 0) + 1;

    const insertCols = [
      'org_id','user_name','user_phone',
      'assigned_user_id','booking_date','scheduled_at',
      'status','token_number','created_at'
    ];
    const insertVals = [
      org_id, user_name, user_phone,
      assigned_user_id, booking_date, scheduled_at,
      'pending', token_number, now.format('YYYY-MM-DD HH:mm:ss')
    ];

    const cols = await getTableColumns('bookings');
    if (cols.has('items') && b.items) { insertCols.push('items'); insertVals.push(JSON.stringify(b.items)); }
    if (cols.has('department') && b.department) { insertCols.push('department'); insertVals.push(String(b.department)); }
    if (cols.has('division') && b.division) { insertCols.push('division'); insertVals.push(String(b.division)); }
    if (cols.has('status_link')) {
      const status_link = `${LIVE_BASE_URL}?org_id=${org_id}&token=${token_number}&phone=${encodeURIComponent(user_phone)}`;
      insertCols.push('status_link'); insertVals.push(status_link);
    }

    const placeholders = insertCols.map(()=>'?').join(',');
    const [r] = await db.query(
      `INSERT INTO bookings (${insertCols.join(',')}) VALUES (${placeholders})`,
      insertVals
    );

    res.json({ ok:true, id:r.insertId, token_number });
  }catch(err){ next(err); }
});

/* ---------- Update booking ---------- */
router.patch('/:id', requireAuth, async (req,res,next)=>{
  try {
    const id = num(req.params.id);
    const body = req.body || {};
    if (!id) return res.status(400).json({ ok:false, error:'id required' });

    const editable = new Set([
      'user_name','user_phone','user_email','notes','notes_images',
      'assigned_user_id','status','scheduled_at','department','division','place','items'
    ]);

    const cols = await getTableColumns('bookings');
    const sets=[], params=[];
    for (const [c,v] of Object.entries(body)) {
      if (editable.has(c) && cols.has(c)) {
        sets.push(`${c}=?`);
        params.push(c==='items' ? JSON.stringify(v) : v);
      }
    }
    if (!sets.length) return res.json({ ok:true, updated:0 });

    params.push(id);
    const [r] = await db.query(`UPDATE bookings SET ${sets.join(', ')} WHERE id=?`, params);
    res.json({ ok:true, updated:r.affectedRows||0 });
  }catch(err){ next(err); }
});

/* ---------- Cancel + Get bookings unchanged ---------- */
router.post('/:id/cancel', requireAuth, async (req,res,next)=>{ /* keep */ });
router.get('/', requireAuth, async (req,res,next)=>{ /* keep */ });

module.exports = router;
module.exports.default = router;
