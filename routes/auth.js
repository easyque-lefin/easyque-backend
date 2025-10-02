// routes/auth.js
const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");
const { v4: uuidv4 } = require("uuid");

const JWT_SECRET = process.env.JWT_SECRET || "supersecret";

/** Utility: does a string look like a bcrypt hash? */
const looksLikeBcrypt = (val) =>
  typeof val === "string" && val.startsWith("$2") && val.length >= 50;

/** Utility: normalize db.query() result to an array of rows
 * Works with:
 *  - mysql2/promise: [rows, fields]
 *  - custom wrappers: rows
 */
function toRows(qres) {
  if (Array.isArray(qres)) {
    // If first item is also an array, it's [rows, fields]
    return Array.isArray(qres[0]) ? qres[0] : qres;
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/*                                   LOGIN                                    */
/* POST /auth/login
 * Body: { email, password }
 * - Verifies against password_hash (preferred)
 * - Falls back to legacy password column (bcrypt or plaintext)
 * - Migrates legacy password to password_hash on success
 * - Returns { accessToken, user }
/* -------------------------------------------------------------------------- */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const qres = await db.query("SELECT * FROM users WHERE email = ? LIMIT 1", [email]);
    const rows = toRows(qres);
    if (!rows || rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const user = rows[0];

    // -------- password verification (hash-first, then legacy) --------
    let ok = false;

    if (user.password_hash) {
      ok = await bcrypt.compare(password, user.password_hash);
    } else if (user.password) {
      if (looksLikeBcrypt(user.password)) {
        // legacy column already holds a bcrypt hash
        ok = await bcrypt.compare(password, user.password);
        if (ok) {
          // migrate hash to password_hash for consistency
          await db.query(
            "UPDATE users SET password_hash = ?, password = NULL, updated_at = NOW() WHERE id = ?",
            [user.password, user.id]
          );
        }
      } else {
        // VERY old plaintext password
        ok = password === user.password;
        if (ok) {
          const hashed = await bcrypt.hash(password, 10);
          await db.query(
            "UPDATE users SET password_hash = ?, password = NULL, updated_at = NOW() WHERE id = ?",
            [hashed, user.id]
          );
        }
      }
    }

    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // -------- issue JWT --------
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, org_id: user.org_id },
      JWT_SECRET,
      { expiresIn: "12h" }
    );

    return res.json({
      accessToken: token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        org_id: user.org_id,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/* -------------------------------------------------------------------------- */
/*                          REQUEST PASSWORD RESET                             */
/* POST /auth/request-reset
 * Body: { email }
 * - Generates a reset_token and stores it on user
 * - (Stub) You can email the token to the user later
/* -------------------------------------------------------------------------- */
router.post("/request-reset", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: "Email required" });

    const qres = await db.query("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
    const rows = toRows(qres);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const resetToken = uuidv4();
    await db.query(
      "UPDATE users SET reset_token = ?, updated_at = NOW() WHERE email = ?",
      [resetToken, email]
    );

    // TODO: send email with resetToken
    console.log(`Password reset requested for ${email}, token: ${resetToken}`);

    return res.json({ message: "Password reset requested", resetToken });
  } catch (err) {
    console.error("Request reset error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/* -------------------------------------------------------------------------- */
/*                              RESET PASSWORD                                 */
/* POST /auth/reset
 * Body: { token, password }
 * - Validates token, writes bcrypt to password_hash, clears legacy fields
/* -------------------------------------------------------------------------- */
router.post("/reset", async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) {
      return res.status(400).json({ error: "token and password required" });
    }

    const qres = await db.query("SELECT id FROM users WHERE reset_token = ? LIMIT 1", [token]);
    const rows = toRows(qres);
    if (!rows || rows.length === 0) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    const userId = rows[0].id;
    const hashed = await bcrypt.hash(password, 10);

    await db.query(
      "UPDATE users SET password_hash = ?, password = NULL, reset_token = NULL, updated_at = NOW() WHERE id = ?",
      [hashed, userId]
    );

    return res.json({ message: "Password has been reset" });
  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;




