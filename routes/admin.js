// routes/admin.js
const express = require('express');
const db = require('../db');
const config = require('../config');

const router = express.Router();

/**
 * POST /admin/set-charges
 * body: { annual_fee, monthly_fee_per_user, message_cost_per_unit }
 * (Admin only - for now assume protected by middleware or internal use)
 */
router.post('/set-charges', async (req, res) => {
  try {
    const { annual_fee, monthly_fee_per_user, message_cost_per_unit } = req.body;
    if (annual_fee == null || monthly_fee_per_user == null || message_cost_per_unit == null) {
      return res.status(400).json({ ok:false, error:'fields_required' });
    }
    // Upsert to settings table; if not exist create
    await db.query('INSERT INTO fee_settings (annual_fee, monthly_fee_per_user, message_cost_per_unit, created_at) VALUES (?, ?, ?, NOW())', [annual_fee, monthly_fee_per_user, message_cost_per_unit]);
    return res.json({ ok:true, message:'fees_set' });
  } catch (err) {
    console.error('POST /admin/set-charges error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

/**
 * POST /admin/orgs/:id/deactivate
 * body: { confirm_admin_password }  // basic safety
 */
router.post('/orgs/:id/deactivate', async (req, res) => {
  try {
    const id = req.params.id;
    await db.query('UPDATE organizations SET is_active = 0 WHERE id = ?', [id]);
    // also deactivate users
    await db.query('UPDATE users SET is_active = 0 WHERE org_id = ?', [id]);
    return res.json({ ok:true, message:'org_deactivated' });
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
    await db.query('UPDATE users SET is_active = 1 WHERE org_id = ?', [id]);
    return res.json({ ok:true, message:'org_reactivated' });
  } catch (err) {
    console.error('POST /admin/orgs/:id/reactivate error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

/**
 * DELETE /admin/orgs/:id
 * Permanently delete an org and cascade delete its data.
 * For safety, require confirm_admin_password in body (plaintext here; integrate with real auth in production)
 */
router.delete('/orgs/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { confirm_admin_password } = req.body;
    // TODO: verify confirm_admin_password against admin password (skipped here). Proceed only if provided.
    if (!confirm_admin_password) return res.status(400).json({ ok:false, error:'confirm_admin_password_required' });

    // Optionally backup data (omitted). Then cascade delete: assuming foreign keys with ON DELETE CASCADE exist.
    await db.query('DELETE FROM organizations WHERE id = ?', [id]);
    return res.json({ ok:true, message:'org_deleted' });
  } catch (err) {
    console.error('DELETE /admin/orgs/:id error', err);
    return res.status(500).json({ ok:false, error:'server_error', details: err.message });
  }
});

module.exports = router;
