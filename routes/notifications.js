// routes/notifications.js
const express = require('express');
const db = require('../db');
const config = require('../config');

const router = express.Router();

/**
 * GET /notifications/pending
 * Returns pending notifications (useful for a worker)
 */
router.get('/pending', async (req, res) => {
  try {
    const rows = await db.query('SELECT * FROM notifications WHERE status = "pending" ORDER BY created_at ASC LIMIT 100');
    return res.json({ ok:true, notifications: rows });
  } catch (err) {
    console.error('GET /notifications/pending error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

/**
 * POST /notifications/:id/manual-send
 * Triggers a manual-send flow that returns a whatsapp/sms deep link which receptionist can open.
 * Does NOT change status; only returns the link.
 */
router.post('/:id/manual-send', async (req, res) => {
  try {
    const id = req.params.id;
    const n = (await db.query('SELECT * FROM notifications WHERE id = ?', [id]))[0];
    if (!n) return res.status(404).json({ ok:false, error:'not_found' });

    const text = n.body;
    const waText = encodeURIComponent(text);
    const whatsapp_web = `https://wa.me/?text=${waText}`;
    const whatsapp_app = `whatsapp://send?text=${waText}`;
    const sms_text = text;

    return res.json({ ok:true, notification_id: id, whatsapp_web, whatsapp_app, sms_text });
  } catch (err) {
    console.error('POST /notifications/:id/manual-send error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

/**
 * POST /notifications/:id/send-via-provider
 * Attempt to send via configured provider (twilio/360dialog) - provider integration placeholder.
 * Body: { provider } optionally
 */
router.post('/:id/send-via-provider', async (req, res) => {
  try {
    const id = req.params.id;
    const provider = req.body.provider || config.messaging.provider || 'manual';
    const n = (await db.query('SELECT * FROM notifications WHERE id = ?', [id]))[0];
    if (!n) return res.status(404).json({ ok:false, error:'not_found' });

    if (provider === 'manual') {
      return res.status(400).json({ ok:false, error:'manual_provider_configured', message:'Provider is set to manual in config. Use manual-send to open WhatsApp.' });
    }

    // Placeholder for actual provider integration
    // On success: update notifications.status='sent', provider_msg_id, sent_at and increment message_usage
    // On failure: update notifications.status='failed'

    // For now simulate success:
    await db.query('UPDATE notifications SET status = "sent", provider_msg_id = ?, sent_at = NOW(), updated_at = NOW() WHERE id = ?', ['SIMULATED-'+Date.now(), id]);
    await db.query('INSERT INTO message_usage (org_id, notification_id, channel, created_at) VALUES (?, ?, ?, NOW())', [n.org_id, id, n.channel]);

    return res.json({ ok:true, message:'sent_simulated' });
  } catch (err) {
    console.error('POST /notifications/:id/send-via-provider error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

module.exports = router;
