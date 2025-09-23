// scripts/billing-cron.js
// Run daily by cron / scheduler. This script only creates billing records & events.
// It does NOT itself call a payment gateway (that belongs in routes/payments.js).
//
// Usage: node scripts/billing-cron.js
// Requires db.js exported query(sql, params) -> Promise

const db = require('../db');
const DAYS_IN_PERIOD = 30;
const GRACE_DAYS = 31; // after due date to restrict access

function fmt(d) { return d ? (new Date(d).toISOString()) : null; }

async function fetchFeeSettings() {
  const rows = await db.query('SELECT key_name, value_decimal FROM fee_settings');
  const map = {};
  (rows || []).forEach(r => { map[r.key_name] = parseFloat(r.value_decimal || 0); });
  return map;
}

async function getActiveSubscriptions() {
  // include trials and active subscriptions
  return await db.query('SELECT * FROM org_subscriptions');
}

async function getMessageUsageForOrg(orgId, fromDate, toDate) {
  const rows = await db.query(
    'SELECT SUM(bookings_count) AS bookings_sum, SUM(messages_sent) AS messages_sum, SUM(cost) AS cost_sum FROM message_usage WHERE org_id = ? AND date_for >= ? AND date_for <= ?',
    [orgId, fromDate, toDate]
  );
  return rows && rows[0] ? rows[0] : { bookings_sum: 0, messages_sum: 0, cost_sum: 0 };
}

async function createBillingEvent(orgSubscriptionId, type, amount, scheduledAt, result) {
  const res = await db.query(
    'INSERT INTO billing_events (org_subscription_id, event_type, amount, scheduled_at, result, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
    [orgSubscriptionId, type, amount, scheduledAt, JSON.stringify(result || {})]
  );
  // return inserted id if driver provides it
  const obj = Array.isArray(res) ? res[0] : res;
  return obj.insertId || obj.insert_id || null;
}

async function createPayment(orgSubscriptionId, amount, currency='INR', method='autopay', metadata={}) {
  const res = await db.query(
    'INSERT INTO payments (org_subscription_id, amount, currency, method, status, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
    [orgSubscriptionId, amount, currency, method, 'pending', JSON.stringify(metadata || {})]
  );
  const obj = Array.isArray(res) ? res[0] : res;
  return obj.insertId || obj.insert_id || null;
}

async function markSubscriptionNextDate(subscriptionId, nextDate) {
  await db.query('UPDATE org_subscriptions SET next_billing_date = ?, updated_at = NOW() WHERE id = ?', [nextDate, subscriptionId]);
}

async function markSubscriptionStatus(subscriptionId, status) {
  await db.query('UPDATE org_subscriptions SET status = ?, updated_at = NOW() WHERE id = ?', [status, subscriptionId]);
}

