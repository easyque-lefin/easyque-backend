// routes/payments.js — aligns with updated schema
// Uses org_billing columns (initial_amount_paise, monthly_amount_paise, initial_paid_at,
// rzp_order_id, rzp_payment_id, rzp_subscription_id, status) and organizations.subscription_status

const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');

let db; try { db = require('../services/db'); } catch { db = require('../db'); }
const router = express.Router();

const rzp = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || '',
  key_secret: process.env.RAZORPAY_KEY_SECRET || '',
});

const num = (x,d=0)=>{ const n=Number(x); return Number.isFinite(n)?n:d; };

async function getCols(table){
  const [rows]=await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name=?`, [table]
  );
  return new Set(rows.map(r => String(r.column_name)));
}

/* ---------- Helper: upsert into org_billing only for existing columns ---------- */
async function upsertOrgBilling(payload){
  const obCols = await getCols('org_billing');
  const cols=[], vals=[], updates=[];
  function push(c,v){ if (obCols.has(c) && v!==undefined){ cols.push(c); vals.push(v); updates.push(`${c}=VALUES(${c})`);} }

  push('org_id', payload.org_id);
  push('plan_mode', payload.plan_mode);
  push('initial_amount_paise', payload.initial_amount_paise);
  push('monthly_amount_paise', payload.monthly_amount_paise);
  push('initial_paid_at', payload.initial_paid_at);
  push('rzp_order_id', payload.rzp_order_id);
  push('rzp_payment_id', payload.rzp_payment_id);
  push('rzp_subscription_id', payload.rzp_subscription_id);
  push('status', payload.status);

  if (!cols.length) return;
  const sql = `INSERT INTO org_billing (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})
               ON DUPLICATE KEY UPDATE ${updates.join(',')}`;
  await db.query(sql, vals);
}

/* ---------- Pricing preview (semi/full) ---------- */
router.get('/preview', async (req,res,next)=>{
  try{
    const mode = String(req.query.mode || '').toLowerCase(); // 'semi' | 'full'
    const users = Math.max(1, num(req.query.users_count, 1));
    const perDay = Math.max(1, num(req.query.expected_bookings_per_day, 80));

    // simple example inputs; replace with your fee model if stored elsewhere
    let fees, result;
    if (mode === 'full') {
      // full automation: annual + monthly per user (example numbers; adjust if you store in DB)
      const annual = 0;                     // use org_billing.amount_plan_paise/option_selected if desired
      const monthlyPerUser = 0;
      const base = annual + (monthlyPerUser * users);
      fees = { annual, monthlyPerUser };
      result = { base, tax: 0, total: base };
    } else if (mode === 'semi') {
      // semi automation: per-booking messaging cost * expected_bookings_per_day * 30
      const perBooking = 0;
      const base = Math.round(perBooking * perDay * 30);
      fees = { perBooking, expected_per_day: perDay };
      result = { base, tax: 0, total: base };
    } else {
      return res.status(400).json({ ok:false, error:'mode must be "semi"|"full"' });
    }
    res.json({ ok:true, inputs:{ mode, users_count:users, expected_bookings_per_day:perDay }, fees, result });
  }catch(e){ next(e); }
});

/* ---------- Create order for initial payment ---------- */
router.post('/create-order', async (req,res,next)=>{
  try{
    const orgId = num(req.body.org_id);
    const paise = num(req.body.amount_paise);
    const plan_mode = String(req.body.plan_mode || '').toLowerCase(); // 'semi' | 'full'
    if (!orgId || paise <= 0 || !['semi','full'].includes(plan_mode)) {
      return res.status(400).json({ ok:false, error:'org_id, amount_paise, plan_mode required' });
    }

    const order = await rzp.orders.create({
      amount: paise,
      currency: 'INR',
      receipt: `org_${orgId}_${Date.now()}`,
      payment_capture: 1
    });

    await upsertOrgBilling({
      org_id: orgId,
      plan_mode,
      initial_amount_paise: paise,
      rzp_order_id: order.id,
      status: 'pending'
    });

    res.json({ ok:true, order });
  }catch(e){ next(e); }
});

/* ---------- Verify payment for initial order ---------- */
router.post('/verify-order', async (req,res,next)=>{
  try{
    const orgId = num(req.body.org_id);
    const razorpay_order_id = String(req.body.razorpay_order_id || '');
    const razorpay_payment_id = String(req.body.razorpay_payment_id || '');
    const razorpay_signature = String(req.body.razorpay_signature || '');
    if (!orgId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ ok:false, error:'org_id, order_id, payment_id, signature required' });
    }

    const payload = `${razorpay_order_id}|${razorpay_payment_id}`;
    const h = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '');
    h.update(payload);
    if (h.digest('hex') !== razorpay_signature) {
      return res.status(400).json({ ok:false, error:'signature_mismatch' });
    }

    await upsertOrgBilling({
      org_id: orgId,
      rzp_order_id: razorpay_order_id,
      rzp_payment_id: razorpay_payment_id,
      initial_paid_at: new Date(),
      status: 'paid'
    });

    res.json({ ok:true, verified:true });
  }catch(e){ next(e); }
});

/* ---------- Create subscription (autopay starts after 30 days) ---------- */
router.post('/create-subscription', async (req,res,next)=>{
  try{
    const orgId = num(req.body.org_id);
    const plan_mode = String(req.body.plan_mode || '').toLowerCase(); // 'semi' | 'full'
    const monthly_amount_paise = num(req.body.monthly_amount_paise, 0);
    if (!orgId || !['semi','full'].includes(plan_mode)) {
      return res.status(400).json({ ok:false, error:'org_id and plan_mode required' });
    }

    // create a monthly subscription plan on Razorpay (you might already have a plan_id)
    // for demo: we create subscription directly with amount charge at cycle
    const sub = await rzp.subscriptions.create({
      plan_id: req.body.plan_id, // if you already provisioned a plan; else set addons/notes accordingly
      customer_notify: 1,
      quantity: 1,
      total_count: 120,
      notes: { org_id: String(orgId), plan_mode },
      start_at: Math.floor((Date.now()/1000) + (30*24*60*60)) // starts after ~30 days
    });

    await upsertOrgBilling({
      org_id: orgId,
      plan_mode,
      monthly_amount_paise: monthly_amount_paise || undefined,
      rzp_subscription_id: sub.id,
      status: 'active'
    });

    // Also reflect on organizations.subscription_status if present
    const orgCols = await getCols('organizations');
    if (orgCols.has('subscription_status')) {
      await db.query(`UPDATE organizations SET subscription_status='active' WHERE id=?`, [orgId]);
    }

    res.json({ ok:true, subscription: sub });
  }catch(e){ next(e); }
});

module.exports = router;
module.exports.default = router;

