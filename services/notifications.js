// services/notifications.js
// Notification sending service: abstraction for manual send / provider send and usage tracking.
// This file provides functions used by routes/notifications.js and others.

const db = require("../services/db");

const config = require('../config');

// Provider integration hooks go here (Twilio / WhatsApp Cloud API / 360dialog)
async function sendViaProvider(notificationId, providerName) {
  // Fetch notification
  const n = (await db.query('SELECT * FROM notifications WHERE id = ?', [notificationId]))[0];
  if (!n) throw new Error('notification_not_found');

  // If providerName is 'manual' treat as error
  if (!providerName || providerName === 'manual') throw new Error('provider_not_configured');

  // TODO: call provider API here and return provider response
  // Example pseudo:
  // const resp = await provider.send({ to: n.to_phone, body: n.body });
  // await db.query('UPDATE notifications SET status = ?, provider_msg_id = ?, sent_at = NOW() WHERE id = ?', ['sent', resp.id, notificationId]);

  // Simulate send success for now:
  const providerMsgId = 'SIM-' + Date.now();
  await db.query('UPDATE notifications SET status = "sent", provider_msg_id = ?, sent_at = NOW(), updated_at = NOW() WHERE id = ?', [providerMsgId, notificationId]);

  // track usage
  try {
    await db.query('INSERT INTO message_usage (org_id, notification_id, channel, provider_msg_id, created_at) VALUES (?, ?, ?, ?, NOW())', [n.org_id, notificationId, n.channel || 'unknown', providerMsgId]);
  } catch (e) {
    // ignore if message_usage table missing
  }

  return { ok:true, providerMsgId };
}

module.exports = {
  sendViaProvider
};