async function run() {
  console.log('Billing cron starting at', new Date().toISOString());
  const fee = await fetchFeeSettings();
  // defaults if not set
  const annualFee = fee.annual_fee || 0;
  const monthlyPerUser = fee.monthly_per_user || 0;
  const messageCostPerBooking = fee.message_cost_per_booking || 0;

  // compute period for last 30 days (end inclusive: yesterday)
  const today = new Date();
  const toDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1); // yesterday
  const fromDate = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() - (DAYS_IN_PERIOD - 1));
  const toDateStr = toDate.toISOString().slice(0,10);
  const fromDateStr = fromDate.toISOString().slice(0,10);

  console.log(`Aggregating message usage from ${fromDateStr} to ${toDateStr}`);

  const subs = await getActiveSubscriptions();
  const summary = [];

  for (const s of subs) {
    try {
      const orgId = s.org_id;
      const subId = s.id;
      // get org current subscription details and trial flag
      const org = await db.query('SELECT id, name FROM organizations WHERE id = ? LIMIT 1', [orgId]);
      if (!org || org.length === 0) continue;
      const orgName = org[0].name;

      // compute monthly platform fee: (we must find the number of expected users)
      // read signup_trials expected_users OR fallback to 1
      const trialRow = await db.query('SELECT expected_users, expected_bookings_per_day FROM signup_trials WHERE org_id = ? ORDER BY id DESC LIMIT 1', [orgId]);
      const expectedUsers = (trialRow && trialRow[0] && trialRow[0].expected_users) ? parseInt(trialRow[0].expected_users,10) : 1;
      const expectedBookingsPerDay = (trialRow && trialRow[0] && trialRow[0].expected_bookings_per_day) ? parseInt(trialRow[0].expected_bookings_per_day,10) : null;

      const monthlyPlatformFeeTotal = parseFloat((monthlyPerUser * expectedUsers).toFixed(2));

      // message usage aggregation for last 30 days
      const usage = await getMessageUsageForOrg(orgId, fromDateStr, toDateStr);
      const actualBookings = parseInt(usage.bookings_sum || 0, 10);
      const actualMessagesCost = parseFloat(usage.cost_sum || 0);
      // if no usage rows, estimate using expectedBookingsPerDay if it exists
      let estimatedMsgCost = 0;
      if (actualBookings === 0 && expectedBookingsPerDay && messageCostPerBooking) {
        estimatedMsgCost = expectedBookingsPerDay * messageCostPerBooking * DAYS_IN_PERIOD;
      }

      const messageCostToCharge = Math.max(actualMessagesCost, estimatedMsgCost || 0);
      const amountDue = parseFloat((monthlyPlatformFeeTotal + messageCostToCharge).toFixed(2));

      // If subscription is trial and trial not expired -> skip billing (but create summary)
      if (s.status === 'trial') {
        // find trial row to check expiry
        const trial = await db.query('SELECT * FROM signup_trials WHERE org_id = ? ORDER BY id DESC LIMIT 1', [orgId]);
        const trialRowLatest = trial && trial[0] ? trial[0] : null;
        const trialExpiresAt = trialRowLatest ? trialRowLatest.trial_expires_at : null;
        if (trialExpiresAt && new Date(trialExpiresAt) > new Date()) {
          // still on trial -> no billing
          summary.push({ orgId, orgName, status: 'trial_active', trial_expires_at: trialExpiresAt });
          console.log(`[${orgId}] ${orgName}: on active trial until ${trialExpiresAt} -> skipping billing`);
          continue;
        } else {
          // trial expired -> treat as billing due (or mark past_due)
          console.log(`[${orgId}] ${orgName}: trial expired or not set, processing billing`);
        }
      }

      // create billing_event and payment (pending). Actual charge will be done by payments worker/integration.
      const scheduledAt = new Date().toISOString();
      const billingEventId = await createBillingEvent(subId, 'monthly_charge', amountDue, scheduledAt, { details: `period ${fromDateStr}..${toDateStr}`, expected_users: expectedUsers, actual_bookings: actualBookings });

      const paymentId = await createPayment(subId, amountDue, 'INR', 'autopay', { billing_event_id: billingEventId, period_start: fromDateStr, period_end: toDateStr });

      // set next billing date (today + 30 days)
      const nextBilling = new Date();
      nextBilling.setDate(nextBilling.getDate() + DAYS_IN_PERIOD);
      await markSubscriptionNextDate(subId, nextBilling.toISOString().slice(0,19).replace('T',' '));

      // add summary
      summary.push({
        orgId, orgName, subscriptionId: subId, amountDue, billingEventId, paymentId, nextBilling: nextBilling.toISOString()
      });

      console.log(`[${orgId}] ${orgName}: billing event ${billingEventId} and payment ${paymentId} created amount ${amountDue}`);

      // If previously past_due and > GRACE_DAYS since next_billing_date => restrict access
      if (s.status === 'past_due') {
        const nextBillDate = s.next_billing_date ? new Date(s.next_billing_date) : null;
        if (nextBillDate) {
          const daysSince = Math.floor((Date.now() - nextBillDate.getTime()) / (1000*60*60*24));
          if (daysSince >= GRACE_DAYS) {
            console.log(`[${orgId}] ${orgName}: subscription past due for ${daysSince} days -> marking cancelled/past_due`);
            await markSubscriptionStatus(subId, 'past_due');
          }
        }
      }

    } catch (err) {
      console.error('Error processing subscription row', s && s.id, err.message);
    }
  }

  console.log('Billing cron complete. Summary:', JSON.stringify(summary, null, 2));
  return summary;
}

if (require.main === module) {
  run().then(() => process.exit(0)).catch(err => {
    console.error('Billing cron failed', err);
    process.exit(2);
  });
}
