// services/billingScheduler.js
// Simple scheduler job to process pending billing_events and run subscription checks.
// This is a helper file. In production you'd schedule this via cron or a scheduler service.

const db = require('../db');

async function runBillingEventsOnce() {
  try {
    const events = await db.query('SELECT * FROM billing_events WHERE processed = 0 AND scheduled_at <= NOW() LIMIT 100');
    for (const e of events) {
      try {
        // Example: charge via provider
        console.log('Processing billing_event', e.id);
        // mark processed (simulate)
        await db.query('UPDATE billing_events SET processed = 1, processed_at = NOW() WHERE id = ?', [e.id]);
      } catch (err) {
        console.error('Error processing billing_event', e.id, err.message);
      }
    }
    return { ok:true, count: events.length };
  } catch (err) {
    console.error('runBillingEventsOnce error', err);
    return { ok:false, error: err.message };
  }
}

module.exports = {
  runBillingEventsOnce
};
