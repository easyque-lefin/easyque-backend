// routes/notifications.js
// Full notifications routes: list pending, manual-send links, provider send placeholder.
// Uses the same send-link logic as bookings.

const express = require('express');
const db = require("../services/db");
const config = require('../config');

const router = express.Router();

/** Helper: digits only */
function digitsOnly(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const d = phone.replace(/\D/g, '');
  return d.length > 0 ? d : null;
}

/** Build whatsapp/sms links given phone and text */
function buildSendLinks(phone, text) {
  const textEnc = encodeURIComponent(text || '');
  // fallback generic web link (no recipient)
  let whatsapp_web = `https://wa.me/?text=${textEnc}`;
  let whatsapp_app = `whatsapp://send?text=${textEnc}`;
  let sms_link = `sms:?body=${textEnc}`;

  const phoneDigits = digitsOnly(phone);
  if (phoneDigits) {
    whatsapp_web = `https://web.whatsapp.com/send?phone=${phoneDigits}&text=${textEnc}`;
    // alternative short link:
    // whatsapp_web = `https://wa.me/${phoneDigits}?text=${textEnc}`;
    whatsapp_app = `whatsapp://send?phone=${phoneDigits}&text=${textEnc}`;
    sms_link = `sms:${phoneDigits}?body=${textEnc}`;
  }

  return { whatsapp_web, whatsapp_app, sms_link };
}

/**
 * GET /notifications/pending
 * Returns pending notifications (ordered by created_at)
 */
router.get('/pending', async (req, res) => {
  try {
    const rows = await db.query('SELECT * FROM notifications WHERE status = "pending" ORDER BY created_at ASC LIMIT 200');
    return res.json({ ok:true, notifications: rows });
  } catch (err) {
    console.error('GET /notifications/pending error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

/**
 * POST /notifications/:id/manual-send
 * Returns whatsapp / sms links that receptionist can open to manually send messages.
 * Does NOT change notification status (so admin can track sending separately).
 */
router.post('/:id/manual-send', async (req, res) => {
  try {
    const id = req.params.id;
    const n = (await db.query('SELECT * FROM notifications WHERE id = ?', [id]))[0];
    if (!n) return res.status(404).json({ ok:false, error:'not_found' });

    const text = n.body || '';
    const links = buildSendLinks(n.to_phone || '', text);

    return res.json({ ok:true, notification_id: id, whatsapp_web: links.whatsapp_web, whatsapp_app: links.whatsapp_app, sms_link: links.sms_link });
  } catch (err) {
    console.error('POST /notifications/:id/manual-send error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

/**
 * POST /notifications/:id/send-via-provider
 * Attempt to send via configured provider (twilio / 360dialog / whatsapp cloud api).
 * This is a provider-integration placeholder. When provider configured, implement actual HTTP call here.
 * Body: { provider } optional override
 */
router.post('/:id/send-via-provider', async (req, res) => {
  try {
    const id = req.params.id;
    const provider = req.body && req.body.provider ? req.body.provider : (config.messaging && config.messaging.provider) || process.env.MSG_PROVIDER || 'manual';
    const n = (await db.query('SELECT * FROM notifications WHERE id = ?', [id]))[0];
    if (!n) return res.status(404).json({ ok:false, error:'not_found' });

    if (provider === 'manual') {
      return res.status(400).json({ ok:false, error:'manual_provider_configured', message:'Provider is set to manual in config. Use manual-send to open WhatsApp/SMS links.' });
    }

    // Example placeholder logic (simulate success):
    // - In a real provider integration, call the provider API here,
    //   on success update notifications.status='sent', provider_msg_id, sent_at
    //   and insert a row into message_usage.
    // For now we simulate a successful send and update DB accordingly.
    const simulatedProviderId = 'SIM-' + Date.now();
    await db.query('UPDATE notifications SET status = "sent", provider_msg_id = ?, sent_at = NOW(), updated_at = NOW() WHERE id = ?', [simulatedProviderId, id]);

    // Insert message usage entry for billing/tracking (if table exists)
    try {
      await db.query('INSERT INTO message_usage (org_id, notification_id, channel, created_at) VALUES (?, ?, ?, NOW())', [n.org_id, id, n.channel]);
    } catch (e) {
      // ignore if message_usage table not present
      console.warn('Warning: could not insert into message_usage (maybe table missing):', e.message);
    }

    return res.json({ ok:true, message:'sent_simulated', provider, provider_msg_id: simulatedProviderId });
  } catch (err) {
    console.error('POST /notifications/:id/send-via-provider error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

module.exports = router;

