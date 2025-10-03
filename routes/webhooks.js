// routes/webhooks.js — Razorpay webhook handler
// Updates org_billing.status, rzp_* fields, and organizations.subscription_status

const express = require('express');
const crypto = require('crypto');
const db = require("../services/db");

const router = express.Router();

async function getCols(table){
  const [rows]=await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name=?`, [table]
  );
  return new Set(rows.map(r => String(r.column_name)));
}

router.post('/razorpay', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
    const sig = req.headers['x-razorpay-signature'];
    const body = req.body; // Buffer
    if (!secret || !sig || !body) return res.status(400).json({ ok:false, error:'missing_signature_or_secret' });

    const digest = crypto.createHmac('sha256', secret).update(body).digest('hex');
    if (digest !== sig) return res.status(400).json({ ok:false, error:'signature_mismatch' });

    const event = JSON.parse(body.toString('utf8'));
    const type = event.event || '';
    let orgId = null;
    let newStatus = null;
    let failureReason = null;
    let periodEnd = null;
    let chargeAt = null;

    // derive org_id from notes if present
    const sub = event.payload?.subscription?.entity;
    const inv = event.payload?.invoice?.entity;
    const pay = event.payload?.payment?.entity;
    const ord = event.payload?.order?.entity;

    const notesOrgId =
      sub?.notes?.org_id || inv?.notes?.org_id || pay?.notes?.org_id || ord?.notes?.org_id || null;
    if (notesOrgId) orgId = Number(notesOrgId) || null;

    switch (type) {
      case 'subscription.activated':
        newStatus = 'active';
        periodEnd = sub?.current_end ? new Date(sub.current_end * 1000) : null;
        break;
      case 'invoice.paid':
        newStatus = 'active';
        chargeAt = inv?.period_end ? new Date(inv.period_end * 1000) : null;
        periodEnd = inv?.period_end ? new Date(inv.period_end * 1000) : null;
        break;
      case 'subscription.paused':
        newStatus = 'paused';
        break;
      case 'subscription.halted':
      case 'subscription.cancelled':
      case 'subscription.completed':
        newStatus = 'canceled';
        break;
      case 'payment.failed':
        newStatus = 'past_due';
        failureReason = pay?.error_reason || pay?.error_description || 'payment_failed';
        break;
      default:
        newStatus = null;
        break;
    }

    // If we can map an org via subscription/customer later, do it here (not shown)

    // Update org_billing (only existing columns)
    const obCols = await getCols('org_billing');
    const cols=[], vals=[], sets=[];
    function push(c, v){ if (obCols.has(c) && v!==undefined && v!==null){ cols.push(c); vals.push(v); sets.push(`${c}=?`);} }

    if (orgId) {
      // ensure row exists
      if (obCols.has('org_id')) {
        await db.query(`INSERT IGNORE INTO org_billing (org_id) VALUES (?)`, [orgId]);
      }
      if (sub?.id) push('rzp_subscription_id', sub.id);
      if (pay?.id) push('rzp_payment_id', pay.id);
      if (ord?.id) push('rzp_order_id', ord.id);
      if (newStatus) push('status', newStatus);
      if (inv?.period_end && obCols.has('next_charge_at')) {
        push('next_charge_at', new Date(inv.period_end * 1000));
      }
      if (type === 'invoice.paid' && obCols.has('last_paid_at')) {
        push('last_paid_at', new Date());
      }

      if (sets.length) {
        await db.query(`UPDATE org_billing SET ${sets.join(', ')} WHERE org_id=?`, [...vals, orgId]);
      }
    }

    // Reflect in organizations.subscription_status if present
    const orgCols = await getCols('organizations');
    if (orgId && newStatus && orgCols.has('subscription_status')) {
      await db.query(`UPDATE organizations SET subscription_status=? WHERE id=?`, [newStatus, orgId]);
    }

    res.json({ ok:true });
  } catch (e) {
    console.error('[Webhook] error', e);
    res.status(500).json({ ok:false, error:'webhook_error' });
  }
});

module.exports = router;
module.exports.default = router;
