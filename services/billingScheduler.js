// services/billingScheduler.js
// Daily cron: on each org's billing_cycle_day, compute charge based on current fees/settings and create a new order.

require('dotenv').config();
const cron = require('node-cron');
const db = require('./db');
const { createOrder } = require('./razorpay');

function asNumber(x, def = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}

async function getFees() {
  const [rows] = await db.query(`SELECT \`key\`, \`value\` FROM fee_settings`);
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  return {
    annual: asNumber(map['option1.annual_fee'], 0),
    monthlyPerUser: asNumber(map['option1.monthly_per_user'], 0),
    msgCost: asNumber(map['option2.message_cost'], 1),
    taxPct: asNumber(map['tax.percent'], 0)
  };
}

async function chargeOrg(org) {
  const fees = await getFees();

  let base = 0;
  if (org.plan_mode === 'semi') {
    base = fees.monthlyPerUser * asNumber(org.users_count || 1, 1);
  } else {
    const perDay = asNumber(org.expected_bookings_per_day || 0, 0);
    base = fees.msgCost * (perDay * 30);
  }
  const tax = Math.round((base * fees.taxPct) / 100);
  const total = base + tax;

  if (total <= 0) return;

  const order = await createOrder({
    amountPaise: Math.round(total * 100),
    currency: 'INR',
    notes: { org_id: String(org.id), reason: 'cycle' }
  });

  await db.query(
    `INSERT INTO billing_records (org_id, amount, tax, total, cycle_date, created_at)
     VALUES (?, ?, ?, ?, CURDATE(), NOW())`,
    [org.id, base, tax, total]
  );

  // Mark org paid for ~30 days more (soft notion)
  await db.query(`UPDATE organizations SET is_paid = 1 WHERE id = ?`, [org.id]);

  return order;
}

/** Run daily at 02:00 Asia/Kolkata (approx—uses server TZ) */
function start() {
  cron.schedule('0 2 * * *', async () => {
    try {
      const [orgs] = await db.query(
        `SELECT id, plan_mode, users_count, expected_bookings_per_day, billing_cycle_day
         FROM organizations WHERE plan_mode IN ('semi','full') AND billing_cycle_day IS NOT NULL`
      );
      const today = new Date().getDate();
      for (const org of orgs) {
        if (Number(org.billing_cycle_day) === today) {
          await chargeOrg(org);
        }
      }
    } catch (e) {
      console.error('Billing cron error', e);
    }
  });
  console.log('⏰ BillingScheduler: daily 02:00 job registered');
}

module.exports = { start };

