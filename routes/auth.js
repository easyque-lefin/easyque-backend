// routes/auth.js
const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db");
const { v4: uuidv4 } = require("uuid");

// Secret
const JWT_SECRET = process.env.JWT_SECRET || "supersecret";

// ---------------- LOGIN ----------------
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const [rows] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
    if (!rows.length) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: "12h" }
    );

    return res.json({ accessToken: token, user });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------- REQUEST PASSWORD RESET ----------------
// Path aligned to Postman: /auth/request-reset
router.post("/request-reset", async (req, res) => {
  try {
    const { email } = req.body;

    const [rows] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
    if (!rows.length) {
      return res.status(404).json({ error: "User not found" });
    }

    const resetToken = uuidv4();
    await db.query("UPDATE users SET reset_token=? WHERE email=?", [resetToken, email]);

    // TODO: Send email with resetToken (stubbed for now)
    console.log(`Password reset requested for ${email}, token: ${resetToken}`);

    return res.json({ message: "Password reset requested", resetToken });
  } catch (err) {
    console.error("Request reset error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------- RESET PASSWORD ----------------
// Path aligned to Postman: /auth/reset
router.post("/reset", async (req, res) => {
  try {
    const { token, password } = req.body;

    const [rows] = await db.query("SELECT * FROM users WHERE reset_token=?", [token]);
    if (!rows.length) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    const hashed = await bcrypt.hash(password, 10);
    await db.query("UPDATE users SET password=?, reset_token=NULL WHERE reset_token=?", [
      hashed,
      token,
    ]);

    return res.json({ message: "Password has been reset" });
  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;

