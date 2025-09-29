// routes/webhooks.js
const express = require('express');
const crypto = require('crypto');
let db; try { db = require('../services/db'); } catch { db = require('../db'); }

const router = express.Router();

router.post('/razorpay', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
    const sig = req.headers['x-razorpay-signature'];
    const body = req.body;
    if (!secret || !sig || !body) return res.status(400).json({ ok:false, error:'missing_signature_or_secret' });

    const digest = crypto.createHmac('sha256', secret).update(body).digest('hex');
    if (digest !== sig) return res.status(400).json({ ok:false, error:'signature_mismatch' });

    const evt = JSON.parse(body.toString('utf8'));
    const type = evt.event || '';
    const payload = evt.payload || {};
    const sub = payload.subscription?.entity || {};
    const inv = payload.invoice?.entity || {};
    const pay = payload.payment?.entity || {};
    const order = payload.order?.entity || {};

    const rzpSubId = sub.id || inv.subscription_id || null;
    const rzpInvId = inv.id || null;
    const rzpPayId = pay.id || null;
    const rzpOrderId = order.id || null;
    let orgId = Number(
      (sub.notes && sub.notes.org_id) ||
      (inv.notes && inv.notes.org_id) ||
      (order.notes && order.notes.org_id) || 0
    ) || null;

    if (!orgId && rzpSubId) {
      const [r1] = await db.query('SELECT org_id FROM org_billing WHERE rzp_subscription_id=? LIMIT 1', [rzpSubId]);
      orgId = r1?.[0]?.org_id || null;
    }
    if (!orgId && rzpOrderId) {
      const [r2] = await db.query('SELECT org_id FROM org_billing WHERE rzp_order_id=? LIMIT 1', [rzpOrderId]);
      orgId = r2?.[0]?.org_id || null;
    }
    if (!orgId) return res.json({ ok:true, ignored:true });

    let newStatus = null, failureReason = null, periodEnd = null, chargeAt = null;
    switch (type) {
      case 'subscription.activated': newStatus='active'; periodEnd=sub.current_end? new Date(sub.current_end*1000):null; break;
      case 'subscription.charged':
      case 'invoice.paid': newStatus='active'; chargeAt=new Date(); periodEnd=inv.period_end? new Date(inv.period_end*1000):null; break;
      case 'subscription.halted':
      case 'subscription.paused': newStatus='paused'; break;
      case 'subscription.cancelled':
      case 'subscription.completed': newStatus='canceled'; break;
      case 'invoice.payment_failed':
      case 'payment.failed': newStatus='past_due'; failureReason = pay.error_reason || pay.error_description || 'payment_failed'; break;
      default: newStatus=null; break;
    }

    const sets=[], vals=[];
    const push=(c,v)=>{ sets.push(`${c}=?`); vals.push(v); };
    if (type) push('last_event', type);
    if (rzpInvId) push('last_invoice_id', rzpInvId);
    if (rzpPayId) push('last_payment_id', rzpPayId);
    if (chargeAt) push('last_charge_at', chargeAt);
    if (failureReason) push('failure_reason', failureReason);
    if (periodEnd) push('current_period_end', periodEnd);
    if (newStatus) push('status', newStatus);
    if (sets.length) {
      vals.push(orgId);
      await db.query(`UPDATE org_billing SET ${sets.join(', ')} WHERE org_id=?`, vals);
    }
    if (newStatus) {
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
