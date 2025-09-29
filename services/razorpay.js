// services/razorpay.js
const Razorpay = require('razorpay');
const db = require('./db');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

/**
 * Ensure a ₹1 monthly plan exists.
 * If env RZP_PLAN_1INR_MONTHLY_ID is set, it will be used; else we create one and log the id.
 */
async function ensure1InrMonthlyPlan() {
  if (process.env.RZP_PLAN_1INR_MONTHLY_ID) return process.env.RZP_PLAN_1INR_MONTHLY_ID;

  // try to find a suitable plan by name
  const all = await razorpay.plans.all({ count: 100 });
  const existing = all.items.find(p => p.item?.name === 'EasyQue 1 INR Monthly' && p.period === 'monthly' && p.interval === 1);
  if (existing) return existing.id;

  const created = await razorpay.plans.create({
    period: 'monthly',
    interval: 1,
    item: { name: 'EasyQue 1 INR Monthly', amount: 100, currency: 'INR' }
  });

  console.log('[Razorpay] created 1 INR monthly plan:', created.id);
  return created.id;
}

module.exports = { razorpay, ensure1InrMonthlyPlan };

