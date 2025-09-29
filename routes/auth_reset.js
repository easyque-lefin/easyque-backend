// routes/auth_reset.js
const express = require('express');
const crypto = require('crypto');
const dayjs = require('dayjs');
const db = require('../services/db');

const router = express.Router();

/** POST /auth/request-reset { email } */
router.post('/auth/request-reset', async (req, res, next) => {
  try {
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ ok:false, error:'email required' });

    const [u] = await db.query(`SELECT id FROM users WHERE email=? LIMIT 1`, [email]);
    if (!u.length) {
      // do not reveal existence
      return res.json({ ok:true, sent:true });
    }
    const user_id = u[0].id;
    const token = crypto.randomBytes(16).toString('hex');
    const expires = dayjs().add(30,'minute').format('YYYY-MM-DD HH:mm:ss');

    await db.query(
      `INSERT INTO password_reset_tokens (user_id, token, expires_at)
       VALUES (?, ?, ?)`,
      [user_id, token, expires]
    );

    // TODO: send email/SMS with link like: https://status.easyque.org/reset-password?token=XXXX
    res.json({ ok:true, sent:true, token }); // expose token for testing now
  } catch (e) { next(e); }
});

/** POST /auth/reset { token, new_password } */
router.post('/auth/reset', async (req, res, next) => {
  try {
    const token = req.body?.token;
    const pass  = req.body?.new_password;
    if (!token || !pass) return res.status(400).json({ ok:false, error:'token and new_password required' });

    const [rows] = await db.query(
      `SELECT * FROM password_reset_tokens
        WHERE token=? AND used=0 AND expires_at > NOW()
        LIMIT 1`, [token]
    );
    if (!rows.length) return res.status(400).json({ ok:false, error:'invalid_or_expired' });
    const pr = rows[0];

    // update user password (assumes users.password is hashed elsewhere in your auth logic)
    // For simplicity, hash here using bcrypt if present; else store plaintext (NOT recommended).
    let hashed = pass;
    try {
      const bcrypt = require('bcryptjs');
      const salt = await bcrypt.genSalt(10);
      hashed = await bcrypt.hash(pass, salt);
    } catch {
      // fallback: store as is (dev only). Replace with your existing hashing method!
    }

    await db.query(`UPDATE users SET password = ? WHERE id = ?`, [hashed, pr.user_id]);
    await db.query(`UPDATE password_reset_tokens SET used=1 WHERE id=?`, [pr.id]);

    res.json({ ok:true, reset:true });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.default = router;
