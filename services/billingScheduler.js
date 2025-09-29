// services/billingScheduler.js
const Razorpay = require('razorpay');
let db; try { db = require('../services/db'); } catch { db = require('../db'); }

const rzp = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || '',
  key_secret: process.env.RAZORPAY_KEY_SECRET || '',
});
const log = (...a)=>console.log('[BillingScheduler]',...a);
const err = (...a)=>console.error('[BillingScheduler]',...a);

async function getCharges(){
  try{
    const [rows] = await db.query('SELECT annual_fee, monthly_platform_fee_per_user, message_cost_per_booking FROM app_charges ORDER BY id DESC LIMIT 1');
    if (rows?.length) return {
      annual_fee: Number(rows[0].annual_fee)||1000,
      monthly_platform_fee_per_user: Number(rows[0].monthly_platform_fee_per_user)||150,
      message_cost_per_booking: Number(rows[0].message_cost_per_booking)||0.5,
    };
  }catch(_){}
  return { annual_fee:1000, monthly_platform_fee_per_user:150, message_cost_per_booking:0.5 };
}
function calcMonthly({ plan_mode, users_count, expected_bookings_per_day }, charges){
  const users=Math.max(1,Number(users_count)||1);
  const perDay=Math.max(0,Number(expected_bookings_per_day)||0);
  if (plan_mode==='semi') return charges.monthly_platform_fee_per_user * users;
  if (plan_mode==='full') return Math.round(charges.message_cost_per_booking * perDay * 30);
  return 0;
}
async function updateQty(subId, rupees){
  const qty = Math.max(1, Math.round(Number(rupees)||1));
  try{ await rzp.subscriptions.update(subId, { quantity: qty }); return true; }
  catch(e){ err('update qty failed', subId, e?.error || e?.message || e); return false; }
}
async function runOnce() {
  const charges = await getCharges();
  const [rows] = await db.query(`
    SELECT o.id AS org_id, o.plan_mode, COALESCE(o.users_count,1) AS users_count,
           COALESCE(o.expected_bookings_per_day,80) AS expected_bookings_per_day,
           b.rzp_subscription_id AS sub_id, b.monthly_amount_paise AS current_paise, b.status
      FROM organizations o
      JOIN org_billing b ON b.org_id=o.id
     WHERE b.rzp_subscription_id IS NOT NULL
  `);
  if (!rows.length){ log('no subs'); return; }
  let upd=0, ok=0, skip=0;
  for (const r of rows){
    if (r.plan_mode==='trial' || !r.sub_id){ skip++; continue; }
    const desired = calcMonthly(
      { plan_mode:r.plan_mode, users_count:r.users_count, expected_bookings_per_day:r.expected_bookings_per_day },
      charges
    );
    const desiredPaise = Math.max(0, Math.round(desired))*100;
    if (Math.abs((Number(r.current_paise)||0) - desiredPaise) < 1){ ok++; continue; }
    const done = await updateQty(r.sub_id, desired);
    if (done){
      await db.query('UPDATE org_billing SET monthly_amount_paise=? WHERE org_id=?', [desiredPaise, r.org_id]);
      upd++;
    } else skip++;
  }
  log(`reconcile: ok=${ok}, upd=${upd}, skip=${skip}`);
}
function msToNext(h=2,m=0,s=0){ const n=new Date(); const t=new Date(n); t.setHours(h,m,s,0); if (t<=n) t.setDate(t.getDate()+1); return t-n; }
let timer=null;
function scheduleNext(){
  const wait=msToNext(2,0,0);
  log(`next run in ${(wait/60000).toFixed(1)} min`);
  timer=setTimeout(async()=>{ try{ await runOnce(); }catch(e){ err('run fail', e?.message||e); } finally{ scheduleNext(); } }, wait);
}
module.exports = { start(){ setTimeout(()=>{ try{ scheduleNext(); }catch(e){ err('start fail', e?.message||e);} },1500); log('started 02:00 daily'); }, runOnce };

