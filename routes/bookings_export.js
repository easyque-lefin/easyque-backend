// routes/bookings_export.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const { stringify } = require("csv-stringify/sync");
const jwt = require("jsonwebtoken");

// Middleware
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

router.get("/export", auth, async (req, res) => {
  try {
    const { org_id } = req.query;
    const [rows] = await db.query("SELECT * FROM bookings WHERE org_id=?", [org_id]);

    const csv = stringify(rows, { header: true });
    res.setHeader("Content-disposition", "attachment; filename=bookings.csv");
    res.set("Content-Type", "text/csv");
    res.send(csv);
  } catch (err) {
    console.error("Bookings export error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
