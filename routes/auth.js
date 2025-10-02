// routes/auth.js
const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");
const { v4: uuidv4 } = require("uuid");

const JWT_SECRET = process.env.JWT_SECRET || "supersecret";

// Helper: detect bcrypt hash format
const looksLikeBcrypt = (val) =>
  typeof val === "string" &&
  val.startsWith("$2") && // $2a, $2b, $2y
  val.length >= 50;

// ---------------- LOGIN ----------------
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const [rows] = await db.query("SELECT * FROM users WHERE email = ? LIMIT 1", [email]);
    if (!rows || !rows.length) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const user = rows[0];
    let ok = false;

    if (user.password_hash && looksLikeBcrypt(user.password_hash)) {
      // Preferred: compare against password_hash
      ok = await bcrypt.compare(password, user.password_hash);
    } else if (user.password) {
      if (looksLikeBcrypt(user.password)) {
        // Legacy: bcrypt hash stored in password column
        ok = await bcrypt.compare(password, user.password);
        if (ok) {
          // migrate to password_hash
          await db.query(
            "UPDATE users SET password_hash = ?, password = NULL, updated_at = NOW() WHERE id = ?",
            [user.password, user.id]
          );
        }
      } else {
        // Very old: plaintext password stored
        ok = password === user.password;
        if (ok) {
          // migrate to bcrypt-hash
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

    // Auth success → issue JWT
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

// ---------------- REQUEST PASSWORD RESET ----------------
router.post("/request-reset", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: "Email required" });

    const [rows] = await db.query("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
    if (!rows || !rows.length) {
      return res.status(404).json({ error: "User not found" });
    }

    const resetToken = uuidv4();
    await db.query("UPDATE users SET reset_token = ?, updated_at = NOW() WHERE email = ?", [
      resetToken,
      email,
    ]);

    // TODO: send email with resetToken
    console.log(`Password reset requested for ${email}, token: ${resetToken}`);

    return res.json({ message: "Password reset requested", resetToken });
  } catch (err) {
    console.error("Request reset error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------- RESET PASSWORD ----------------
router.post("/reset", async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) {
      return res.status(400).json({ error: "token and password required" });
    }

    const [rows] = await db.query("SELECT id FROM users WHERE reset_token = ? LIMIT 1", [token]);
    if (!rows || !rows.length) {
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



