// routes/payments.js
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

async function getCharges() {
  try {
    const [rows] = await db.query(
      'SELECT annual_fee, monthly_platform_fee_per_user, message_cost_per_booking FROM app_charges ORDER BY id DESC LIMIT 1'
    );
    if (rows && rows.length) {
      return {
        annual_fee: num(rows[0].annual_fee, 1000),
        monthly_platform_fee_per_user: num(rows[0].monthly_platform_fee_per_user, 150),
        message_cost_per_booking: num(rows[0].message_cost_per_booking, 0.5),
      };
    }
  } catch (_) {}
  return { annual_fee:1000, monthly_platform_fee_per_user:150, message_cost_per_booking:0.5 };
}

async function ensure1InrMonthlyPlan() {
  if (!ensure1InrMonthlyPlan.cachedPlanId) {
    try {
      const plans = await rzp.plans.all({ count: 10 });
      const found = (plans.items || []).find(p => p.period === 'monthly' && p.interval === 1 && p.item?.amount === 100);
      if (found) ensure1InrMonthlyPlan.cachedPlanId = found.id;
    } catch (_) {}
    if (!ensure1InrMonthlyPlan.cachedPlanId) {
      const plan = await rzp.plans.create({
        period:'monthly', interval:1,
        item:{ name:'EasyQue Monthly (₹1 base)', amount:100, currency:'INR' }
      });
      ensure1InrMonthlyPlan.cachedPlanId = plan.id;
    }
  }
  return ensure1InrMonthlyPlan.cachedPlanId;
}

async function upsertOrgBilling(payload) {
  const {
    org_id, plan_mode, initial_amount_paise=null, monthly_amount_paise=null,
    initial_paid_at=null, rzp_order_id=null, rzp_payment_id=null, rzp_subscription_id=null, status=null
  } = payload;

  const cols=[], vals=[], updates=[];
  function push(c,v){ if(v!==undefined && v!==null){ cols.push(c); vals.push(v); updates.push(`${c}=VALUES(${c})`);} }
  push('org_id',org_id); push('plan_mode',plan_mode);
  push('initial_amount_paise',initial_amount_paise); push('monthly_amount_paise',monthly_amount_paise);
  push('rzp_order_id',rzp_order_id); push('rzp_payment_id',rzp_payment_id);
  push('rzp_subscription_id',rzp_subscription_id); push('status',status);
  if (initial_paid_at){ cols.push('initial_paid_at'); vals.push(initial_paid_at); updates.push('initial_paid_at=VALUES(initial_paid_at)'); }
  if (!cols.length) return;
  const sql = `INSERT INTO org_billing (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})
               ON DUPLICATE KEY UPDATE ${updates.join(',')}`;
  await db.query(sql, vals);
}

/* Calc */
router.post('/calc', async (req,res,next)=>{
  try{
    const { mode, users_count=1, expected_bookings_per_day=80 } = req.body || {};
    if (!['semi','full'].includes(mode)) return res.status(400).json({ ok:false, error:'mode must be "semi"|"full"' });
    const charges = await getCharges();
    const users = num(users_count,1);
    const perDay = num(expected_bookings_per_day,80);

    let result={base:0,tax:0,total:0}, fees={};
    if (mode==='semi'){
      fees = { annual: charges.annual_fee, monthlyPerUser: charges.monthly_platform_fee_per_user };
      const base = charges.annual_fee + (charges.monthly_platform_fee_per_user * users);
      result = { base, tax:0, total: base };
    } else {
      const totalMsg = Math.round(charges.message_cost_per_booking * perDay * 30);
      fees = { perBooking: charges.message_cost_per_booking, expected_per_day: perDay };
      result = { base: totalMsg, tax:0, total: totalMsg };
    }
    res.json({ ok:true, inputs:{ mode, users_count:users, expected_bookings_per_day:perDay }, fees, result });
  }catch(e){ next(e); }
});

/* Create order (initial payment) */
router.post('/create-order', async (req,res,next)=>{
  try{
    const { org_id, amount_in_paise, notes={} } = req.body || {};
    const orgId = num(org_id), paise = num(amount_in_paise);
    if (!orgId || paise<=0) return res.status(400).json({ ok:false, error:'org_id and positive amount required' });
    const order = await rzp.orders.create({
      amount: paise, currency:'INR', receipt:`org_${orgId}_${Date.now()}`, payment_capture:1, notes
    });
    await upsertOrgBilling({ org_id: orgId, initial_amount_paise: paise, rzp_order_id: order.id, status:'pending' });
    res.json({ ok:true, order });
  }catch(e){ next(e); }
});

/* Verify (after checkout) */
router.post('/verify', async (req,res,next)=>{
  try{
    const { org_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    const orgId = num(org_id);
    if (!orgId || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
      return res.status(400).json({ ok:false, error:'org_id, order_id, payment_id, signature required' });

    const h = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '');
    h.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    if (h.digest('hex') !== razorpay_signature) return res.status(400).json({ ok:false, error:'signature_mismatch' });

    const paidAt = new Date();
    await upsertOrgBilling({
      org_id: orgId, initial_paid_at: paidAt,
      rzp_order_id: razorpay_order_id, rzp_payment_id: razorpay_payment_id, status:'paid'
    });
    res.json({ ok:true, paid_at: paidAt.toISOString() });
  }catch(e){ next(e); }
});

/* Start subscription (autopay begins 30 days after initial) */
router.post('/start-subscription', async (req,res,next)=>{
  try{
    const { org_id, plan_mode, users_count=1, expected_bookings_per_day=80, initial_paid_at } = req.body || {};
    const orgId = num(org_id);
    if (!orgId || !['semi','full'].includes(plan_mode)) return res.status(400).json({ ok:false, error:'org_id and plan_mode required' });
    const charges = await getCharges();

    let monthlyRupees=0;
    if (plan_mode==='semi') monthlyRupees = num(charges.monthly_platform_fee_per_user,150) * num(users_count,1);
    else monthlyRupees = Math.round(num(charges.message_cost_per_booking,0.5) * num(expected_bookings_per_day,80) * 30);
    const monthlyPaise = monthlyRupees * 100;

    const planId = await ensure1InrMonthlyPlan();
    const baseTs = initial_paid_at ? new Date(initial_paid_at).getTime() : Date.now();
    const startAtUnix = Math.floor((baseTs + 30*24*60*60*1000) / 1000);

    const sub = await rzp.subscriptions.create({
      plan_id: planId,
      quantity: Math.max(1, Math.round(monthlyRupees)),
      total_count: 0,
      start_at: startAtUnix,
      notes: { org_id: String(orgId), plan_mode }
    });

    await upsertOrgBilling({
      org_id: orgId, plan_mode, monthly_amount_paise: monthlyPaise,
      rzp_subscription_id: sub.id, status:'active'
    });

    try {
      await db.query(
        'UPDATE organizations SET plan_mode=?, users_limit=COALESCE(users_limit, ?), expected_bookings_per_day=COALESCE(expected_bookings_per_day, ?) WHERE id=?',
        [plan_mode, num(users_count,1), num(expected_bookings_per_day,80), orgId]
      );
    } catch {}

    res.json({ ok:true, subscription: sub });
  }catch(e){ next(e); }
});

module.exports = router;
module.exports.default = router;

