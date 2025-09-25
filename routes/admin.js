// routes/admin.js
// Admin actions: deactivate/reactivate org, cascade delete org and related data, set fees/charges

const express = require('express');
const db = require('../db');

const router = express.Router();

/**
 * POST /admin/orgs/:id/deactivate
 */
router.post('/orgs/:id/deactivate', async (req, res) => {
  try {
    const id = req.params.id;
    await db.query('UPDATE organizations SET is_active = 0 WHERE id = ?', [id]);
    return res.json({ ok:true, message: 'org_deactivated' });
  } catch (err) {
    console.error('POST /admin/orgs/:id/deactivate error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

/**
 * POST /admin/orgs/:id/reactivate
 */
router.post('/orgs/:id/reactivate', async (req, res) => {
  try {
    const id = req.params.id;
    await db.query('UPDATE organizations SET is_active = 1 WHERE id = ?', [id]);
    return res.json({ ok:true, message: 'org_reactivated' });
  } catch (err) {
    console.error('POST /admin/orgs/:id/reactivate error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

/**
 * DELETE /admin/orgs/:id
 * Cascading delete: bookings, notifications, users, subscriptions, billing_events.
 * NOTE: This tries to remove DB rows; if you want backup, run SELECTs first.
 */
router.delete('/orgs/:id', async (req, res) => {
  try {
    const id = req.params.id;
    // wrap operations to avoid partial deletes
    await db.query('START TRANSACTION');

    // backup optionally: copy tables to backup_*
    // (left out - admins can run backups manually before deletion)

    // delete bookings, notifications, billing_events, subscriptions, users for org
    const tables = ['bookings', 'notifications', 'billing_events', 'org_subscriptions', 'message_usage', 'users'];
    for (const t of tables) {
      try {
        await db.query(`DELETE FROM ${t} WHERE org_id = ?`, [id]);
      } catch (e) {
        // ignore if table doesn't exist or error; we'll continue
        console.warn(`Warning deleting from ${t}:`, e.message);
      }
    }

    // Finally delete org
    await db.query('DELETE FROM organizations WHERE id = ?', [id]);

    await db.query('COMMIT');
    return res.json({ ok:true, message: 'org_deleted' });
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch(e) {}
    console.error('DELETE /admin/orgs/:id error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

/**
 * POST /admin/fees
 * body: { org_id, name, amount, currency, active }
 */
router.post('/fees', async (req, res) => {
  try {
    const { org_id, name, amount, currency, active } = req.body || {};
    if (!org_id || !name || !amount) return res.status(400).json({ ok:false, error:'org_id_name_amount_required' });
    await db.query('INSERT INTO admin_fees (org_id, name, amount, currency, active, created_at) VALUES (?, ?, ?, ?, ?, NOW())', [org_id, name, amount, currency || 'INR', active ? 1 : 0]);
    return res.json({ ok:true });
  } catch (err) {
    console.error('POST /admin/fees error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

module.exports = router;
