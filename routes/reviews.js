// routes/reviews.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const jwt = require("jsonwebtoken");

// Middleware for auth
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "Missing token" });
  const token = header.split(" ")[1];
  jwt.verify(token, process.env.JWT_SECRET || "supersecret", (err, decoded) => {
    if (err) return res.status(401).json({ error: "Invalid token" });
    req.user = decoded;
    next();
  });
}

// POST /reviews/add  (aligned to Postman)
router.post("/add", auth, async (req, res) => {
  try {
    const { org_id, rating, comment } = req.body;
    await db.query(
      "INSERT INTO reviews (org_id, user_id, rating, comment) VALUES (?, ?, ?, ?)",
      [org_id, req.user.id, rating, comment]
    );
    return res.json({ message: "Review submitted" });
  } catch (err) {
    console.error("Review submit error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /reviews?org_id=...
router.get("/", async (req, res) => {
  try {
    const { org_id } = req.query;
    const [rows] = await db.query(
      "SELECT r.*, u.name FROM reviews r JOIN users u ON r.user_id=u.id WHERE r.org_id=?",
      [org_id]
    );
    return res.json(rows);
  } catch (err) {
    console.error("Review fetch error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
