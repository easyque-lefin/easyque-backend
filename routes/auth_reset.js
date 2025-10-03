// routes/auth_reset.js — FULL FILE
// Password reset flow using users.reset_token & users.reset_token_expiry

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require("../services/db");
const router = express.Router();

/** helper: normalize DB result to rows */
async function q(sql, params) {
  const res = await db.query(sql, params);
  if (Array.isArray(res)) return res[0] ?? res;   // mysql2 [rows, fields] or [result]
  return res;                                     // custom wrapper returns rows directly
}

function bad(res, status, details, code = 'bad_request') {
  return res.status(status).json({ ok: false, error: code, details });
}

/**
 * POST /auth/request-reset
 * Body: { email }
 * Creates a token valid for 15 minutes and stores it on the user row.
 */
router.post('/request-reset', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email) return bad(res, 400, 'email is required');
    // Look up user
    const rows = await q('SELECT id, email FROM users WHERE email = ? LIMIT 1', [email]);
    if (!rows || rows.length === 0) {
      // For privacy, respond 200 even if user does not exist
      return res.json({ ok: true, requested: true });
    }

    const user = rows[0];
    // Generate secure token
    const token = crypto.randomBytes(24).toString('hex');
    // 15 minutes from now
    const expiryMins = 15;
    await db.query(
      'UPDATE users SET reset_token = ?, reset_token_expiry = DATE_ADD(NOW(), INTERVAL ? MINUTE), updated_at = NOW() WHERE id = ?',
      [token, expiryMins, user.id]
    );

    // TODO: send email in production (SMTP/SendGrid/etc.)
    // For now we return token ONLY in non-production to assist testing.
    const includeToken = (process.env.NODE_ENV !== 'production');
    return res.json({
      ok: true,
      requested: true,
      ...(includeToken ? { token } : {})
    });
  } catch (err) {
    console.error('POST /auth/request-reset error:', err);
    return bad(res, 500, err.sqlMessage || err.message, 'server_error');
  }
});

/**
 * POST /auth/confirm-reset
 * Body: { token, new_password }
 */
router.post('/confirm-reset', async (req, res) => {
  try {
    const token = String(req.body.token || '').trim();
    const newPassword = String(req.body.new_password || '').trim();

    if (!token || !newPassword) {
      return bad(res, 400, 'token and new_password are required');
    }

    // Load user by active (non-expired) token
    const rows = await q(
      'SELECT id FROM users WHERE reset_token = ? AND reset_token_expiry IS NOT NULL AND reset_token_expiry > NOW() LIMIT 1',
      [token]
    );
    if (!rows || rows.length === 0) {
      return bad(res, 400, 'invalid or expired token');
    }
    const userId = rows[0].id;

    // Update password + clear token fields
    const password_hash = await bcrypt.hash(newPassword, 10);
    await db.query(
      `UPDATE users
         SET password_hash = ?, reset_token = NULL, reset_token_expiry = NULL, updated_at = NOW()
       WHERE id = ?`,
      [password_hash, userId]
    );

    return res.json({ ok: true, reset: true });
  } catch (err) {
    console.error('POST /auth/confirm-reset error:', err);
    return bad(res, 500, err.sqlMessage || err.message, 'server_error');
  }
});

module.exports = router;

