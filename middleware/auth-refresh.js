// routes/auth-refresh.js
// Handles refresh token rotation + logout. No login here.
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET;
const ACCESS_TOKEN_EXPIRES = process.env.ACCESS_TOKEN_EXPIRES || '15m';
const REFRESH_TOKEN_EXPIRES = process.env.REFRESH_TOKEN_EXPIRES || '7d';

// create short-lived access token
function createAccessToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, org_id: user.org_id || null },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRES }
  );
}

// create refresh token (longer lived)
function createRefreshToken(user) {
  return jwt.sign({ id: user.id }, REFRESH_TOKEN_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRES });
}

// Fetch refresh token DB record
async function findRefreshToken(token) {
  const rows = await db.query('SELECT * FROM refresh_tokens WHERE token = ? LIMIT 1', [token]);
  return (rows && rows.length) ? rows[0] : null;
}

// Revoke (logical delete) refresh token
async function revokeRefreshToken(token) {
  await db.query('UPDATE refresh_tokens SET revoked = 1 WHERE token = ?', [token]);
}

// POST /auth/refresh
// Body: { refreshToken: "<token>" }
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ error: 'Missing refreshToken' });

    // verify signature
    let payload;
    try {
      payload = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    // check DB
    const record = await findRefreshToken(refreshToken);
    if (!record) return res.status(401).json({ error: 'Refresh token not found' });
    if (record.revoked) return res.status(401).json({ error: 'Refresh token revoked' });
    if (record.expires_at && new Date(record.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Refresh token expired' });
    }

    // get user
    const users = await db.query('SELECT id, name, email, role, org_id FROM users WHERE id = ? LIMIT 1', [payload.id]);
    if (!users || users.length === 0) return res.status(401).json({ error: 'User not found' });
    const user = users[0];

    // rotate tokens: revoke old refresh token, issue new refresh token + access token
    await revokeRefreshToken(refreshToken);

    const newAccessToken = createAccessToken(user);
    const newRefreshToken = createRefreshToken(user);

    // store new refresh token
    const decoded = jwt.decode(newRefreshToken) || {};
    // NOTE: refresh_tokens table schema in your DB doesn't include created_at, so insert only existing cols
    // store as DATETIME using FROM_UNIXTIME(decoded.exp)
    await db.query(
      `INSERT INTO refresh_tokens (token, user_id, expires_at, ip_address, user_agent, revoked)
       VALUES (?, ?, FROM_UNIXTIME(?), ?, ?, 0)`,
      [newRefreshToken, user.id, decoded.exp || null, req.ip || null, req.get('User-Agent') || null]
    );

    return res.json({ accessToken: newAccessToken, refreshToken: newRefreshToken });
  } catch (err) {
    console.error('refresh error', err);
    return res.status(500).json({ error: 'server error', details: err.message });
  }
});

// POST /auth/logout
// Body: { refreshToken: "<token>" }
// Marks refresh token revoked.
router.post('/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) return res.status(400).json({ error: 'Missing refreshToken' });

    await revokeRefreshToken(refreshToken);
    return res.json({ ok: true });
  } catch (err) {
    console.error('logout error', err);
    return res.status(500).json({ error: 'server error', details: err.message });
  }
});

module.exports = router;
