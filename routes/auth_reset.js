// routes/auth_reset.js (fixed)
// Robust password reset using bcrypt, storing to users.password_hash (not plaintext).

const express = require('express');
const crypto = require('crypto');
const dayjs = require('dayjs');
const bcrypt = require('bcrypt');
const db = require('../services/db');

const router = express.Router();

/** POST /auth/request-reset { email } */
router.post('/auth/request-reset', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ ok:false, error:'email_required' });

    const [u] = await db.query(`SELECT id FROM users WHERE email=? LIMIT 1`, [email]);
    if (!u.length) {
      // Don't reveal user enumeration
      return res.json({ ok:true });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = dayjs().add(1, 'hour').format('YYYY-MM-DD HH:mm:ss');

    await db.query(
      `INSERT INTO password_reset_tokens (user_id, token, created_at, expires_at, used)
       VALUES (?,?,?,?,0)`,
      [u[0].id, token, dayjs().format('YYYY-MM-DD HH:mm:ss'), expiresAt]
    );

    // TODO: send email via configured provider; for now return masked response
    // Never leak the token here in production APIs.
    return res.json({ ok:true });
  } catch (e) { next(e); }
});

/** POST /auth/confirm-reset { token, new_password } */
router.post('/auth/confirm-reset', async (req, res, next) => {
  try {
    const token = String(req.body?.token || '').trim();
    const newPassword = String(req.body?.new_password || '').trim();
    if (!token || !newPassword) return res.status(400).json({ ok:false, error:'token_and_new_password_required' });
    if (newPassword.length < 8) return res.status(400).json({ ok:false, error:'password_too_short' });

    const [rows] = await db.query(
      `SELECT * FROM password_reset_tokens WHERE token=? AND used=0 LIMIT 1`,
      [token]
    );
    if (!rows.length) return res.status(400).json({ ok:false, error:'invalid_or_used_token' });
    const pr = rows[0];
    if (dayjs(pr.expires_at).isBefore(dayjs())) return res.status(400).json({ ok:false, error:'token_expired' });

    // Hash securely
    const saltRounds = 12;
    const hashed = await bcrypt.hash(newPassword, saltRounds);

    // Persist to users.password_hash
    await db.query(`UPDATE users SET password_hash = ? WHERE id = ?`, [hashed, pr.user_id]);
    await db.query(`UPDATE password_reset_tokens SET used=1 WHERE id=?`, [pr.id]);

    res.json({ ok:true, reset:true });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.default = router;
